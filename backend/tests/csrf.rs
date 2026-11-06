//! CSRF por Content-Type. Usa o mesmo upstream falso e um estado SEM banco:
//! sem Postgres o portão só deixa entrar loopback, e todas as chamadas destes
//! testes são loopback — o csrf continua valendo, sem nenhuma sessão. O
//! contador prova se o middleware barrou antes do proxy.

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
use tower::ServiceExt;

use tania::config::Config;
use tania::http::{router, AppState};

/// Portão + proxy apontando para um upstream falso que ecoa e conta chamadas.
/// `db: None` (nunca se liga um pool aqui): remoto recebe 503, loopback entra.
fn state(upstream: &str, rate_max: u32) -> AppState {
    AppState::new(
        Config {
            legacy_upstream: upstream.to_string(),
            rate_limit_max: rate_max,
            rate_limit_window_ms: 60_000,
            ..Config::default()
        },
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

async fn spawn_upstream(counter: Arc<AtomicUsize>) -> SocketAddr {
    let app = Router::new().fallback(any(move |request: Request| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::Relaxed);
            let method = request.method().to_string();
            let uri = request.uri().to_string();
            let body = read_body(request.into_body()).await;
            axum::Json(serde_json::json!({ "method": method, "uri": uri, "body": body }))
                .into_response()
        }
    }));
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
    client: SocketAddr,
    method: Method,
    uri: &str,
    body: Body,
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

fn headers(content_type: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(value) = content_type {
        headers.insert(
            "content-type",
            HeaderValue::from_str(value).expect("content-type header"),
        );
    }
    headers
}

fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 4321))
}

fn remote() -> SocketAddr {
    SocketAddr::from(([10, 0, 0, 5], 1234))
}

fn json_body() -> Body {
    Body::from(r#"{"path":"00-Inbox/x.md","content":"oi"}"#)
}

// --- 1) POST com text/plain: 415, o Node não é tocado -------------------------
#[tokio::test]
async fn post_com_text_plain_devolve_415_sem_tocar_o_node() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 300);

    let response = call(
        state,
        loopback(),
        Method::POST,
        "/api/finance/resumo",
        Body::from("texto solto"),
        headers(Some("text/plain")),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        response.headers()["content-type"],
        HeaderValue::from_static("application/json; charset=utf-8")
    );
    let body = read_body(response.into_body()).await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).expect("json"),
        serde_json::json!({ "ok": false, "error": "Content-Type deve ser application/json" })
    );
    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "415 não repassa ao Node"
    );
}

// --- 2) POST sem Content-Type também é barrado ---------------------------------
#[tokio::test]
async fn post_sem_content_type_tambem_e_barrado() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 300);

    let response = call(
        state,
        loopback(),
        Method::POST,
        "/api/finance/resumo",
        json_body(),
        headers(None),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(counter.load(Ordering::Relaxed), 0);
}

// --- 3) POST com application/json chega ao upstream -----------------------------
#[tokio::test]
async fn post_com_application_json_chega_ao_upstream() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 300);

    // charset e maiúsculas não incomodam: basta começar com application/json
    for content_type in ["application/json", "application/json; charset=utf-8"] {
        let response = call(
            state.clone(),
            loopback(),
            Method::POST,
            "/api/finance/resumo",
            json_body(),
            headers(Some(content_type)),
        )
        .await;
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "content-type {content_type} deveria passar"
        );
        read_body(response.into_body()).await;
    }
    assert_eq!(counter.load(Ordering::Relaxed), 2);
}

// --- 4) PUT /api/files/* com octet-stream passa pelo csrf ---------------------
#[tokio::test]
async fn put_de_anexo_octet_stream_passa_pelo_csrf() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 300);

    // F2b-2b: `PUT /api/files/{*rel}` é respondido pelo Rust, não pelo Node.
    // O teste segue provando o que lhe compete: o csrf não barra o anexo
    // octet-stream (barra só o que não é JSON) — quem responde é o handler.
    let rel = "00-Inbox/anexo.png";
    let on_disk = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(rel);
    std::fs::create_dir_all(on_disk.parent().expect("parent da rel de teste"))
        .expect("pasta do fixture");
    std::fs::remove_file(&on_disk).ok();

    let response = call(
        state,
        loopback(),
        Method::PUT,
        "/api/files/00-Inbox/anexo.png",
        Body::from("\u{89}PNG\u{0a}\u{1a}\u{04}"),
        headers(Some("application/octet-stream")),
    )
    .await;

    assert_eq!(
        response.status(),
        StatusCode::CREATED,
        "octet-stream não deveria ser barrado pelo csrf"
    );
    assert_eq!(
        counter.load(Ordering::Relaxed),
        0,
        "upload não repassa ao Node"
    );
}

// --- 5) GET sem content-type chega ao upstream ----------------------------------
#[tokio::test]
async fn get_sem_content_type_chega_ao_upstream() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 300);

    let response = call(
        state,
        loopback(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        headers(None),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        counter.load(Ordering::Relaxed),
        1,
        "GET não é barrado pelo csrf"
    );
}

// --- 6) ordem: gate -> rate limit -> csrf ----------------------------------------
#[tokio::test]
async fn gate_e_rate_limit_ven_antes_do_csrf() {
    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;
    let state = state(&format!("http://{upstream}"), 1);

    // remoto sem banco: o portão responde 503 antes de o csrf ver o content-type
    let response = call(
        state.clone(),
        remote(),
        Method::POST,
        "/api/finance/resumo",
        Body::from("oi"),
        headers(Some("text/plain")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(counter.load(Ordering::Relaxed), 0);

    // loopback, cap de 1: uma GET consome a janela e o POST text/plain seguinte
    // cai no 429 do rate limit, não no 415 do csrf
    let response = call(
        state.clone(),
        loopback(),
        Method::GET,
        "/api/finance/resumo",
        Body::empty(),
        headers(None),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(counter.load(Ordering::Relaxed), 1);

    let response = call(
        state,
        loopback(),
        Method::POST,
        "/api/finance/resumo",
        Body::from("oi"),
        headers(Some("text/plain")),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        counter.load(Ordering::Relaxed),
        1,
        "429 não repassa ao Node"
    );
}
