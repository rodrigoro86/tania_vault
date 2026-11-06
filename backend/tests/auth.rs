//! Testes do portão de autenticação (`http::auth::gate`).
//!
//! O portão não usa mais `VAULT_AUTH`: quem entra é quem tem uma sessão no
//! Postgres. Sem banco (`db: None`) só loopback passa e o cliente remoto
//! recebe 503. Os testes que precisam de sessão usam `TEST_DATABASE_URL`
//! (como em `tests/db.rs`) e são pulados quando ela não está definida.
//!
//! Os testes de sessão usam IPs remotos diferentes entre si: o bloqueio de
//! login é por IP e os testes rodam em paralelo.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;

use tania::config::Config;
use tania::db::{connect, migrate};
use tania::http::auth::{COOKIE, MAX_AGE_S};
use tania::http::{router, AppState};
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

/// Username único: o banco compartilhado já tem linhas de outras rodadas.
fn unique_username() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("a{}", &id[..12])
}

/// Usuário novo + sessão criada direto no repositório: `(token, username)`.
async fn new_session(pool: &PgPool, password: &str) -> (String, String) {
    let user = repo::create(pool, &unique_username(), password, false)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(pool, user.id)
        .await
        .expect("criar sessão de teste");
    (token, user.username)
}

/// Portão + proxy apontando para um upstream falso, SEM banco.
fn state_no_db(upstream: &str, max: u32, window_ms: i64) -> AppState {
    AppState::new(
        Config {
            legacy_upstream: upstream.to_string(),
            rate_limit_max: max,
            rate_limit_window_ms: window_ms,
            ..Config::default()
        },
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("cliente reqwest"),
        // vault vazio: estes testes exercitam o portão e o proxy, não as rotas
        tania::storage::Store::Local(tania::storage::local::LocalFs::new(env!(
            "CARGO_TARGET_TMPDIR"
        ))),
    )
}

/// Idem, com Postgres: só quem tem sessão no banco entra de um IP remoto.
fn state_with_db(upstream: &str, pool: &PgPool, max: u32, window_ms: i64) -> AppState {
    state_no_db(upstream, max, window_ms).with_db(pool.clone())
}

/// Upstream que ecoa método, path+query e corpo, e conta quantas vezes foi chamado.
fn echo_upstream(counter: Arc<AtomicUsize>) -> Router {
    Router::new().route(
        "/{*path}",
        any(move |request: Request| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::Relaxed);
                let method = request.method().to_string();
                let uri = request.uri().to_string();
                let body = read_body(request.into_body()).await;
                axum::Json(serde_json::json!({ "method": method, "uri": uri, "body": body }))
                    .into_response()
            }
        }),
    )
}

async fn spawn_upstream(app: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do upstream falso");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("upstream falso: {err}");
        }
    });
    addr
}

async fn read_body(body: Body) -> String {
    let bytes = body.collect().await.expect("corpo").to_bytes();
    String::from_utf8(bytes.to_vec()).expect("utf-8")
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

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 4321))
}

/// IP remoto distinto por teste: o lockout de login é por IP.
fn remote(n: u8) -> SocketAddr {
    SocketAddr::from(([10, 0, 1, n], 1234))
}

fn cookie_header(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "cookie",
        HeaderValue::from_str(&format!("{COOKIE}={token}")).expect("cookie header"),
    );
    headers
}

fn bearer_header(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers
}

fn json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

fn form_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    headers
}

fn login_form(user: &str, password: &str) -> Body {
    Body::from(format!("user={user}&password={password}"))
}

fn set_cookie(response: &Response) -> String {
    response
        .headers()
        .get("set-cookie")
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .to_string()
}

/// Valor bruto do cookie `vault_session` em um `Set-Cookie` (43 chars).
fn cookie_value(set_cookie: &str) -> String {
    let first = set_cookie.split(';').next().expect("primeira parte");
    let (_, value) = first.split_once('=').expect("nome=valor");
    value.to_string()
}

// --- sem banco ---------------------------------------------------------------

#[tokio::test]
async fn sem_banco_loopback_passa_remoto_503_com_texto_novo() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_no_db(&format!("http://{upstream}"), 300, 60_000);

    // loopback entra, sem cookie nenhum
    let response = call(
        state.clone(),
        Method::GET,
        "/99-Meta/nota.md",
        Body::empty(),
        loopback(),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        counter.load(Ordering::Relaxed),
        1,
        "loopback passa pelo portão"
    );

    // `::ffff:127.0.0.1` também é loopback
    let mapped: IpAddr = "::ffff:127.0.0.1".parse().expect("ipv6 mapped");
    let response = call(
        state.clone(),
        Method::GET,
        "/x",
        Body::empty(),
        SocketAddr::new(mapped, 4321),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 2);

    // remoto: 503 com o texto do DATABASE_URL, e o Node não é tocado
    let response = call(
        state.clone(),
        Method::GET,
        "/x",
        Body::empty(),
        remote(1),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.headers()["content-type"],
        HeaderValue::from_static("text/plain; charset=utf-8")
    );
    assert_eq!(
        read_body(response.into_body()).await,
        "Acesso remoto bloqueado: defina DATABASE_URL no servidor."
    );

    // `/api` remoto cai na mesma regra, não no 401 de "sem sessão"
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        remote(2),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(counter.load(Ordering::Relaxed), 2, "remoto não repassa");
}

#[tokio::test]
async fn webhook_health_e_assets_passam_sem_cookie_e_sem_banco() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    // cap de 2: se o webhook ou os assets entrassem na janela, o resto estouraria
    let state = state_no_db(&format!("http://{upstream}"), 2, 60_000);

    // webhook da Evolution: sem cookie, fora do rate limit, até de IP remoto
    let response = call(
        state.clone(),
        Method::POST,
        "/api/evolution/webhook",
        Body::from("{}"),
        remote(3),
        json_headers(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);

    // health é do Rust e público
    let response = call(
        state.clone(),
        Method::GET,
        "/api/health",
        Body::empty(),
        remote(4),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        json(&read_body(response.into_body()).await),
        serde_json::json!({ "ok": true, "storage": "local", "writable": true, "backend": "rust" })
    );
    assert_eq!(counter.load(Ordering::Relaxed), 1, "health não repassa");

    // ícone e manifest: públicos mesmo vindo de fora
    for path in ["/icons/icon.png", "/manifest.webmanifest"] {
        let response = call(
            state.clone(),
            Method::GET,
            path,
            Body::empty(),
            remote(5),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "{path} deveria ser público"
        );
    }
    assert_eq!(
        counter.load(Ordering::Relaxed),
        3,
        "ícone e manifest repassam ao Node"
    );

    // fora da lista: `/assets/...` não é público. Remoto sem banco é bloqueado;
    // loopback entra pelo bypass (sem banco não há sessão a verificar) e chega ao
    // Node, que responde 303 "sem sessão" no fluxo real.
    let response = call(
        state.clone(),
        Method::GET,
        "/assets/index-abc.js",
        Body::empty(),
        remote(6),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(counter.load(Ordering::Relaxed), 3, "remoto não repassa");

    let response = call(
        state.clone(),
        Method::GET,
        "/assets/index-abc.js",
        Body::empty(),
        loopback(),
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 4, "loopback repassa");
}

#[tokio::test]
async fn rate_limit_limita_a_api_por_ip_e_nao_conta_o_resto() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    // sem banco, loopback entra sem sessão: o rate limit é exercitado sozinho
    let state = state_no_db(&format!("http://{upstream}"), 2, 60_000);

    let ip_a = loopback();
    let ip_b: IpAddr = "127.0.0.2".parse().expect("outro loopback");
    let ip_b = SocketAddr::new(ip_b, 4321);

    for i in 0..2 {
        let response = call(
            state.clone(),
            Method::GET,
            "/api/finance/resumo",
            Body::empty(),
            ip_a,
            HeaderMap::new(),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "requisição {i} dentro do cap"
        );
    }

    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip_a,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(
        response.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "3ª estoura o cap"
    );
    assert_eq!(
        json(&read_body(response.into_body()).await),
        serde_json::json!({ "ok": false, "error": "muitas requisições: aguarde um instante" })
    );

    // outro IP tem a própria janela
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip_b,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    // `/files/...` é atendido pelo Rust (serve_file) e não entra na janela: o
    // vault de teste vazio devolve 404 para o mesmo IP já estourado.
    let response = call(
        state.clone(),
        Method::GET,
        "/files/99-Meta/x.png",
        Body::empty(),
        ip_a,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    assert_eq!(
        counter.load(Ordering::Relaxed),
        3,
        "nem o 429 nem o 404 do Rust chegam ao Node"
    );
}

// --- com banco: sessão no Postgres -----------------------------------------

#[tokio::test]
async fn com_banco_sem_sessao_redirect_401_e_pagina_de_login() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);
    let ip = remote(6);

    // página/app sem sessão -> login
    let response = call(
        state.clone(),
        Method::GET,
        "/99-Meta/nota.md",
        Body::empty(),
        ip,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()["location"], "/login");
    assert_eq!(response.headers()["cache-control"], "no-store");

    // /api sem sessão -> 401 JSON, sem tocar o Node
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()["content-type"],
        HeaderValue::from_static("application/json")
    );
    assert_eq!(
        json(&read_body(response.into_body()).await),
        serde_json::json!({ "ok": false, "error": "não autenticado" })
    );

    // página de login: HTML, sem erro prévio
    let response = call(
        state.clone(),
        Method::GET,
        "/login",
        Body::empty(),
        ip,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"],
        HeaderValue::from_static("text/html; charset=utf-8")
    );
    let page = read_body(response.into_body()).await;
    assert!(page.contains("type=\"password\""));
    assert!(!page.contains("<p class=\"error\""));
    assert!(!page.contains("{{ERROR}}"));

    assert_eq!(counter.load(Ordering::Relaxed), 0, "nenhum deles repassa");
}

#[tokio::test]
async fn login_certo_emite_cookie_de_sessao_de_43_chars() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);

    let (username, password) = (unique_username(), "s3nha:com-colon");
    repo::create(&pool, &username, password, false)
        .await
        .expect("criar usuário de teste");

    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form(&username, password),
        remote(7),
        form_headers(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()["location"], "/");
    assert_eq!(response.headers()["cache-control"], "no-store");

    let cookie = set_cookie(&response);
    let token = cookie_value(&cookie);
    assert_eq!(token.len(), 43, "token de sessão tem 43 chars");
    assert_eq!(
        cookie,
        format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={MAX_AGE_S}")
    );
    assert!(!cookie.contains("Secure"), "http não emite Secure");

    // https (Traefik) -> cookie Secure
    let mut headers = form_headers();
    headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form(&username, password),
        remote(8),
        headers,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let secure_cookie = set_cookie(&response);
    assert!(secure_cookie.ends_with("; Secure"));
    assert!(secure_cookie.contains(&format!("Max-Age={MAX_AGE_S}")));

    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "login nunca chega ao Node"
    );
}

#[tokio::test]
async fn sessao_valida_de_cookie_e_de_bearer_chega_ao_upstream() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);
    let ip = remote(9);

    let (token, _username) = new_session(&pool, "senha-de-teste").await;

    // cookie
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        cookie_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);

    // `Authorization: Bearer` funciona igual
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        bearer_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 2);

    // token inexistente no banco: 401 e o Node não é tocado
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        cookie_header("token-que-nao-existe-no-banco"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(counter.load(Ordering::Relaxed), 2);

    // quem já tem sessão vai direto para o app
    for headers in [cookie_header(&token), bearer_header(&token)] {
        let response = call(
            state.clone(),
            Method::GET,
            "/login",
            Body::empty(),
            ip,
            headers,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()["location"], "/");
    }
    assert_eq!(
        counter.load(Ordering::Relaxed),
        2,
        "redirecionamentos não repassam"
    );
}

#[tokio::test]
async fn logout_limpa_o_cookie_e_derruba_a_sessao_no_banco() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);
    let ip = remote(10);

    let (token, _username) = new_session(&pool, "senha-de-teste").await;

    let response = call(
        state.clone(),
        Method::POST,
        "/logout",
        Body::empty(),
        ip,
        cookie_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()["location"], "/login");
    let cookie = set_cookie(&response);
    assert!(
        cookie.contains("Max-Age=0"),
        "logout zerou o Max-Age: {cookie}"
    );
    assert_eq!(cookie_value(&cookie), "");

    // o mesmo token não autentica mais
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        cookie_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        json(&read_body(response.into_body()).await),
        serde_json::json!({ "ok": false, "error": "não autenticado" })
    );

    // e /login volta a mostrar a página
    let response = call(
        state.clone(),
        Method::GET,
        "/login",
        Body::empty(),
        ip,
        cookie_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(counter.load(Ordering::Relaxed), 0, "nada repassou ao Node");
}

#[tokio::test]
async fn cinco_falhas_de_login_bloqueiam_o_ip() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);
    let ip = remote(11);
    let (username, password) = (unique_username(), "senha-correta");
    let _user = repo::create(&pool, &username, password, false)
        .await
        .expect("criar usuário de teste");

    // senha errada: 401 HTML, sem cookie
    for i in 0..5 {
        let response = call(
            state.clone(),
            Method::POST,
            "/login",
            login_form(&username, "errada"),
            ip,
            form_headers(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "falha {i}");
        assert_eq!(response.headers().get("set-cookie"), None);
        assert!(read_body(response.into_body())
            .await
            .contains("Usuário ou senha incorretos."));
    }

    // 6ª tentativa, mesmo com a senha certa: bloqueio por IP
    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form(&username, password),
        ip,
        form_headers(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers().get("set-cookie"), None);
    let body = read_body(response.into_body()).await;
    assert!(body.contains("Muitas tentativas. Espere 15 minutos."));

    // outro IP não é afetado pelo bloqueio
    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form(&username, password),
        remote(12),
        form_headers(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);

    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "login nunca chega ao Node"
    );
}

#[tokio::test]
async fn usuario_inexistente_paga_argon2_e_nao_autentica() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);

    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form("fulano-inexistente", "senha-de-timing-nunca-usada"),
        remote(13),
        form_headers(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers().get("set-cookie"), None);
    assert!(read_body(response.into_body())
        .await
        .contains("Usuário ou senha incorretos."));
    assert_eq!(counter.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn form_de_login_grande_demais_devolve_413() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);

    let big = format!("user=u&password={}", "a".repeat(5000));
    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        Body::from(big),
        remote(14),
        form_headers(),
    )
    .await;

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.headers().get("set-cookie"), None);
    assert!(read_body(response.into_body())
        .await
        .contains("Requisição inválida."));
    assert_eq!(counter.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn usuario_desativado_perde_a_sessao_e_nao_consegue_logar() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;
    let state = state_with_db(&format!("http://{upstream}"), &pool, 300, 60_000);
    let ip = remote(15);
    let password = "senha-do-desativado";

    let user = repo::create(&pool, &unique_username(), password, false)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(&pool, user.id)
        .await
        .expect("criar sessão de teste");

    let desativado = repo::update(&pool, user.id, None, Some(false), None)
        .await
        .expect("desativar usuário")
        .expect("usuário existe");
    assert!(!desativado.ativo);

    // sessão antiga (token ainda não vencido) já não vale nada
    let response = call(
        state.clone(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        ip,
        cookie_header(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // e o login, mesmo com a senha certa, é recusado
    let response = call(
        state.clone(),
        Method::POST,
        "/login",
        login_form(&user.username, password),
        remote(16),
        form_headers(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers().get("set-cookie"), None);
    assert!(read_body(response.into_body())
        .await
        .contains("Usuário ou senha incorretos."));

    assert_eq!(counter.load(Ordering::Relaxed), 0);
}

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).expect("json")
}
