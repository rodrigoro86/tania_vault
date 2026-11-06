//! Provedores do agente LLM guardados no banco (`agentes_config`, design
//! `2026-11-06-ribbon-e-agents-design.md`).
//!
//! - `AgentConfig`: o documento `{active, providers}`; `validar` é a única
//!   fonte das regras (o front, a API e os testes usam `validar`, nunca uma
//!   cópia);
//! - `modelo_inicial`: o que a tela mostra quando ainda não há linha no banco;
//! - `carregar` / `salvar`: leitura e escrita da única linha (`id = 1`) de
//!   `agentes_config`.
//!
//! Sem macros de compile-time (`query!`): `sqlx::query` com `.bind`, como em
//! `settings/repo.rs`, para compilar e testar sem `DATABASE_URL`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

pub mod routes;
pub use routes::routes;

/// Um provedor do agente: URL base, modelo e, opcionalmente, limite de tokens
/// e a env var (do servidor) que fornece a chave.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Provedor {
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
}

/// O documento completo dos provedores: quem está ativo e a lista de provedores.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub active: String,
    pub providers: BTreeMap<String, Provedor>,
}

/// Únicas env vars de chave que um provedor pode usar. `apiKey` inline não
/// existe: a chave nunca sai do servidor, só o nome da env var.
pub const CHAVES_LLM: &[&str] = &[
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
];

const NOMES: usize = 20;
const NOME_MAX: usize = 32;
const URL_MAX: usize = 300;
const MODEL_MAX: usize = 200;
const TOKENS_MAX: u32 = 1_000_000;

/// O modelo inicial: os mesmos provedores de `app/agent.config.example.json`,
/// com `active: "deepseek"`. Usado quando não há linha no banco.
pub fn modelo_inicial() -> AgentConfig {
    let mut providers = BTreeMap::new();
    providers.insert(
        "deepseek".to_string(),
        Provedor {
            base_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-chat".to_string(),
            max_tokens: Some(8192),
            api_key_env: Some("DEEPSEEK_API_KEY".to_string()),
        },
    );
    providers.insert(
        "openai".to_string(),
        Provedor {
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-4.1-mini".to_string(),
            max_tokens: None,
            api_key_env: Some("OPENAI_API_KEY".to_string()),
        },
    );
    providers.insert(
        "gemini".to_string(),
        Provedor {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            model: "gemini-2.5-flash".to_string(),
            max_tokens: None,
            api_key_env: Some("GEMINI_API_KEY".to_string()),
        },
    );
    providers.insert(
        "openrouter".to_string(),
        Provedor {
            base_url: "https://openrouter.ai/api/v1".to_string(),
            model: "openai/gpt-4.1-mini".to_string(),
            max_tokens: None,
            api_key_env: Some("OPENROUTER_API_KEY".to_string()),
        },
    );
    providers.insert(
        "groq".to_string(),
        Provedor {
            base_url: "https://api.groq.com/openai/v1".to_string(),
            model: "llama-3.3-70b-versatile".to_string(),
            max_tokens: None,
            api_key_env: Some("GROQ_API_KEY".to_string()),
        },
    );
    // ollama não tem chave: roda local
    providers.insert(
        "ollama".to_string(),
        Provedor {
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            model: "qwen2.5:14b".to_string(),
            max_tokens: None,
            api_key_env: None,
        },
    );

    AgentConfig {
        active: "deepseek".to_string(),
        providers,
    }
}

/// Regras da tela, na ordem: quantidade, nome, URL, modelo, tokens, chave e,
/// por fim, o provedor ativo. Devolve a mensagem do primeiro erro.
pub fn validar(c: &AgentConfig) -> Result<(), String> {
    if c.providers.is_empty() || c.providers.len() > NOMES {
        return Err("cadastre de 1 a 20 provedores".to_string());
    }

    for (nome, provedor) in &c.providers {
        let nome_ok = !nome.is_empty()
            && nome.chars().count() <= NOME_MAX
            && nome
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
        if !nome_ok {
            return Err(format!("nome inválido: {nome} (use a-z, 0-9, - e _)"));
        }

        if !provedor.base_url.starts_with("http://") && !provedor.base_url.starts_with("https://") {
            return Err(format!(
                "{nome}: baseUrl deve começar com http:// ou https://"
            ));
        }
        if provedor.base_url.chars().count() > URL_MAX {
            return Err(format!("{nome}: baseUrl deve ter até {URL_MAX} caracteres"));
        }

        let model_len = provedor.model.chars().count();
        if model_len == 0 || model_len > MODEL_MAX {
            return Err(format!(
                "{nome}: model deve ter de 1 a {MODEL_MAX} caracteres"
            ));
        }
        if provedor.model.contains('\n') || provedor.model.contains('\r') {
            return Err(format!("{nome}: model não pode ter quebra de linha"));
        }

        if let Some(max_tokens) = provedor.max_tokens {
            if max_tokens == 0 || max_tokens > TOKENS_MAX {
                return Err(format!("{nome}: maxTokens deve ser de 1 a {TOKENS_MAX}"));
            }
        }

        if let Some(chave) = &provedor.api_key_env {
            if !CHAVES_LLM.contains(&chave.as_str()) {
                return Err(format!("{nome}: chave {chave} não permitida"));
            }
        }
    }

    if !c.providers.contains_key(&c.active) {
        return Err(format!("provedor ativo {} não existe", c.active));
    }

    Ok(())
}

// --- repositório de `agentes_config` (migração `102_agentes_config.sql`) -----

/// A config gravada; `None` quando não há linha ou quando o JSON da linha não
/// é um `AgentConfig` válido (loga e segue como se não houvesse linha).
pub async fn carregar(pool: &PgPool) -> Result<Option<AgentConfig>, sqlx::Error> {
    let linha = sqlx::query_scalar::<_, sqlx::types::Json<serde_json::Value>>(
        "select config from agentes_config where id = 1",
    )
    .fetch_optional(pool)
    .await?;

    let Some(sqlx::types::Json(valor)) = linha else {
        return Ok(None);
    };

    match serde_json::from_value::<AgentConfig>(valor) {
        Ok(config) => Ok(Some(config)),
        Err(err) => {
            tracing::warn!("config de agentes no banco não é válida: {err}");
            Ok(None)
        }
    }
}

/// Upsert da única linha (`id = 1`).
pub async fn salvar(pool: &PgPool, c: &AgentConfig, por: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into agentes_config (id, config, atualizado_por) \
         values (1, $1, $2) \
         on conflict (id) do update set \
             config = excluded.config, \
             atualizado_em = now(), \
             atualizado_por = excluded.atualizado_por",
    )
    .bind(sqlx::types::Json(c))
    .bind(por)
    .execute(pool)
    .await?;
    Ok(())
}
