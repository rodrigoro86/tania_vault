//! Configuração das integrações guardada no banco (`configuracoes`).
//!
//! - `keys`: a lista fixa de chaves editáveis e a validação do valor.
//! - `crypto`: cifra AES-256-GCM dos segredos (`"v1:" + base64(nonce ‖ ct ‖ tag)`).
//! - `repo`: CRUD da tabela `configuracoes`.
//! - `routes`: a API `/api/config` (admin).

use sqlx::PgPool;

use crate::config::Config;

pub mod crypto;
pub mod keys;
pub mod repo;
pub mod routes;

/// Aplica no `Config` do processo o que está gravado no banco — só o que o Rust
/// usa direto (rate limit). Valor do banco vence o env. Falha de parse não
/// derruba o servidor: loga e mantém o valor do env.
pub async fn aplicar_no_config(pool: &PgPool, cfg: &mut Config) -> Result<(), sqlx::Error> {
    for linha in repo::listar(pool).await? {
        match linha.chave.as_str() {
            "RATE_LIMIT_MAX" => match linha.valor.parse::<u32>() {
                Ok(valor) => cfg.rate_limit_max = valor,
                Err(_) => tracing::warn!(
                    "RATE_LIMIT_MAX do banco não é um número: '{}'; mantendo {}",
                    linha.valor,
                    cfg.rate_limit_max
                ),
            },
            "RATE_LIMIT_WINDOW_MS" => match linha.valor.parse::<i64>() {
                Ok(valor) => cfg.rate_limit_window_ms = valor,
                Err(_) => tracing::warn!(
                    "RATE_LIMIT_WINDOW_MS do banco não é um número: '{}'; mantendo {}",
                    linha.valor,
                    cfg.rate_limit_window_ms
                ),
            },
            _ => {}
        }
    }
    Ok(())
}
