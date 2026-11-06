//! Rotas do vault: notas, pastas, rename e health.
//! Porte fiel de `handleVaultApi` + `readJson` + `listVault` de
//! `app/server/vault-api.mjs`. Status e mensagem são os mesmos do Node.

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::http::AppState;
use crate::storage::constants::is_note;
use crate::vault::sanitize::{sanitize, Kind};

/// `MAX_JSON` do Node: corpo maior que isso é 413 antes de parsear.
const MAX_JSON: usize = 2_000_000;

/// `readJson(req)`: 413 se passa do limite, `{}` se o corpo está vazio,
/// 400 se não é JSON.
async fn read_json(body: Body) -> Result<Value, ApiError> {
    let raw = match axum::body::to_bytes(body, MAX_JSON).await {
        Ok(raw) => raw,
        Err(_) => {
            return Err(ApiError::Http(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload grande demais".to_string(),
            ));
        }
    };
    if raw.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&raw)
        .map_err(|_| ApiError::Http(StatusCode::BAD_REQUEST, "JSON inválido".to_string()))
}

/// Campo de texto do corpo; anything que não é string vale como ausente
/// (o `sanitize` devolve "path é obrigatório", como no Node).
fn text_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn ok(status: StatusCode, payload: Value) -> impl IntoResponse {
    (status, Json(payload))
}

pub(crate) async fn health(State(state): State<AppState>) -> impl IntoResponse {
    ok(
        StatusCode::OK,
        json!({
            "ok": true,
            "storage": state.store.kind(),
            "writable": true,
            "backend": "rust",
        }),
    )
}

pub(crate) async fn list_notes(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let listing = state.store.list().await?;
    Ok(ok(
        StatusCode::OK,
        json!({
            "notes": listing.notes,
            "folders": listing.folders,
            "files": listing.files,
            "root": state.store.label(),
        }),
    ))
}

/// POST e PUT `/api/notes` compartilham o corpo: só o POST recusa existente.
pub(crate) async fn save_note(
    state: &AppState,
    body: Body,
    allow_create: bool,
) -> Result<impl IntoResponse, ApiError> {
    let body = read_json(body).await?;
    let rel = sanitize(text_field(&body, "path"), Kind::Note)?;

    let exists = state.store.exists(&rel).await?;
    if !allow_create && exists {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{rel} já existe"),
        ));
    }

    let Some(content) = text_field(&body, "content") else {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "content é obrigatório".to_string(),
        ));
    };

    state.store.write_text(&rel, content).await?;
    Ok(ok(
        if exists {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        json!({ "ok": true, "path": rel, "created": !exists }),
    ))
}

pub(crate) async fn create_note(
    State(state): State<AppState>,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    save_note(&state, body, false).await
}

pub(crate) async fn update_note(
    State(state): State<AppState>,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    save_note(&state, body, true).await
}

pub(crate) async fn delete_note(
    State(state): State<AppState>,
    Path(raw): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    // axum já percent-decodifica o wildcard; o sanitize barra o resto
    let rel = sanitize(Some(raw.as_str()), Kind::Note)?;
    if !state.store.exists(&rel).await? {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            format!("{rel} não existe"),
        ));
    }
    state.store.remove(&rel).await?;
    Ok(ok(
        StatusCode::OK,
        json!({ "ok": true, "path": rel, "removed": true }),
    ))
}

pub(crate) async fn create_folder(
    State(state): State<AppState>,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    let body = read_json(body).await?;
    let rel = sanitize(text_field(&body, "path"), Kind::Folder)?;
    if state.store.dir_exists(&rel).await? {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{rel}/ já existe"),
        ));
    }
    state.store.mkdir(&rel).await?;
    Ok(ok(StatusCode::CREATED, json!({ "ok": true, "path": rel })))
}

pub(crate) async fn delete_folder(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    let rel = sanitize(Some(raw.as_str()), Kind::Folder)?;
    if !state.store.dir_exists(&rel).await? {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            format!("{rel}/ não existe"),
        ));
    }

    let recursive = params
        .get("recursive")
        .map(|value| value == "1")
        .unwrap_or(false);
    let empty = state.store.is_empty_dir(&rel).await?;

    if !empty && !recursive {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{rel}/ não está vazia"),
        ));
    }

    // AGENTS.md §3 ("nunca apagar"): o disco local não tem undo, então uma
    // pasta com conteúdo não é apagável nem com ?recursive=1.
    if !empty && state.store.kind() == "local" {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{rel}/ não está vazia: no modo local apagar seria irrecuperável"),
        ));
    }

    state.store.remove_dir(&rel).await?;
    Ok(ok(
        StatusCode::OK,
        json!({ "ok": true, "path": rel, "removed": true }),
    ))
}

pub(crate) async fn rename_path(
    State(state): State<AppState>,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    let body = read_json(body).await?;
    let from_raw = text_field(&body, "from");
    let to_raw = text_field(&body, "to");

    // a natureza da coisa vem do `from`, exatamente como no Node
    let kind = if is_note(from_raw.unwrap_or("")) {
        Kind::Note
    } else {
        Kind::Folder
    };

    let from = sanitize(from_raw, kind)?;
    let to = sanitize(to_raw, kind)?;

    // nota: existe como arquivo; pasta: existe como diretório (como no Node)
    let origin_exists = if kind == Kind::Note {
        state.store.exists(&from).await?
    } else {
        state.store.dir_exists(&from).await?
    };
    if !origin_exists {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            format!("{from} não existe"),
        ));
    }

    let dest_exists = if kind == Kind::Note {
        state.store.exists(&to).await?
    } else {
        state.store.dir_exists(&to).await?
    };
    if dest_exists {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{to} já existe"),
        ));
    }

    state.store.rename(&from, &to).await?;
    Ok(ok(
        StatusCode::OK,
        json!({ "ok": true, "from": from, "to": to }),
    ))
}
