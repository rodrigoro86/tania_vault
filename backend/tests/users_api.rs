//! Testes de integração de `POST /api/auth/login|logout`, `GET /api/auth/me`
//! e `/api/users`, sobre o `router` completo (portão + rate limit + CSRF).
//!
//! Precisam de `TEST_DATABASE_URL`; sem ela são pulados (não há sessão possível).
//! O cliente é sempre um IP remoto (`10.0.0.n:5000`) via `ConnectInfo`, para
//! passar pelo portão de verdade — loopback entraria sem sessão. Cada teste usa
//! um IP próprio: o bloqueio de login é por IP e os testes rodam em paralelo.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::json;
use sqlx::PgPool;
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

use tania::config::Config;
use tania::db::{connect, migrate};
use tania::http::auth::COOKIE;
use tania::http::{router, AppState};
use tania::storage::local::LocalFs;
use tania::storage::Store;
use tania::users::repo;

/// Pool de teste migrado; `None` quando `TEST_DATABASE_URL` não existe.
async fn pool() -> Option<PgPool> {
    let url = match std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
    {
        Some(url) => url,
        None => {
            eprintln!("pulado: TEST_DATABASE_URL ausente");
            return None;
        }
    };
    let pool = match connect(&url).await {
        Ok(pool) => pool,
        Err(err) => panic!("TEST_DATABASE_URL definida mas nao conectou: {err}"),
    };
    if let Err(err) = migrate(&pool).await {
        panic!("migrate falhou: {err}");
    }
    Some(pool)
}

struct Fixture {
    state: AppState,
    pool: PgPool,
    _dir: TempDir,
}

/// Vault local vazio em tempdir: as rotas de auth/usuário não tocam o Store,
/// mas o `AppState` exige um.
async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let dir = TempDir::new().expect("tempdir");
    let state = AppState::new(
        Config::default(),
        reqwest::Client::new(),
        Store::Local(LocalFs::new(dir.path().to_str().expect("tempdir em utf-8"))),
    )
    .with_db(pool.clone());

    Some(Fixture {
        state,
        pool,
        _dir: dir,
    })
}

/// Username único: o banco compartilhado já tem linhas de outras rodadas.
fn unique_username() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("t{}", &id[..12])
}

/// IP remoto distinto por teste (n = número do teste).
fn remote(n: u8) -> SocketAddr {
    SocketAddr::from(([10, 0, 0, n], 5000))
}

async fn call(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    client: SocketAddr,
    headers: HeaderMap,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(body)
        .expect("request");
    request.headers_mut().extend(headers);
    request.extensions_mut().insert(ConnectInfo(client));
    router(state).oneshot(request).await.expect("resposta")
}

async fn read_json(response: Response) -> serde_json::Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("corpo")
        .to_bytes();
    serde_json::from_slice::<serde_json::Value>(&bytes).expect("json")
}

fn json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers
}

/// Bearer + content-type JSON: toda escrita precisa dos dois (CSRF exige JSON).
fn json_bearer(token: &str) -> HeaderMap {
    let mut headers = bearer(token);
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

fn cookie(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        HeaderValue::from_str(&format!("{COOKIE}={token}")).expect("cookie header"),
    );
    headers
}

async fn login(fixture: &Fixture, client: SocketAddr, username: &str, password: &str) -> Response {
    call(
        fixture.state.clone(),
        Method::POST,
        "/api/auth/login",
        Body::from(json!({ "username": username, "password": password }).to_string()),
        client,
        json_headers(),
    )
    .await
}

/// Usuário criado direto no repositório + uma sessão: `(token, usuário)`.
async fn new_user(fixture: &Fixture, password: &str, admin: bool) -> (String, repo::Usuario) {
    let user = repo::create(&fixture.pool, &unique_username(), password, admin)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(&fixture.pool, user.id)
        .await
        .expect("criar sessão de teste");
    (token, user)
}

// --- 1) login JSON: token, cookie e `/api/auth/me` -------------------------

#[tokio::test]
async fn login_json_devolve_token_cookie_e_me_autentica() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(1);
    let password = "12345678";

    let username = repo::create(&fixture.pool, &unique_username(), password, false)
        .await
        .expect("create falhou")
        .username;

    let response = login(&fixture, client, &username, password).await;
    assert_eq!(response.status(), StatusCode::OK);

    let set_cookie = response
        .headers()
        .get("set-cookie")
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .to_string();
    assert!(
        set_cookie.starts_with(&format!("{COOKIE}=")),
        "set-cookie esperado, veio {set_cookie}"
    );

    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    let token = body["token"].as_str().expect("token string");
    assert_eq!(token.len(), 43, "token deveria ter 43 chars");
    assert_eq!(
        body["user"]["username"].as_str().expect("username"),
        username
    );

    // `expiresAt` vem RFC3339 (serde do chrono)
    let expires_at = body["expiresAt"].as_str().expect("expiresAt string");
    assert!(
        chrono::DateTime::parse_from_rfc3339(expires_at).is_ok(),
        "expiresAt {expires_at} não é RFC3339"
    );

    // bearer e cookie são ambos aceitos
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        bearer(token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    assert_eq!(
        body["user"]["username"].as_str().expect("username"),
        username
    );

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        cookie(token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(
        body["user"]["username"].as_str().expect("username"),
        username
    );

    // sem credencial nenhuma: 401 do portão
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = read_json(response).await;
    assert_eq!(body["error"], json!("não autenticado"));
}

// --- 2) senha errada e lockout por IP --------------------------------------

#[tokio::test]
async fn login_errado_dá_401_e_a_sexta_dá_429() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(2);
    let username = unique_username();
    let password = "12345678";
    repo::create(&fixture.pool, &username, password, false)
        .await
        .expect("create falhou");

    // 5 tentativas erradas: todas 401
    for attempt in 1..=5 {
        let response = login(&fixture, client, &username, "senha-errada").await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "tentativa {attempt} deveria dar 401"
        );
        let body = read_json(response).await;
        assert_eq!(body["error"], json!("usuário ou senha incorretos"));
    }

    // a 6ª, mesmo com a senha certa, cai no bloqueio de 15 minutos
    let response = login(&fixture, client, &username, password).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = read_json(response).await;
    assert_eq!(body["error"], json!("muitas tentativas; espere 15 minutos"));
}

// --- 3) não admin: só troca a própria senha ---------------------------------

#[tokio::test]
async fn nao_admin_é_barrado_em_users_e_muda_a_propria_senha() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(3);
    let (token, user) = new_user(&fixture, "12345678", false).await;
    assert!(!user.admin);

    // ler a lista e criar usuários: 403
    for (method, uri) in [(Method::GET, "/api/users"), (Method::POST, "/api/users")] {
        let body = if method == Method::POST {
            Body::from(json!({ "username": "qualquer-coisa", "password": "12345678" }).to_string())
        } else {
            Body::empty()
        };
        let response = call(
            fixture.state.clone(),
            method.clone(),
            uri,
            body,
            client,
            json_bearer(&token),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{method} {uri} deveria dar 403"
        );
        let payload = read_json(response).await;
        assert_eq!(payload["error"], json!("só admin"));
    }

    // PATCH em si, só a senha: 200
    let response = call(
        fixture.state.clone(),
        Method::PATCH,
        &format!("/api/users/{}", user.id),
        Body::from(json!({ "password": "novaSenha123" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    assert_eq!(payload["ok"], json!(true));
    assert_eq!(payload["user"]["id"], json!(user.id.to_string()));

    // PATCH em si pedindo admin: 403
    let response = call(
        fixture.state.clone(),
        Method::PATCH,
        &format!("/api/users/{}", user.id),
        Body::from(json!({ "admin": true }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("só admin"));
}

// --- 4) admin cria, duplica, valida e lista ---------------------------------

#[tokio::test]
async fn admin_create_duplicado_validacao_e_get() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(4);
    let (token, admin_user) = new_user(&fixture, "12345678", true).await;
    assert!(admin_user.admin);

    let username = unique_username();

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/users",
        Body::from(json!({ "username": username, "password": "12345678" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let payload = read_json(response).await;
    assert_eq!(payload["ok"], json!(true));
    let created_id = payload["user"]["id"].as_str().expect("id do criado");
    assert_eq!(
        payload["user"]["username"].as_str().expect("username"),
        username
    );
    assert!(
        !payload["user"]["admin"].as_bool().expect("admin"),
        "sem `admin` no corpo o usuário não é admin"
    );

    // mesmo username em maiúsculas: unique case-insensitive -> 409
    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/users",
        Body::from(
            json!({ "username": username.to_uppercase(), "password": "outraSenha9" }).to_string(),
        ),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("usuário já existe"));

    // senha curta: 400
    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/users",
        Body::from(json!({ "username": unique_username(), "password": "curta" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let payload = read_json(response).await;
    assert_eq!(
        payload["error"],
        json!("a senha precisa de 8 a 128 caracteres")
    );

    // GET por id existente
    let response = call(
        fixture.state.clone(),
        Method::GET,
        &format!("/api/users/{created_id}"),
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    assert_eq!(
        payload["user"]["username"].as_str().expect("username"),
        username
    );

    // lista contém o criado
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/users",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    let users = payload["users"].as_array().expect("array de users");
    assert!(
        users
            .iter()
            .any(|user| user["username"].as_str() == Some(&username)),
        "a lista não contém {username}"
    );

    // uuid válido, inexistente -> 404
    let ghost = Uuid::new_v4().simple().to_string();
    let response = call(
        fixture.state.clone(),
        Method::GET,
        &format!("/api/users/{ghost}"),
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("usuário não encontrado"));

    // id "lixo" -> 404 também
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/users/lixo",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("usuário não encontrado"));
}

// --- 5) trocar senha / desativar derrubam as sessões -------------------------

#[tokio::test]
async fn admin_muda_senha_e_desativa_b_derrubando_as_sessoes_de_b() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(5);
    let (admin_token, _) = new_user(&fixture, "12345678", true).await;
    let (token_b, user_b) = new_user(&fixture, "12345678", false).await;

    // sessão de B ainda vale
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        bearer(&token_b),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    // o admin troca a senha de B
    let response = call(
        fixture.state.clone(),
        Method::PATCH,
        &format!("/api/users/{}", user_b.id),
        Body::from(json!({ "password": "novaSenhaDeB9" }).to_string()),
        client,
        json_bearer(&admin_token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    assert_eq!(payload["ok"], json!(true));

    // a sessão antiga de B foi derrubada junto com a senha
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        bearer(&token_b),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // desativar B: login (com a senha nova, que está certa) não entra
    let response = call(
        fixture.state.clone(),
        Method::PATCH,
        &format!("/api/users/{}", user_b.id),
        Body::from(json!({ "ativo": false }).to_string()),
        client,
        json_bearer(&admin_token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = read_json(response).await;
    assert_eq!(payload["user"]["ativo"], json!(false));

    let response = login(&fixture, client, &user_b.username, "novaSenhaDeB9").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("usuário ou senha incorretos"));
}

// --- 6) proteção do último admin e autoproteção -----------------------------

#[tokio::test]
async fn admin_nao_se_autodeleta_e_a_checagem_do_ultimo_admin_responde() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(6);
    let (token, admin_user) = new_user(&fixture, "12345678", true).await;

    // apagar a si mesmo: 409
    let response = call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/users/{}", admin_user.id),
        Body::empty(),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("não dá para apagar a si mesmo"));

    // rebaixar a si mesmo: só dá se houver outro admin ativo no banco
    // compartilhado; por isso aceitamos 409 (último admin) ou 200.
    let response = call(
        fixture.state.clone(),
        Method::PATCH,
        &format!("/api/users/{}", admin_user.id),
        Body::from(json!({ "admin": false }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    let status = response.status();
    assert!(
        status == StatusCode::CONFLICT || status == StatusCode::OK,
        "esperava 409 ou 200, veio {status}"
    );
    let payload = read_json(response).await;
    if status == StatusCode::CONFLICT {
        assert_eq!(
            payload["error"],
            json!("não dá para remover o último admin")
        );
    } else {
        assert_eq!(payload["ok"], json!(true));
    }
}

// --- 7) logout apaga a sessão -----------------------------------------------

#[tokio::test]
async fn logout_limpa_a_sessao_e_o_cookie() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(7);
    let username = unique_username();
    repo::create(&fixture.pool, &username, "12345678", false)
        .await
        .expect("create falhou");

    let response = login(&fixture, client, &username, "12345678").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let token = body["token"].as_str().expect("token").to_string();

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/auth/logout",
        Body::from("{}"),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response
        .headers()
        .get("set-cookie")
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .to_string();
    assert!(
        set_cookie.starts_with(&format!("{COOKIE}=")) && set_cookie.contains("Max-Age=0"),
        "cookie de logout esperado, veio {set_cookie}"
    );
    let payload = read_json(response).await;
    assert_eq!(payload["ok"], json!(true));

    // o token apagado não vale mais
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/auth/me",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let payload = read_json(response).await;
    assert_eq!(payload["error"], json!("não autenticado"));
}
