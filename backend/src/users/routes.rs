//! Rotas JSON de autenticação (`/api/auth/*`) e de gestão de usuários
//! (`/api/users`).
//!
//! O portão (`crate::http::auth::gate`) já resolve a sessão e injeta o
//! `Usuario` e o `SessionToken` nas extensions do request; aqui só se leem.
//! Todo erro sai por `ApiError::Http(status, msg)`, que serializa como
//! `{ "ok": false, "error": msg }`, igual ao Node.

use std::net::SocketAddr;

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Extension, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;
use crate::http::auth::{
    check_login, is_https, session_cookie, LoginError, SessionToken, MAX_AGE_S,
};
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::users::{password, repo, Usuario};

// --- helpers de handler ------------------------------------------------------

/// Postgres do estado. Sem `DATABASE_URL` não há como operar: 503.
pub(crate) fn db(state: &AppState) -> Result<PgPool, ApiError> {
    state.db.clone().ok_or_else(|| {
        ApiError::Http(
            StatusCode::SERVICE_UNAVAILABLE,
            "banco não configurado".to_string(),
        )
    })
}

/// Quem está pedindo. O portão só entrega request autenticado para `/api/*`,
/// mas a checagem fica explícita: sem usuário nas extensions, 401.
pub(crate) fn me(user: Option<Extension<Usuario>>) -> Result<Usuario, ApiError> {
    user.map(|Extension(user)| user)
        .ok_or_else(|| ApiError::Http(StatusCode::UNAUTHORIZED, "não autenticado".to_string()))
}

/// Gestão de usuários (e de configuração) é só para admins.
pub(crate) fn admin(user: &Usuario) -> Result<Usuario, ApiError> {
    if user.admin {
        Ok(user.clone())
    } else {
        Err(ApiError::Http(
            StatusCode::FORBIDDEN,
            "só admin".to_string(),
        ))
    }
}

/// Corpo JSON: qualquer rejeição do axum (corpo mal formado, limite estourado)
/// vira 400.
pub(crate) fn json_body<T: serde::de::DeserializeOwned>(
    body: Result<Json<T>, JsonRejection>,
) -> Result<T, ApiError> {
    body.map(|Json(value)| value).map_err(|_| {
        tracing::debug!("corpo JSON rejeitado");
        ApiError::Http(StatusCode::BAD_REQUEST, "corpo inválido".to_string())
    })
}

/// Erros do banco nunca vazam detalhes: 500 genérico, com o original no log.
pub(crate) fn db_error(err: sqlx::Error) -> ApiError {
    tracing::error!("banco: {err}");
    ApiError::Http(
        StatusCode::INTERNAL_SERVER_ERROR,
        "erro no banco".to_string(),
    )
}

fn repo_error(err: repo::RepoError) -> ApiError {
    match err {
        repo::RepoError::Duplicate => {
            ApiError::Http(StatusCode::CONFLICT, "usuário já existe".to_string())
        }
        repo::RepoError::Hash => {
            tracing::error!("argon2: não foi possível hashar a senha");
            ApiError::Http(
                StatusCode::INTERNAL_SERVER_ERROR,
                "erro no banco".to_string(),
            )
        }
        repo::RepoError::Db(err) => db_error(err),
    }
}

fn not_found() -> ApiError {
    ApiError::Http(StatusCode::NOT_FOUND, "usuário não encontrado".to_string())
}

fn last_admin() -> ApiError {
    ApiError::Http(
        StatusCode::CONFLICT,
        "não dá para remover o último admin".to_string(),
    )
}

/// `id` da URL: uuid parseável e existente, senão 404 (a mesma mensagem para
/// "lixo" e para "não existe").
fn parse_id(id: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(id).map_err(|_| not_found())
}

// --- /api/auth/login ---------------------------------------------------------

#[derive(Debug, Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

/// Login JSON: mesmo `check_login` do formulário, mas devolve o token no corpo
/// (para a SPA) e também no cookie.
async fn login(
    State(state): State<AppState>,
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<LoginBody>, JsonRejection>,
) -> Result<Response, ApiError> {
    let pool = db(&state)?;
    let input = json_body(body)?;

    match check_login(&state, &pool, client.ip(), &input.username, &input.password).await {
        Ok((user, token, expira_em)) => Ok((
            StatusCode::OK,
            [(
                "Set-Cookie",
                session_cookie(&token, MAX_AGE_S, is_https(&headers)),
            )],
            Json(json!({
                "ok": true,
                "token": token,
                "expiresAt": expira_em,
                "user": user,
            })),
        )
            .into_response()),
        Err(LoginError::Locked) => Err(ApiError::Http(
            StatusCode::TOO_MANY_REQUESTS,
            "muitas tentativas; espere 15 minutos".to_string(),
        )),
        Err(LoginError::Invalid) => Err(ApiError::Http(
            StatusCode::UNAUTHORIZED,
            "usuário ou senha incorretos".to_string(),
        )),
        Err(LoginError::Db) => Err(ApiError::Http(
            StatusCode::INTERNAL_SERVER_ERROR,
            "erro no banco".to_string(),
        )),
    }
}

// --- /api/auth/logout --------------------------------------------------------

/// Apaga a sessão atual do banco e limpa o cookie.
async fn logout(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    session: Option<Extension<SessionToken>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let who = me(user)?;
    let pool = db(&state)?;

    if let Some(Extension(token)) = session {
        repo::delete_session(&pool, &token.0)
            .await
            .map_err(db_error)?;
    }

    tracing::debug!("logout: sessão de '{}' encerrada", who.username);

    Ok((
        StatusCode::OK,
        [("Set-Cookie", session_cookie("", 0, is_https(&headers)))],
        Json(json!({ "ok": true })),
    )
        .into_response())
}

// --- /api/auth/me ----------------------------------------------------------

async fn current_user(user: Option<Extension<Usuario>>) -> Result<impl IntoResponse, ApiError> {
    let who = me(user)?;
    Ok(Json(json!({ "ok": true, "user": who })))
}

// --- /api/users ------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateBody {
    username: String,
    password: String,
    #[serde(default)]
    admin: bool,
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    admin: Option<bool>,
    #[serde(default)]
    ativo: Option<bool>,
}

async fn list_users(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    let users = repo::list(&pool).await.map_err(db_error)?;
    tracing::debug!("'{}' listou {} usuários", who.username, users.len());

    Ok(Json(json!({ "ok": true, "users": users })))
}

async fn create_user(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<CreateBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;
    let input = json_body(body)?;

    if !password::valid_username(&input.username) {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "usuário inválido: 3 a 32 caracteres, letras, números, . _ -".to_string(),
        ));
    }
    if !password::valid_password(&input.password) {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "a senha precisa de 8 a 128 caracteres".to_string(),
        ));
    }

    let created = repo::create(&pool, &input.username, &input.password, input.admin)
        .await
        .map_err(repo_error)?;

    tracing::info!("'{}' criou o usuário '{}'", who.username, created.username);

    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "user": created })),
    ))
}

async fn get_user(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    admin(&me(user)?)?;
    let pool = db(&state)?;
    let target = repo::get(&pool, parse_id(&id)?).await.map_err(db_error)?;

    match target {
        Some(target) => Ok(Json(json!({ "ok": true, "user": target }))),
        None => Err(not_found()),
    }
}

async fn update_user(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    session: Option<Extension<SessionToken>>,
    Path(id): Path<String>,
    body: Result<Json<UpdateBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = me(user)?;
    let pool = db(&state)?;
    let input = json_body(body)?;
    let target_id = parse_id(&id)?;

    // Um não admin só pode trocar a própria senha: mexer em `admin`/`ativo` ou
    // em outro usuário é 403.
    if !who.admin && (target_id != who.id || input.admin.is_some() || input.ativo.is_some()) {
        return Err(ApiError::Http(
            StatusCode::FORBIDDEN,
            "só admin".to_string(),
        ));
    }

    if let Some(new_password) = &input.password {
        if !password::valid_password(new_password) {
            return Err(ApiError::Http(
                StatusCode::BAD_REQUEST,
                "a senha precisa de 8 a 128 caracteres".to_string(),
            ));
        }
    }

    let Some(target) = repo::get(&pool, target_id).await.map_err(db_error)? else {
        return Err(not_found());
    };

    // shortcut: checagem do último admin não é atômica; dois admins se rebaixando
    // ao mesmo tempo podem zerar admins. Resolver com lock se houver muitos admins.
    if target.admin && target.ativo && (input.admin == Some(false) || input.ativo == Some(false)) {
        let admins = repo::count_active_admins(&pool).await.map_err(db_error)?;
        if admins <= 1 {
            return Err(last_admin());
        }
    }

    let Some(updated) = repo::update(
        &pool,
        target_id,
        input.admin,
        input.ativo,
        input.password.as_deref(),
    )
    .await
    .map_err(repo_error)?
    else {
        // alguém apagou o usuário entre o `get` e o `update`
        return Err(not_found());
    };

    // Senha nova: derruba as sessões antigas do alvo, exceto a que está usando
    // agora se for o próprio usuário.
    if input.password.is_some() {
        let keep = if target_id == who.id {
            session.map(|Extension(token)| token.0)
        } else {
            None
        };
        repo::delete_sessions_except(&pool, target_id, keep.as_deref())
            .await
            .map_err(db_error)?;
    }

    // Inativo não tem sessão válida: apaga todas, sem exceção.
    if input.ativo == Some(false) {
        repo::delete_sessions_except(&pool, target_id, None)
            .await
            .map_err(db_error)?;
    }

    Ok(Json(json!({ "ok": true, "user": updated })))
}

async fn delete_user(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;
    let target_id = parse_id(&id)?;

    if target_id == who.id {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            "não dá para apagar a si mesmo".to_string(),
        ));
    }

    let Some(target) = repo::get(&pool, target_id).await.map_err(db_error)? else {
        return Err(not_found());
    };

    // shortcut: checagem do último admin não é atômica; dois admins se rebaixando
    // ao mesmo tempo podem zerar admins. Resolver com lock se houver muitos admins.
    if target.admin && target.ativo {
        let admins = repo::count_active_admins(&pool).await.map_err(db_error)?;
        if admins <= 1 {
            return Err(last_admin());
        }
    }

    repo::delete(&pool, target_id).await.map_err(db_error)?;
    tracing::info!("'{}' apagou o usuário '{}'", who.username, target.username);

    Ok(Json(json!({ "ok": true })))
}

/// Rotas de auth e usuários. Métodos não registrados no caminho caem no
/// proxy (como no vault), nunca num 405 do axum.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", post(login).fallback(proxy))
        .route("/api/auth/logout", post(logout).fallback(proxy))
        .route("/api/auth/me", get(current_user).fallback(proxy))
        .route(
            "/api/users",
            get(list_users).post(create_user).fallback(proxy),
        )
        .route(
            "/api/users/{id}",
            get(get_user)
                .patch(update_user)
                .delete(delete_user)
                .fallback(proxy),
        )
}
