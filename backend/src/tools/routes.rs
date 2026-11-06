//! API das tools registradas (`/api/tools`), design
//! `2026-11-06-tools-design.md`.
//!
//! - `GET`: qualquer usuário logado. Vem as do env e as do banco, ativas e
//!   inativas; para as ativas o manifesto é buscado em paralelo. `url` só é
//!   mostrada para admin; `erro` aparece quando o manifesto falhou. O segredo
//!   nunca sai.
//! - `POST` / `PUT` / `DELETE`: só admin. Tool do env não se edita nem se
//!   apaga (409). Gravar segredo sem `TANIA_CONFIG_KEY` é 503.

use std::collections::HashMap;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{any, get, put};
use axum::{Json, Router};
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::json;

use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::tools::config::{gravar_config, valores_da_tool, ver_config};
use crate::tools::proxy::tool_proxy;
use crate::tools::{manifesto, registro, registros, valid_id, valid_url, Registro, ToolAuth};
use crate::users::routes::{admin, db, db_error, json_body, me};
use crate::users::Usuario;

const MAX_SEGREDO: usize = 200;

fn id_inválido() -> ApiError {
    ApiError::Http(
        StatusCode::BAD_REQUEST,
        "id inválido (use a-z, 0-9 e -, até 32)".to_string(),
    )
}

fn url_inválida() -> ApiError {
    ApiError::Http(StatusCode::BAD_REQUEST, "url inválida".to_string())
}

fn segredo_inválido() -> ApiError {
    ApiError::Http(StatusCode::BAD_REQUEST, "segredo inválido".to_string())
}

fn sem_cifra() -> ApiError {
    ApiError::Http(
        StatusCode::SERVICE_UNAVAILABLE,
        "defina TANIA_CONFIG_KEY para cadastrar tools".to_string(),
    )
}

fn ferramenta_existente() -> ApiError {
    ApiError::Http(StatusCode::CONFLICT, "tool já existe".to_string())
}

fn ferramenta_do_env() -> ApiError {
    ApiError::Http(
        StatusCode::CONFLICT,
        "tool do env não é editável".to_string(),
    )
}

fn nao_encontrada() -> ApiError {
    ApiError::Http(StatusCode::NOT_FOUND, "tool não encontrada".to_string())
}

/// O id está fixo no `TANIA_TOOLS`: não se toca nele pelo banco.
fn no_env(state: &AppState, id: &str) -> bool {
    state.cfg.tools.iter().any(|t| t.id == id)
}

/// `{id, origem, ativo, manifest?, url? (admin), erro?}`. Nunca o segredo.
fn item(
    r: &Registro,
    manifestos: &HashMap<String, Result<serde_json::Value, String>>,
    quem_es_admin: bool,
) -> serde_json::Value {
    let mut item = serde_json::Map::new();
    item.insert("id".to_string(), json!(r.id));
    item.insert("origem".to_string(), json!(r.origem));
    item.insert("ativo".to_string(), json!(r.ativo));

    if let Some(manifest) = manifestos.get(&r.id) {
        match manifest {
            Ok(corpo) => {
                item.insert("manifest".to_string(), corpo.clone());
            }
            Err(erro) => {
                item.insert("manifest".to_string(), serde_json::Value::Null);
                item.insert("erro".to_string(), json!(erro));
            }
        }
    }

    if quem_es_admin {
        item.insert("url".to_string(), json!(r.url));
    }
    serde_json::Value::Object(item)
}

// --- GET /api/tools -----------------------------------------------------------

async fn listar_tools(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    let who = me(user)?;
    let listados = registros(&state).await;

    // só as ativas têm manifesto, e todos são buscados em paralelo
    let ativos: Vec<Registro> = listados.iter().filter(|r| r.ativo).cloned().collect();
    let respostas = join_all(ativos.iter().map(|r| manifesto(&state.http, r))).await;

    let manifestos: HashMap<String, Result<serde_json::Value, String>> = ativos
        .into_iter()
        .zip(respostas)
        .map(|(r, manifest)| (r.id, manifest))
        .collect();

    let itens: Vec<serde_json::Value> = listados
        .iter()
        .map(|r| item(r, &manifestos, who.admin))
        .collect();

    Ok(Json(json!({ "ok": true, "tools": itens })))
}

// --- POST /api/tools ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CriarBody {
    id: String,
    url: String,
    segredo: String,
}

async fn criar_tool(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<CriarBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;
    let input = json_body(body)?;

    if !valid_id(&input.id) {
        return Err(id_inválido());
    }
    if !valid_url(&input.url) {
        return Err(url_inválida());
    }
    if input.segredo.is_empty() || input.segredo.len() > MAX_SEGREDO {
        return Err(segredo_inválido());
    }

    if no_env(&state, &input.id)
        || crate::tools::repo::existe(&pool, &input.id)
            .await
            .map_err(db_error)?
    {
        return Err(ferramenta_existente());
    }

    let Some(cifra) = state.cifra.as_ref() else {
        return Err(sem_cifra());
    };

    crate::tools::repo::inserir(
        &pool,
        &input.id,
        &input.url,
        &cifra.cifrar(&input.segredo),
        &who.username,
    )
    .await
    .map_err(db_error)?;

    tracing::info!("'{}' cadastrou a tool '{}'", who.username, input.id);

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

// --- PUT /api/tools/{id} ------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditarBody {
    url: Option<String>,
    segredo: Option<String>,
    ativo: Option<bool>,
}

async fn editar_tool(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
    body: Result<Json<EditarBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    if !valid_id(&id) {
        return Err(nao_encontrada());
    }
    if no_env(&state, &id) {
        return Err(ferramenta_do_env());
    }

    let input = json_body(body)?;

    if let Some(url) = &input.url {
        if !valid_url(url) {
            return Err(url_inválida());
        }
    }
    if let Some(segredo) = &input.segredo {
        if segredo.is_empty() || segredo.len() > MAX_SEGREDO {
            return Err(segredo_inválido());
        }
    }

    let segredo_cifrado = match &input.segredo {
        Some(segredo) => {
            let Some(cifra) = state.cifra.as_ref() else {
                return Err(sem_cifra());
            };
            Some(cifra.cifrar(segredo))
        }
        None => None,
    };

    let gravada = crate::tools::repo::atualizar(
        &pool,
        &id,
        input.url.as_deref(),
        segredo_cifrado.as_deref(),
        input.ativo,
        &who.username,
    )
    .await
    .map_err(db_error)?;

    if !gravada {
        return Err(nao_encontrada());
    }

    tracing::info!("'{}' editou a tool '{}'", who.username, id);

    Ok(Json(json!({ "ok": true })))
}

// --- DELETE /api/tools/{id} ---------------------------------------------------

async fn apagar_tool(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    if no_env(&state, &id) {
        return Err(ferramenta_do_env());
    }

    if !crate::tools::repo::apagar(&pool, &id)
        .await
        .map_err(db_error)?
    {
        return Err(nao_encontrada());
    }

    tracing::info!("'{}' apagou a tool '{}'", who.username, id);

    Ok(Json(json!({ "ok": true })))
}

// --- GET /api/core/config -----------------------------------------------------

/// Os valores de config prontos para a tool, já decifrados. O portão já validou
/// o `Tool <id>:<segredo>`; se a tool desapareceu entre os dois, 401.
async fn core_config(
    State(state): State<AppState>,
    Extension(auth): Extension<ToolAuth>,
) -> Result<impl IntoResponse, ApiError> {
    let Some(r) = registro(&state, &auth.id).await else {
        return Err(ApiError::Http(
            StatusCode::UNAUTHORIZED,
            "tool não autorizada".to_string(),
        ));
    };

    let valores = valores_da_tool(&state, &r).await?;

    Ok(Json(json!({ "ok": true, "valores": valores })))
}

/// Rotas das tools. Métodos não registrados no caminho caem no proxy.
async fn core_desconhecida() -> ApiError {
    ApiError::Http(
        StatusCode::NOT_FOUND,
        "rota do núcleo desconhecida".to_string(),
    )
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tools",
            get(listar_tools).post(criar_tool).fallback(proxy),
        )
        .route(
            "/api/tools/{id}",
            put(editar_tool).delete(apagar_tool).fallback(proxy),
        )
        .route(
            "/api/tools/{id}/config",
            get(ver_config).put(gravar_config).fallback(proxy),
        )
        // o núcleo falado pelo portão do segredo: `/api/core/*`
        .route("/api/core/config", get(core_config))
        // outros caminhos do núcleo ainda não existem (subprojeto 2): 404, nunca o Node
        .route("/api/core/{*rest}", any(core_desconhecida))
        // as páginas (`/tools/{id}/ui/...`) e a API (`/tools/{id}/api/...`) de
        // cada tool: qualquer método, repassado em streaming pelo proxy próprio
        .route("/tools/{id}/{*rest}", any(tool_proxy))
}
