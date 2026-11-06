//! Registro das tools: as fixas do env (`TANIA_TOOLS`) + as cadastradas na tabela
//! `tools` (migração `103_tools.sql`), e a leitura do manifesto de cada uma.
//!
//! Rotas, proxy e config por tool vêm depois (Task 2/3); aqui só tipos, parsing
//! e consulta — nada de HTTP exposto.

pub mod repo;
pub mod routes;

use std::time::Duration;

use serde::Serialize;
use sqlx::PgPool;

use crate::http::AppState;

/// `^[a-z0-9-]{1,32}$`, conferido char a char (sem regex).
pub fn valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 32 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `http://` ou `https://`, até 300 chars, sem espaço.
pub fn valid_url(url: &str) -> bool {
    url.len() <= 300
        && (url.starts_with("http://") || url.starts_with("https://"))
        && !url.chars().any(char::is_whitespace)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEnv {
    pub id: String,
    pub url: String,
    pub segredo: String,
}

/// Chave do segredo de uma tool: `TANIA_TOOL_SECRET_<ID>` (maiúsculas, `-` → `_`).
fn secret_key(id: &str) -> String {
    format!("TANIA_TOOL_SECRET_{}", id.to_uppercase().replace('-', "_"))
}

/// `TANIA_TOOLS="id=url,id2=url2"` → lista de tools do env. Item malformado, com
/// id/URL inválidos, repetido ou sem segredo é pulado com `tracing::warn!`.
pub fn parse_tools_env(raw: &str, segredo: impl Fn(&str) -> Option<String>) -> Vec<ToolEnv> {
    let mut out: Vec<ToolEnv> = Vec::new();

    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let (id, url) = match item.split_once('=') {
            Some(par) => (par.0.trim(), par.1.trim()),
            None => {
                tracing::warn!("tools: item sem '=' ignorado: {item}");
                continue;
            }
        };

        if !valid_id(id) {
            tracing::warn!("tools: id inválido ignorado: {id}");
            continue;
        }
        if !valid_url(url) {
            tracing::warn!("tools: url inválida ignorada: {id} -> {url}");
            continue;
        }
        if out.iter().any(|t| t.id == id) {
            tracing::warn!("tools: id repetido ignorado: {id}");
            continue;
        }

        let Some(secret) = segredo(&secret_key(id)) else {
            tracing::warn!("tools: {id} sem segredo em {}", secret_key(id));
            continue;
        };
        if secret.is_empty() {
            tracing::warn!("tools: {id} com segredo vazio, ignorada");
            continue;
        }

        out.push(ToolEnv {
            id: id.to_string(),
            url: url.to_string(),
            segredo: secret,
        });
    }

    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origem {
    Env,
    Banco,
}

#[derive(Debug, Clone)]
pub struct Registro {
    pub id: String,
    pub url: String,
    pub segredo: String,
    pub origem: Origem,
    pub ativo: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Linha {
    pub id: String,
    pub url: String,
    pub segredo: String,
    pub ativo: bool,
}

/// Env primeiro, banco depois; uma tool do banco com id já presente no env é
/// pulada. Segredo que não decifra (sem `TANIA_CONFIG_KEY` ou valor adulterado)
/// pula a tool; erro da consulta deixa só o env.
pub async fn registros(state: &AppState) -> Vec<Registro> {
    let mut out: Vec<Registro> = state
        .cfg
        .tools
        .iter()
        .map(|t| Registro {
            id: t.id.clone(),
            url: t.url.clone(),
            segredo: t.segredo.clone(),
            origem: Origem::Env,
            ativo: true,
        })
        .collect();

    let Some(db) = state.db.as_ref() else {
        return out;
    };

    match listar_banco(db).await {
        Ok(linhas) => {
            for linha in linhas {
                if out.iter().any(|r| r.id == linha.id) {
                    continue;
                }
                let Some(cifra) = state.cifra.as_ref() else {
                    tracing::warn!(
                        "tools: {} no banco sem TANIA_CONFIG_KEY para decifrar o segredo",
                        linha.id
                    );
                    continue;
                };
                let Some(segredo) = cifra.decifrar(&linha.segredo) else {
                    tracing::warn!("tools: segredo de {} não decifrado", linha.id);
                    continue;
                };
                out.push(Registro {
                    id: linha.id,
                    url: linha.url,
                    segredo,
                    origem: Origem::Banco,
                    ativo: linha.ativo,
                });
            }
        }
        Err(err) => tracing::warn!("tools: leitura do banco falhou: {err}"),
    }

    out
}

async fn listar_banco(db: &PgPool) -> Result<Vec<Linha>, sqlx::Error> {
    sqlx::query_as::<_, Linha>("select id, url, segredo, ativo from tools order by id")
        .fetch_all(db)
        .await
}

/// A tool registrada e ativa com esse id.
pub async fn registro(state: &AppState, id: &str) -> Option<Registro> {
    registros(state)
        .await
        .into_iter()
        .find(|r| r.id == id && r.ativo)
}

/// `GET {url}/manifest.json` com o segredo da tool, 3 s de timeout. Erro =
/// mensagem curta para o campo `erro` da API.
pub async fn manifesto(http: &reqwest::Client, r: &Registro) -> Result<serde_json::Value, String> {
    let url = format!("{}/manifest.json", r.url.trim_end_matches('/'));

    let resp = http
        .get(&url)
        .header("x-tania-tool-secret", &r.segredo)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| "indisponível".to_string())?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    // reqwest está sem a feature `json` aqui, então parseia o texto à mão.
    let texto = resp.text().await.map_err(|_| "indisponível".to_string())?;
    let corpo: serde_json::Value =
        serde_json::from_str(&texto).map_err(|_| "manifesto inválido".to_string())?;

    let id = corpo.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id != r.id {
        return Err("id do manifesto diferente".to_string());
    }

    let nome = corpo.get("nome").and_then(|v| v.as_str());
    let icone = corpo.get("icone").and_then(|v| v.as_str());
    if nome.is_none_or(|v| v.trim().is_empty()) || icone.is_none_or(|v| v.trim().is_empty()) {
        return Err("manifesto inválido".to_string());
    }

    let Some(paginas) = corpo.get("paginas").and_then(|v| v.as_array()) else {
        return Err("manifesto inválido".to_string());
    };
    for pagina in paginas {
        let Some(pagina_id) = pagina.get("id").and_then(|v| v.as_str()) else {
            return Err("manifesto inválido".to_string());
        };
        if !valid_id(pagina_id) || pagina.get("titulo").and_then(|v| v.as_str()).is_none() {
            return Err("manifesto inválido".to_string());
        }
    }

    Ok(corpo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_id_aceita_apenas_o_padrao() {
        assert!(valid_id("a"));
        assert!(valid_id("clickup"));
        assert!(valid_id("ext-3f2a1b9c"));
        assert!(valid_id(&"a".repeat(32)));
        assert!(!valid_id(""));
        assert!(!valid_id(&"a".repeat(33)));
        assert!(!valid_id("Clickup"));
        assert!(!valid_id("a_b"));
        assert!(!valid_id("a b"));
        assert!(!valid_id("café"));
    }

    #[test]
    fn valid_url_exige_http_e_sem_espaço() {
        assert!(valid_url("http://x:1"));
        assert!(valid_url("https://tool.internal/ui"));
        assert!(!valid_url("ftp://y"));
        assert!(!valid_url("//y"));
        assert!(!valid_url("http://a b"));
        assert!(!valid_url(&format!("http://{}", "a".repeat(300))));
        assert!(valid_url(&format!("http://{}", "a".repeat(293))));
    }

    #[test]
    fn parse_tools_env_só_deixa_o_item_valido_com_segredo() {
        let f = |chave: &str| -> Option<String> {
            match chave {
                "TANIA_TOOL_SECRET_A" => Some("sa".to_string()),
                "TANIA_TOOL_SECRET_B" => Some("sb".to_string()),
                "TANIA_TOOL_SECRET_C" => Some("sc".to_string()),
                _ => None,
            }
        };

        let got = parse_tools_env(
            "a=http://x:1, b=ftp://y, C=http://z, d=http://w, a=http://dup",
            f,
        );
        assert_eq!(
            got,
            vec![ToolEnv {
                id: "a".to_string(),
                url: "http://x:1".to_string(),
                segredo: "sa".to_string(),
            }]
        );
    }
}
