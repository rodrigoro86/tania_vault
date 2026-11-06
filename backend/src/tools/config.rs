//! Config por tool (`/api/tools/{id}/config`), design `2026-11-06-tools-design.md`.
//!
//! As chaves válidas vêm do `config` do manifesto: `[{chave, segredo?, descricao?}]`.
//! O valor fica em `tools_config`; secreto é cifrado com `TANIA_CONFIG_KEY` (sem
//! chave, salvar segredo é 503) e nunca sai no GET. Nada aqui toca o segredo da
//! tool — só os valores de config.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::error::ApiError;
use crate::http::AppState;
use crate::tools::{manifesto, registro, Registro};
use crate::users::routes::{admin, db, db_error, json_body, me};
use crate::users::Usuario;

/// Valor (texto puro) máximo de uma chave de config.
const MAX_VALOR: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChaveManifesto {
    pub chave: String,
    pub segredo: bool,
    pub descricao: String,
}

/// Chaves declaradas no manifesto. Item sem `chave` string é ignorado; `segredo`
/// e `descricao` têm padrão (`false` / `""`).
pub fn chaves(manifesto: &Value) -> Vec<ChaveManifesto> {
    let Some(itens) = manifesto.get("config").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    itens
        .iter()
        .filter_map(|item| {
            let chave = item.get("chave").and_then(|v| v.as_str())?;
            Some(ChaveManifesto {
                chave: chave.to_string(),
                segredo: item
                    .get("segredo")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                descricao: item
                    .get("descricao")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Linha {
    chave: String,
    valor: String,
    segredo: bool,
}

/// `(chave, valor, segredo)` gravadas para a tool, ordenadas pela chave.
pub async fn linhas(
    pool: &PgPool,
    tool_id: &str,
) -> Result<Vec<(String, String, bool)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Linha>(
        "select chave, valor, segredo from tools_config where tool_id = $1 order by chave",
    )
    .bind(tool_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|linha| (linha.chave, linha.valor, linha.segredo))
        .collect())
}

fn nao_encontrada() -> ApiError {
    ApiError::Http(StatusCode::NOT_FOUND, "tool não encontrada".to_string())
}

fn indisponível() -> ApiError {
    ApiError::Http(StatusCode::BAD_GATEWAY, "tool indisponível".to_string())
}

fn valor_inválido(chave: &str) -> ApiError {
    ApiError::Http(StatusCode::BAD_REQUEST, format!("valor inválido: {chave}"))
}

fn chave_desconhecida(chave: &str) -> ApiError {
    ApiError::Http(
        StatusCode::BAD_REQUEST,
        format!("chave desconhecida: {chave}"),
    )
}

fn sem_cifra() -> ApiError {
    ApiError::Http(
        StatusCode::SERVICE_UNAVAILABLE,
        "defina TANIA_CONFIG_KEY".to_string(),
    )
}

/// As config gravadas, indexadas pela chave. Sem banco não há config nenhuma.
async fn guardadas(
    state: &AppState,
    tool_id: &str,
) -> Result<HashMap<String, (String, bool)>, ApiError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(HashMap::new());
    };
    Ok(linhas(pool, tool_id)
        .await
        .map_err(db_error)?
        .into_iter()
        .map(|(chave, valor, segredo)| (chave, (valor, segredo)))
        .collect())
}

// --- GET /api/tools/{id}/config ----------------------------------------------

pub(crate) async fn ver_config(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;

    let Some(r) = registro(&state, &id).await else {
        return Err(nao_encontrada());
    };
    let corpo = manifesto(&state.http, &r)
        .await
        .map_err(|_| indisponível())?;

    let declaradas = chaves(&corpo);
    let gravadas = guardadas(&state, &id).await?;

    let chaves_resposta: Vec<Value> = declaradas
        .iter()
        .map(|declarada| {
            // uma chave marcada como secreta no banco está cifrada, mesmo se o
            // manifesto não diz: vale o pior caso, e o valor nunca sai.
            let linha = gravadas.get(&declarada.chave);
            let secreta = declarada.segredo || linha.map(|(_, segredo)| *segredo).unwrap_or(false);

            let mut objeto = Map::new();
            objeto.insert("chave".to_string(), json!(declarada.chave));
            objeto.insert("segredo".to_string(), json!(secreta));
            objeto.insert("descricao".to_string(), json!(declarada.descricao));
            objeto.insert("definido".to_string(), json!(linha.is_some()));
            if !secreta {
                if let Some((valor, _)) = linha {
                    objeto.insert("valor".to_string(), json!(valor));
                }
            }
            Value::Object(objeto)
        })
        .collect();

    tracing::debug!("'{}' leu a config de '{}'", who.username, id);

    Ok(Json(json!({ "ok": true, "chaves": chaves_resposta })))
}

// --- PUT /api/tools/{id}/config ----------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfigBody {
    valores: Map<String, Value>,
}

/// `(chave, valor Some = gravar / None = apagar, segredo)`.
type Gravar = (String, Option<String>, bool);

pub(crate) async fn gravar_config(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
    body: Result<Json<ConfigBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;

    let Some(r) = registro(&state, &id).await else {
        return Err(nao_encontrada());
    };
    let corpo = manifesto(&state.http, &r)
        .await
        .map_err(|_| indisponível())?;
    let declaradas = chaves(&corpo);

    let input = json_body(body)?;

    // valida tudo antes de abrir a transação: ou entra todo, ou nada
    let mut gravar: Vec<Gravar> = Vec::new();
    for (chave, valor) in &input.valores {
        let Some(declarada) = declaradas.iter().find(|c| c.chave == *chave) else {
            return Err(chave_desconhecida(chave));
        };

        match valor {
            Value::Null => gravar.push((chave.clone(), None, declarada.segredo)),
            Value::String(texto) => {
                if texto.is_empty() || texto.len() > MAX_VALOR {
                    return Err(valor_inválido(chave));
                }
                let guardado = if declarada.segredo {
                    let Some(cifra) = state.cifra.as_ref() else {
                        return Err(sem_cifra());
                    };
                    cifra.cifrar(texto)
                } else {
                    texto.clone()
                };
                gravar.push((chave.clone(), Some(guardado), declarada.segredo));
            }
            _ => return Err(valor_inválido(chave)),
        }
    }

    let pool = db(&state)?;
    let mut tx = pool.begin().await.map_err(db_error)?;

    for (chave, valor, segredo) in gravar {
        if let Some(valor) = valor {
            sqlx::query(
                "insert into tools_config (tool_id, chave, valor, segredo, atualizado_por) \
                 values ($1, $2, $3, $4, $5) \
                 on conflict (tool_id, chave) do update set \
                    valor = excluded.valor, \
                    segredo = excluded.segredo, \
                    atualizado_em = now(), \
                    atualizado_por = excluded.atualizado_por",
            )
            .bind(&id)
            .bind(&chave)
            .bind(&valor)
            .bind(segredo)
            .bind(&who.username)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        } else {
            sqlx::query("delete from tools_config where tool_id = $1 and chave = $2")
                .bind(&id)
                .bind(&chave)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
        }
    }

    tx.commit().await.map_err(db_error)?;

    tracing::info!("'{}' gravou a config de '{}'", who.username, id);

    Ok(Json(json!({ "ok": true })))
}

// --- uso interno (Task 3: chamar a tool) -------------------------------------

/// Valores de config prontos para mandar à tool: as chaves do manifesto (se ele
/// falhar, todas as linhas gravadas), já decifradas. Segredo que não decifra é
/// omitido — a tool fica sem aquela chave.
pub async fn valores_da_tool(
    state: &AppState,
    r: &Registro,
) -> Result<Map<String, Value>, ApiError> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Map::new());
    };
    let gravadas: HashMap<String, (String, bool)> = linhas(pool, &r.id)
        .await
        .map_err(db_error)?
        .into_iter()
        .map(|(chave, valor, segredo)| (chave, (valor, segredo)))
        .collect();

    let declaradas: Vec<ChaveManifesto> = match manifesto(&state.http, r).await {
        Ok(corpo) => chaves(&corpo),
        Err(erro) => {
            tracing::warn!(
                "tools: manifesto de {} indisponível na config: {erro}",
                r.id
            );
            gravadas
                .keys()
                .map(|chave| ChaveManifesto {
                    chave: chave.clone(),
                    segredo: gravadas[chave].1,
                    descricao: String::new(),
                })
                .collect()
        }
    };

    let mut valores = Map::new();
    for declarada in declaradas {
        let Some((valor, segredo_db)) = gravadas.get(&declarada.chave) else {
            continue;
        };

        let texto = if declarada.segredo || *segredo_db {
            let Some(cifra) = state.cifra.as_ref() else {
                tracing::warn!(
                    "tools: {} tem segredo em {} sem TANIA_CONFIG_KEY para decifrar",
                    r.id,
                    declarada.chave
                );
                continue;
            };
            match cifra.decifrar(valor) {
                Some(texto) => texto,
                None => {
                    tracing::warn!(
                        "tools: segredo de {} ({}) não decifrado",
                        r.id,
                        declarada.chave
                    );
                    continue;
                }
            }
        } else {
            valor.clone()
        };

        valores.insert(declarada.chave.clone(), json!(texto));
    }

    Ok(valores)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chaves_lê_só_itens_com_chave_string() {
        let corpo = json!({
            "config": [
                {"chave": "CLICKUP_TOKEN", "segredo": true, "descricao": "token"},
                {"chave": "SPACE", "descricao": "space id"},
                {"chave": "SEM_NADA"},
                {"chave": 1},
                {"segredo": true},
                "lixo"
            ]
        });
        assert_eq!(
            chaves(&corpo),
            vec![
                ChaveManifesto {
                    chave: "CLICKUP_TOKEN".to_string(),
                    segredo: true,
                    descricao: "token".to_string(),
                },
                ChaveManifesto {
                    chave: "SPACE".to_string(),
                    segredo: false,
                    descricao: "space id".to_string(),
                },
                ChaveManifesto {
                    chave: "SEM_NADA".to_string(),
                    segredo: false,
                    descricao: String::new(),
                },
            ]
        );
    }

    #[test]
    fn chaves_sem_config_dá_nada() {
        assert!(chaves(&json!({"config": {}})).is_empty());
        assert!(chaves(&json!({})).is_empty());
    }
}
