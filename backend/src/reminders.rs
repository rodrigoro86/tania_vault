//! Lembretes (`/api/reminders`) atendidos direto no Postgres (F3a).
//!
//! O CRUD é todo do Rust e o JSON nasce no próprio banco: a query devolve texto
//! (`json_agg`/`json_build_object`) e o handler só faz `serde_json::from_str`,
//! então não existem structs de linha. `id` sai número e `quando`/`created_at`
//! saem ISO UTC com milissegundos, igual ao `JSON.stringify` do Node.
//!
//! Quem envia os lembretes vencidos no WhatsApp (o scheduler de
//! `app/server/reminders.mjs`) continua no Node até a F4.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::users::routes::{db, db_error, json_body, me};
use crate::users::Usuario;

/// Projeção de uma linha de `lembretes` como objeto JSON, montada pelo Postgres.
/// `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` dá o mesmo formato que
/// `Date.toISOString()` do Node.
const LINHA: &str = r#"json_build_object(
  'id', id,
  'texto', texto,
  'quando', to_char(quando at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'recorrencia', recorrencia,
  'canal', canal,
  'status', status,
  'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)"#;

/// Mensagem de erro do `quando`, idêntica à do Node.
const QUANDO_MSG: &str = "quando inválido (use ISO, ex.: 2026-11-01T09:00:00-03:00)";

/// O texto JSON que o Postgres devolve vira `serde_json::Value`; falha de parse
/// é tratada como erro de banco (500), nunca vazam detalhes.
fn linha_de(texto: &str) -> Result<serde_json::Value, ApiError> {
    serde_json::from_str(texto).map_err(|err| {
        tracing::error!("json do banco mal formado: {err}");
        ApiError::Http(
            StatusCode::INTERNAL_SERVER_ERROR,
            "erro no banco".to_string(),
        )
    })
}

// --- GET /api/reminders?status= ----------------------------------------------

async fn listar(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // `status` vazio é tratado como ausente, como no Node (`status ? ... : ...`)
    let status = params.get("status").filter(|s| !s.is_empty());

    let texto = if let Some(status) = status {
        sqlx::query_scalar::<_, String>(&format!(
            "select coalesce(json_agg({LINHA} order by quando), '[]')::text \
                 from lembretes where status = $1"
        ))
        .bind(status)
        .fetch_one(&pool)
        .await
    } else {
        sqlx::query_scalar::<_, String>(&format!(
            "select coalesce(json_agg({LINHA} order by status, quando), '[]')::text \
                 from lembretes"
        ))
        .fetch_one(&pool)
        .await
    }
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "lembretes": linha_de(&texto)? })))
}

// --- POST /api/reminders -------------------------------------------------------

async fn criar(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = me(user)?;
    let pool = db(&state)?;
    let corpo = json_body(body)?;

    let texto = corpo
        .get("texto")
        .and_then(|valor| valor.as_str())
        .map(|valor| valor.trim())
        .unwrap_or_default();
    if texto.is_empty() {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "texto é obrigatório".to_string(),
        ));
    }

    let quando = match corpo.get("quando").and_then(|valor| valor.as_str()) {
        Some(valor) => chrono::DateTime::parse_from_rfc3339(valor)
            .map_err(|_| ApiError::Http(StatusCode::BAD_REQUEST, QUANDO_MSG.to_string()))?,
        None => {
            return Err(ApiError::Http(
                StatusCode::BAD_REQUEST,
                QUANDO_MSG.to_string(),
            ));
        }
    }
    .with_timezone(&chrono::Utc);

    // corte por caracteres, não por bytes: acentos não podem quebrar o campo
    let recorrencia = corpo
        .get("recorrencia")
        .and_then(|valor| valor.as_str())
        .filter(|valor| !valor.is_empty())
        .map(|valor| valor.chars().take(40).collect::<String>());

    let canal = match corpo.get("canal").and_then(|valor| valor.as_str()) {
        Some(valor) if !valor.is_empty() => valor.chars().take(20).collect::<String>(),
        _ => "whatsapp".to_string(),
    };

    let texto = sqlx::query_scalar::<_, String>(
        &format!("insert into lembretes (texto, quando, recorrencia, canal) values ($1, $2, $3, $4) returning {LINHA}::text"),
    )
    .bind(texto)
    .bind(quando)
    .bind(recorrencia)
    .bind(canal)
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    let lembrete = linha_de(&texto)?;
    tracing::info!(
        "'{}' criou lembrete {}",
        who.username,
        lembrete["id"].as_i64().unwrap_or_default()
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "lembrete": lembrete })),
    ))
}

// --- POST /api/reminders/{id}/cancel -----------------------------------------

async fn cancelar(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "update lembretes set status = 'cancelled' where id = $1 returning {LINHA}::text"
    ))
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(db_error)?;

    let Some(texto) = texto else {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            "lembrete não encontrado".to_string(),
        ));
    };

    Ok(Json(json!({ "ok": true, "lembrete": linha_de(&texto)? })))
}

/// Rotas de lembretes. Métodos não registrados caem no proxy (Node).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/reminders", get(listar).post(criar).fallback(proxy))
        .route("/api/reminders/{id}/cancel", post(cancelar).fallback(proxy))
}
