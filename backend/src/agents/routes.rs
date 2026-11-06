//! API dos provedores do agente (`/api/agents`), só para admin.
//!
//! - `GET`: `{ok, origem, config, chaves}`. Sem linha no banco, `origem` é
//!   `"nenhum"` e `config` é `modelo_inicial()`;
//! - `PUT`: corpo `{config}`; qualquer rejeição do JSON (corpo mal formado ou
//!   campo desconhecido, como `apiKey` inline) é 400, e `validar` Err também.
//!
//! O documento inteiro é gravado por upsert na linha `id = 1`, com quem salvou.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::agents::{carregar, modelo_inicial, salvar, validar, AgentConfig, CHAVES_LLM};
use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::users::routes::{admin, db, db_error, json_body, me};
use crate::users::Usuario;

/// Corpo do `PUT`: só o documento, nada mais (daí `deny_unknown_fields`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigBody {
    config: AgentConfig,
}

// --- GET /api/agents -----------------------------------------------------------

async fn listar_agents(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    admin(&me(user)?)?;
    let pool = db(&state)?;

    let gravada = carregar(&pool).await.map_err(db_error)?;
    let (origem, config) = match gravada {
        Some(config) => ("banco", config),
        None => ("nenhum", modelo_inicial()),
    };

    Ok(Json(json!({
        "ok": true,
        "origem": origem,
        "config": config,
        "chaves": CHAVES_LLM,
    })))
}

// --- PUT /api/agents -----------------------------------------------------------

async fn gravar_agents(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<ConfigBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    let input = json_body(body)?;
    if let Err(mensagem) = validar(&input.config) {
        return Err(ApiError::Http(StatusCode::BAD_REQUEST, mensagem));
    }

    salvar(&pool, &input.config, &who.username)
        .await
        .map_err(db_error)?;

    tracing::info!("'{}' gravou a config de agentes", who.username);

    Ok(Json(json!({
        "ok": true,
        "origem": "banco",
        "config": input.config,
    })))
}

/// Rotas dos provedores. Métodos não registrados no caminho caem no proxy.
pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/agents",
        get(listar_agents).put(gravar_agents).fallback(proxy),
    )
}
