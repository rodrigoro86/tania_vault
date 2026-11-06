//! Rotas de tokens de integração e das chaves gerais (`/api/tokens`,
//! `/api/integracoes`). Erros em `{ok:false,error}`, como no resto da API.
//!
//! - `GET /api/tokens`: admin vê todos; usuário, só os seus. Sem o token nem o hash.
//! - `POST /api/tokens`: cria e devolve o token em claro **uma única vez**.
//! - `PATCH` / `DELETE /api/tokens/{id}`: dono ou admin; outro usuário, 403.
//! - `GET` / `PUT /api/integracoes`: só admin. Liga/desliga MCP e Hook para todos.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::body::Bytes;
use axum::routing::{get, patch, post};
use axum::response::{IntoResponse, Response};

use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::settings;
use crate::tokens::auth::IntegracaoAuth;
use crate::tokens::{self, agenda, mcp, repo, repo::Linha, repo::Mudanca};
use crate::users::routes::{admin, db, db_error, json_body, me};
use crate::users::Usuario;

/// Chaves gerais em `configuracoes`: `"true"` liga o canal.
pub const CHAVE_MCP: &str = "INTEGRACAO_MCP";
pub const CHAVE_HOOK: &str = "INTEGRACAO_HOOK";

fn bad(msg: &str) -> ApiError {
    ApiError::Http(StatusCode::BAD_REQUEST, msg.to_string())
}

fn nao_encontrado() -> ApiError {
    ApiError::Http(StatusCode::NOT_FOUND, "token não encontrado".to_string())
}

fn sem_permissao() -> ApiError {
    ApiError::Http(
        StatusCode::FORBIDDEN,
        "só o dono do token ou admin".to_string(),
    )
}

fn sem_canal() -> ApiError {
    bad("marque ao menos MCP ou Hook")
}

/// Id da URL: inválido ou inexistente vira 404 (mesma mensagem).
fn parse_id(id: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(id).map_err(|_| nao_encontrado())
}

fn to_json(l: &Linha) -> Value {
    json!({
        "id": l.id,
        "usuario": l.usuario,
        "usuarioId": l.usuario_id,
        "nome": l.nome,
        "mcp": l.mcp,
        "hook": l.hook,
        "ativo": l.ativo,
        "criadoEm": l.criado_em,
        "ultimoUso": l.ultimo_uso,
    })
}

/// Linha do token se o usuário pode mexer nela (dono ou admin); 404 ou 403 caso contrário.
async fn linha_com_permissao(pool: &PgPool, usuario: &Usuario, id: Uuid) -> Result<Linha, ApiError> {
    let linha = repo::buscar(pool, id)
        .await
        .map_err(db_error)?
        .ok_or_else(nao_encontrado)?;
    if tokens::pode_mexer(usuario, linha.usuario_id) {
        Ok(linha)
    } else {
        Err(sem_permissao())
    }
}

// --- /api/tokens -------------------------------------------------------------

async fn listar_tokens(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    let usuario = me(user)?;
    let filtro = if usuario.admin { None } else { Some(usuario.id) };
    let linhas = repo::listar(&pool, filtro).await.map_err(db_error)?;
    let itens: Vec<Value> = linhas.iter().map(to_json).collect();
    Ok(Json(json!({ "ok": true, "tokens": itens })))
}

#[derive(Debug, Deserialize)]
struct NovoToken {
    nome: String,
    #[serde(default)]
    mcp: bool,
    #[serde(default)]
    hook: bool,
}

async fn criar_token(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<NovoToken>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    let usuario = me(user)?;
    let corpo = json_body(body)?;
    let nome = tokens::nome_valido(&corpo.nome).ok_or_else(|| {
        bad("nome deve ter de 1 a 60 caracteres")
    })?;
    if !corpo.mcp && !corpo.hook {
        return Err(sem_canal());
    }

    let token = tokens::novo_token();
    let id = repo::criar(
        &pool,
        usuario.id,
        &nome,
        corpo.mcp,
        corpo.hook,
        &tokens::hash(&token),
    )
    .await
    .map_err(db_error)?;
    let linha = repo::buscar(&pool, id)
        .await
        .map_err(db_error)?
        .ok_or_else(nao_encontrado)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "token": token, "item": to_json(&linha) })),
    ))
}

#[derive(Debug, Deserialize)]
struct EditarToken {
    nome: Option<String>,
    mcp: Option<bool>,
    hook: Option<bool>,
    ativo: Option<bool>,
}

async fn editar_token(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
    body: Result<Json<EditarToken>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    let usuario = me(user)?;
    let corpo = json_body(body)?;
    let id = parse_id(&id)?;
    let atual = linha_com_permissao(&pool, &usuario, id).await?;

    // o token resultante precisa continuar com algum canal
    let mcp = corpo.mcp.unwrap_or(atual.mcp);
    let hook = corpo.hook.unwrap_or(atual.hook);
    if !mcp && !hook {
        return Err(sem_canal());
    }
    let nome = match corpo.nome {
        Some(n) => Some(tokens::nome_valido(&n).ok_or_else(|| {
            bad("nome deve ter de 1 a 60 caracteres")
        })?),
        None => None,
    };

    let mudanca = Mudanca {
        nome,
        mcp: corpo.mcp,
        hook: corpo.hook,
        ativo: corpo.ativo,
    };
    repo::atualizar(&pool, id, &mudanca).await.map_err(db_error)?;
    let linha = repo::buscar(&pool, id)
        .await
        .map_err(db_error)?
        .ok_or_else(nao_encontrado)?;
    Ok(Json(json!({ "ok": true, "item": to_json(&linha) })))
}

async fn apagar_token(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    let usuario = me(user)?;
    let id = parse_id(&id)?;
    linha_com_permissao(&pool, &usuario, id).await?;
    repo::apagar(&pool, id).await.map_err(db_error)?;
    Ok(Json(json!({ "ok": true, "removed": true })))
}

// --- /api/integracoes --------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Integracoes {
    mcp: Option<bool>,
    hook: Option<bool>,
}

/// `(mcp, hook)` lidos de `configuracoes`; ausente = desligado.
async fn ler_integracoes(pool: &PgPool) -> Result<(bool, bool), ApiError> {
    let linhas = settings::repo::listar(pool).await.map_err(db_error)?;
    let ligado = |chave: &str| linhas.iter().any(|l| l.chave == chave && l.valor == "true");
    Ok((ligado(CHAVE_MCP), ligado(CHAVE_HOOK)))
}

fn integracoes_json(mcp: bool, hook: bool) -> Value {
    json!({ "ok": true, "mcp": mcp, "hook": hook })
}

async fn ver_integracoes(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    admin(&me(user)?)?;
    let (mcp, hook) = ler_integracoes(&pool).await?;
    Ok(Json(integracoes_json(mcp, hook)))
}

async fn gravar_integracoes(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<Integracoes>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let pool = db(&state)?;
    let usuario = admin(&me(user)?)?;
    let corpo = json_body(body)?;

    for (chave, valor) in [(CHAVE_MCP, corpo.mcp), (CHAVE_HOOK, corpo.hook)] {
        if let Some(v) = valor {
            let texto = if v { "true" } else { "false" };
            settings::repo::gravar(&pool, chave, texto, false, &usuario.username)
                .await
                .map_err(db_error)?;
        }
    }
    let (mcp, hook) = ler_integracoes(&pool).await?;
    Ok(Json(integracoes_json(mcp, hook)))
}

// --- canais de integração (token próprio, validado pelo portão) ---------------

/// `POST /mcp`: JSON-RPC do servidor MCP. O portão já validou o token.
async fn mcp_post(
    State(state): State<AppState>,
    auth: Option<Extension<IntegracaoAuth>>,
    corpo: Bytes,
) -> Response {
    let Some(Extension(auth)) = auth else {
        return nao_autorizado_resposta();
    };
    let Ok(valor) = serde_json::from_slice::<Value>(&corpo) else {
        return Json(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "JSON inválido" } }))
            .into_response();
    };
    let resposta = mcp::tratar(&state, &auth, &valor).await;
    let status = mcp::status_da_resposta(&resposta);
    match resposta {
        Some(corpo) => (status, Json(corpo)).into_response(),
        None => status.into_response(),
    }
}

fn nao_autorizado_resposta() -> Response {
    ApiError::Http(StatusCode::UNAUTHORIZED, "token inválido".to_string()).into_response()
}

#[derive(Debug, Deserialize)]
struct RegistroAgenda {
    agente: String,
    tarefa: String,
    #[serde(default)]
    minutos: Option<u32>,
}

/// `POST /api/agenda/registro`: o hook do Claude Code grava por aqui.
async fn registro_agenda(
    State(state): State<AppState>,
    auth: Option<Extension<IntegracaoAuth>>,
    body: Result<Json<RegistroAgenda>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    if auth.is_none() {
        return Err(ApiError::Http(StatusCode::UNAUTHORIZED, "token inválido".to_string()));
    }
    let corpo = json_body(body)?;
    let reg = agenda::validar(&corpo.agente, &corpo.tarefa, corpo.minutos).map_err(|msg| bad(&msg))?;
    let rel = agenda::registrar(&state.store, &reg, agenda::agora()).await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "path": rel }))))
}

pub fn routes_integracao() -> Router<AppState> {
    Router::new()
        .route("/mcp", post(mcp_post).fallback(proxy))
        .route("/api/agenda/registro", post(registro_agenda).fallback(proxy))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tokens",
            get(listar_tokens).post(criar_token).fallback(proxy),
        )
        .route(
            "/api/tokens/{id}",
            patch(editar_token).delete(apagar_token).fallback(proxy),
        )
        .route(
            "/api/integracoes",
            get(ver_integracoes).put(gravar_integracoes).fallback(proxy),
        )
}
