//! Testes do proxy e do portão (gate) ao redor dele.
//!
//! Sem Postgres (`db: None`) o portão só deixa entrar loopback: o cliente remoto
//! recebe 503. Todos os testes daqui que não precisam de sessão usam `db: None`
//! e um cliente loopback; os testes de sessão usam `TEST_DATABASE_URL` (como em
//! `tests/db.rs`) e são pulados quando ela não está definida.

use std::net::SocketAddr;
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

/// Username único: o banco compartilhado já tem linhas de outras rodadas/suites.
fn unique_username() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("t{}", &id[..12])
}

/// Usuário novo + sessão válida: devolve `(token, username)` para o portão.
async fn new_session(pool: &PgPool) -> (String, String) {
    let username = unique_username();
    let user = repo::create(pool, &username, "senha-de-teste", false)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(pool, user.id)
        .await
        .expect("criar sessão de teste");
    (token, user.username)
}

/// Portão + proxy apontando para um upstream falso já levantado, SEM banco.
fn state(upstream: &str, legacy_proxy_secret: Option<&str>) -> AppState {
    AppState::new(
        Config {
            legacy_upstream: upstream.to_string(),
            legacy_proxy_secret: legacy_proxy_secret.map(|value| value.to_string()),
            ..Config::default()
        },
        // mesma política do main: o proxy não segue redirects do Node
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("cliente reqwest"),
        // vault vazio: estes testes exercitam o proxy, não as rotas do vault
        tania::storage::Store::Local(tania::storage::local::LocalFs::new(env!(
            "CARGO_TARGET_TMPDIR"
        ))),
    )
}

async fn read_body(body: Body) -> String {
    let bytes = body.collect().await.expect("corpo").to_bytes();
    String::from_utf8(bytes.to_vec()).expect("utf-8")
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

async fn call_proxy(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    client: SocketAddr,
    cookie: Option<&str>,
) -> Response {
    call_proxy_with_headers(state, method, uri, body, client, cookie, HeaderMap::new()).await
}

async fn call_proxy_with_headers(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    client: SocketAddr,
    cookie: Option<&str>,
    headers: HeaderMap,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(body)
        .expect("request");
    request.headers_mut().extend(headers);
    if let Some(cookie) = cookie {
        request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(cookie).expect("cookie header"),
        );
    }
    request.extensions_mut().insert(ConnectInfo(client));
    router(state)
        .oneshot(request)
        .await
        .expect("proxy responde")
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

fn header_or_dash(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// Upstream que devolve como corpo `x-tania-proxy|x-tania-user`, ou `-` para o
/// header que não chegou. É o que permite ver o que o proxy repassa ao Node.
fn header_echo_upstream(counter: Arc<AtomicUsize>) -> Router {
    Router::new().route(
        "/{*path}",
        any(move |request: Request| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::Relaxed);
                let proxy = header_or_dash(request.headers(), "x-tania-proxy");
                let user = header_or_dash(request.headers(), "x-tania-user");
                Body::from(format!("{proxy}|{user}")).into_response()
            }
        }),
    )
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 4321))
}

fn remote() -> SocketAddr {
    SocketAddr::from(([10, 0, 0, 5], 1234))
}

#[tokio::test]
async fn health_responde_em_rust_sem_tocar_o_upstream() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;

    // `/api/health` é público: entra sem sessão e sem banco, até de um IP remoto.
    for client in [loopback(), remote()] {
        let response = call_proxy(
            state(&format!("http://{upstream}"), None),
            Method::GET,
            "/api/health",
            Body::empty(),
            client,
            None,
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            json(&read_body(response.into_body()).await),
            serde_json::json!({ "ok": true, "storage": "local", "writable": true, "backend": "rust" })
        );
    }
    assert_eq!(counter.load(Ordering::Relaxed), 0, "health não repassa");
}

#[tokio::test]
async fn proxy_preserva_metodo_path_query_corpo_e_status() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;

    let payload = serde_json::json!({ "titulo": "nota", "texto": "oi" });
    let mut headers = HeaderMap::new();
    // CSRF: toda escrita em /api precisa de Content-Type JSON
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    let response = call_proxy_with_headers(
        state(&format!("http://{upstream}"), None),
        Method::POST,
        "/api/agent/status?x=1",
        Body::from(payload.to_string()),
        loopback(),
        None,
        headers,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);

    let echoed: serde_json::Value =
        serde_json::from_str(&read_body(response.into_body()).await).expect("json eco");
    assert_eq!(echoed["method"], "POST");
    assert_eq!(echoed["uri"], "/api/agent/status?x=1");
    assert_eq!(json(echoed["body"].as_str().expect("corpo texto")), payload);
    assert_eq!(counter.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn proxy_repassa_o_ip_real_e_o_proto_ao_node() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let hits = counter.clone();
    let app = Router::new().route(
        "/{*path}",
        any(move |request: Request| {
            let counter = hits.clone();
            async move {
                counter.fetch_add(1, Ordering::Relaxed);
                let headers: HeaderMap = request.headers().clone();
                axum::Json(serde_json::json!({
                    "forwarded_for": header_or_dash(&headers, "x-forwarded-for"),
                    "forwarded_proto": header_or_dash(&headers, "x-forwarded-proto"),
                }))
                .into_response()
            }
        }),
    );
    let upstream = spawn_upstream(app).await;

    // um cliente remoto só entra com sessão no Postgres
    let (token, _username) = new_session(&pool).await;
    let state =
        state(&format!("http://{upstream}"), Some("segredo-de-teste")).with_db(pool.clone());

    let response = call_proxy(
        state,
        Method::GET,
        "/api/me",
        Body::empty(),
        SocketAddr::from(([203, 0, 113, 9], 5555)),
        Some(&format!("vault_session={token}")),
    )
    .await;
    // o proto vem do Traefik quando já há https; aqui não há, então o proxy põe "http"
    let echoed: serde_json::Value =
        serde_json::from_str(&read_body(response.into_body()).await).expect("json eco");
    assert_eq!(echoed["forwarded_for"], "203.0.113.9");
    assert_eq!(echoed["forwarded_proto"], "http");
    assert_eq!(counter.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn proxy_preserva_multiplos_set_cookie() {
    let counter = Arc::new(AtomicUsize::new(0));
    let hits = counter.clone();
    let app = Router::new().route(
        "/{*path}",
        any(move || {
            let counter = hits.clone();
            async move {
                counter.fetch_add(1, Ordering::Relaxed);
                let mut headers = HeaderMap::new();
                headers.append("set-cookie", HeaderValue::from_static("a=1; path=/"));
                headers.append("set-cookie", HeaderValue::from_static("b=2; path=/"));
                (headers, Body::empty()).into_response()
            }
        }),
    );
    let upstream = spawn_upstream(app).await;

    let response = call_proxy(
        state(&format!("http://{upstream}"), None),
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        loopback(),
        None,
    )
    .await;

    let cookies: Vec<HeaderValue> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .cloned()
        .collect();
    assert_eq!(
        cookies,
        vec![
            HeaderValue::from_static("a=1; path=/"),
            HeaderValue::from_static("b=2; path=/"),
        ]
    );
    assert_eq!(counter.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn proxy_devolve_302_sem_seguir_o_redirect() {
    let counter = Arc::new(AtomicUsize::new(0));
    let hits = counter.clone();
    let app = Router::new().route(
        "/{*path}",
        any(move || {
            let counter = hits.clone();
            async move {
                counter.fetch_add(1, Ordering::Relaxed);
                (
                    StatusCode::FOUND,
                    [("location", "/login")],
                    Body::from("redirecionando"),
                )
                    .into_response()
            }
        }),
    );
    let upstream = spawn_upstream(app).await;

    let response = call_proxy(
        state(&format!("http://{upstream}"), None),
        Method::GET,
        "/api/me",
        Body::empty(),
        loopback(),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(response.headers()["location"], "/login");
    assert_eq!(read_body(response.into_body()).await, "redirecionando");
}

#[tokio::test]
async fn upstream_inexistente_devolve_502() {
    // Porta efêmera fechada: pega o endereço do bind e solta o listener.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let dead = listener.local_addr().expect("local_addr");
    drop(listener);

    let response = call_proxy(
        state(&format!("http://{dead}"), None),
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        loopback(),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(read_body(response.into_body())
        .await
        .contains("backend legado indisponível"));
}

#[tokio::test]
async fn sem_banco_bloquea_cliente_remoto_com_texto_503() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;

    let response = call_proxy(
        state(&format!("http://{upstream}"), None),
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        remote(),
        None,
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
    assert_eq!(counter.load(Ordering::Relaxed), 0, "não repassa ao Node");
}

#[tokio::test]
async fn sem_banco_permite_loopback() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(header_echo_upstream(counter.clone())).await;

    let response = call_proxy(
        state(&format!("http://{upstream}"), Some("s3gredo")),
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        loopback(),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);
    // sem sessão não há usuário, então nenhum segredo é injetado: o Node não vê
    // "requisição autentificada", e os headers forjados do cliente foram cortados.
    assert_eq!(read_body(response.into_body()).await, "-|-");
}

// Um header forjado pelo cliente nunca chega ao Node, mesmo sem segredo.
#[tokio::test]
async fn headers_forgados_do_cliente_sao_removidos() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(header_echo_upstream(counter.clone())).await;

    let mut headers = HeaderMap::new();
    headers.insert("x-tania-proxy", HeaderValue::from_static("forjado"));
    headers.insert("x-tania-user", HeaderValue::from_static("outra-pessoa"));

    let response = call_proxy_with_headers(
        state(&format!("http://{upstream}"), None),
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        loopback(),
        None,
        headers,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(read_body(response.into_body()).await, "-|-");
    assert_eq!(counter.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn com_sessao_permite_cliente_remoto() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(header_echo_upstream(counter.clone())).await;

    let (token, username) = new_session(&pool).await;
    let state = state(&format!("http://{upstream}"), Some("s3gredo")).with_db(pool.clone());

    let response = call_proxy(
        state,
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        remote(),
        Some(&format!("vault_session={token}")),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);
    // o Node recebe o segredo e o usuário da sessão, não o que o cliente mandou
    assert_eq!(
        read_body(response.into_body()).await,
        format!("s3gredo|{username}")
    );
}

#[tokio::test]
async fn sessao_remota_autenticada_injeta_segredo_e_usuario_no_node() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(header_echo_upstream(counter.clone())).await;

    let (token, username) = new_session(&pool).await;
    let state = state(&format!("http://{upstream}"), Some("s3gredo")).with_db(pool.clone());

    // `Authorization: Bearer` tem prioridade sobre o cookie: teste usa só bearer
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers.insert("x-tania-proxy", HeaderValue::from_static("forjado"));
    headers.insert("x-tania-user", HeaderValue::from_static("outra-pessoa"));

    let response = call_proxy_with_headers(
        state,
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        remote(),
        None,
        headers,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);
    assert_eq!(
        read_body(response.into_body()).await,
        format!("s3gredo|{username}")
    );
}

#[tokio::test]
async fn sem_segredo_nada_e_injetado_e_headers_forgados_caem() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(header_echo_upstream(counter.clone())).await;

    let (token, _username) = new_session(&pool).await;
    // `legacy_proxy_secret = None`: o Rust não manda segredo nenhum ao Node
    let state = state(&format!("http://{upstream}"), None).with_db(pool.clone());

    let mut headers = HeaderMap::new();
    headers.insert("x-tania-proxy", HeaderValue::from_static("forjado"));
    headers.insert("x-tania-user", HeaderValue::from_static("outra-pessoa"));

    let response = call_proxy_with_headers(
        state,
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        remote(),
        Some(&format!("vault_session={token}")),
        headers,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);
    assert_eq!(read_body(response.into_body()).await, "-|-");
}

#[tokio::test]
async fn sessao_invalida_de_cliente_remoto_e_401_sem_tocar_o_node() {
    let Some(pool) = pool().await else {
        return;
    };
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(echo_upstream(counter.clone())).await;

    let state = state(&format!("http://{upstream}"), Some("s3gredo")).with_db(pool.clone());

    let response = call_proxy(
        state,
        Method::GET,
        "/api/agent/status",
        Body::empty(),
        remote(),
        Some("vault_session=token-que-nao-existe-no-banco"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "401 não repassa ao Node"
    );
}

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).expect("json")
}
