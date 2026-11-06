//! Testes de integração de `GET/HEAD /files/{*rel}` (F2b-2c), sobre o mesmo
//! fixture de `tests/upload.rs`: `LocalFs` em tempdir + upstream falso que só
//! ecoa e conta chamadas. Nada aqui deve chegar ao Node: o Rust decide 200,
//! 206, 304, 404, 405, 415 e 416 sozinho.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tempfile::TempDir;
use tower::ServiceExt;

use tania::config::Config;
use tania::http::{router, AppState};
use tania::storage::local::LocalFs;
use tania::storage::Store;

struct Fixture {
    root: PathBuf,
    state: AppState,
    upstream_calls: Arc<AtomicUsize>,
    _dir: TempDir,
}

async fn spawn_upstream(counter: Arc<AtomicUsize>) -> SocketAddr {
    let app = Router::new().fallback(any(move |request: Request| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::Relaxed);
            let method = request.method().to_string();
            let uri = request.uri().to_string();
            let body = body_text(request.into_body()).await;
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

fn write_fixture(dir: &std::path::Path) {
    std::fs::write(dir.join("Home.md"), "# Home\n").expect("Home.md");
    std::fs::create_dir(dir.join("00-Inbox")).expect("00-Inbox");
    std::fs::create_dir_all(dir.join("a")).expect("a");
    // 10 bytes: "0123456789" — tudo que um Range precisa para ser conferido
    std::fs::write(dir.join("a/f.png"), b"0123456789").expect("a/f.png");
    std::fs::write(
        dir.join("a/p.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    )
    .expect("a/p.svg");
    std::fs::write(dir.join("a/d.docx"), b"docx-fake").expect("a/d.docx");
}

async fn fixture() -> Fixture {
    let dir = TempDir::new().expect("tempdir");
    write_fixture(dir.path());

    let counter = Arc::new(AtomicUsize::new(0));
    let upstream = spawn_upstream(counter.clone()).await;

    Fixture {
        root: dir.path().to_path_buf(),
        upstream_calls: counter,
        state: AppState::new(
            Config {
                legacy_upstream: format!("http://{upstream}"),
                // sem banco (`database_url: None`) o portão só deixa loopback,
                // e todas as chamadas deste fixture são loopback
                ..Config::default()
            },
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("cliente reqwest"),
            Store::Local(LocalFs::new(dir.path().to_str().expect("tempdir em utf-8"))),
        ),
        _dir: dir,
    }
}

async fn call(state: AppState, method: Method, uri: &str, headers: &[(&str, &str)]) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("request");
    for &(name, value) in headers {
        request.headers_mut().insert(
            HeaderName::from_bytes(name.as_bytes()).expect("header name"),
            HeaderValue::from_str(value).expect("header"),
        );
    }
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4321))));
    router(state).oneshot(request).await.expect("resposta")
}

async fn body_text(body: Body) -> String {
    let bytes = body.collect().await.expect("corpo").to_bytes();
    String::from_utf8(bytes.to_vec()).expect("utf-8")
}

fn header(response: &Response, name: &str) -> String {
    response
        .headers()
        .get(name)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).to_string())
        .unwrap_or_default()
}

// --- GET normal: 200, mime, inline, ETag e corpo -----------------------------
#[tokio::test]
async fn get_imagem_devolve_200_com_etag_e_corpo() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::GET, "/files/a/f.png", &[]).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(header(&response, "content-type"), "image/png");
    assert_eq!(header(&response, "cache-control"), "private, no-cache");
    assert_eq!(header(&response, "accept-ranges"), "bytes");
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    assert!(
        header(&response, "content-disposition") == "inline; filename*=UTF-8''f.png",
        "disposition = {}",
        header(&response, "content-disposition")
    );
    let etag = header(&response, "etag");
    assert!(
        etag.starts_with("W/\"10-") && etag.ends_with('"'),
        "etag = {etag}"
    );
    assert!(!header(&response, "last-modified").is_empty());
    assert_eq!(header(&response, "content-length"), "10");
    assert_eq!(body_text(response.into_body()).await, "0123456789");
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- if-none-match bate o ETag: 304 sem corpo --------------------------------
#[tokio::test]
async fn if_none_match_devolve_304_sem_corpo() {
    let fixture = fixture().await;

    let first = call(fixture.state.clone(), Method::GET, "/files/a/f.png", &[]).await;
    let etag = header(&first, "etag");
    assert_eq!(body_text(first.into_body()).await, "0123456789");

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/f.png",
        &[("if-none-match", &etag)],
    )
    .await;

    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(header(&response, "etag"), etag);
    assert_eq!(header(&response, "content-type"), "image/png");
    assert!(body_text(response.into_body()).await.is_empty());
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- Range: 206 com Content-Range e só os bytes pedidos -----------------------
#[tokio::test]
async fn range_delimitado_devolve_206_e_o_fragmento() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/f.png",
        &[("range", "bytes=2-4")],
    )
    .await;

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&response, "content-range"), "bytes 2-4/10");
    assert_eq!(header(&response, "content-length"), "3");
    assert_eq!(body_text(response.into_body()).await, "234");
}

#[tokio::test]
async fn range_de_sufixo_devolve_os_ultimos_bytes() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/f.png",
        &[("range", "bytes=-3")],
    )
    .await;

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(&response, "content-range"), "bytes 7-9/10");
    assert_eq!(body_text(response.into_body()).await, "789");
}

#[tokio::test]
async fn range_fora_do_arquivo_da_416() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/f.png",
        &[("range", "bytes=20-")],
    )
    .await;

    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(header(&response, "content-range"), "bytes */10");
    assert!(body_text(response.into_body()).await.is_empty());
}

#[tokio::test]
async fn range_fora_do_formato_servi_o_arquivo_inteiro() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/f.png",
        &[("range", "bytes=1-4-5")],
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(header(&response, "content-length"), "10");
    assert_eq!(body_text(response.into_body()).await, "0123456789");
}

// --- HEAD: headers completos, corpo vazio ------------------------------------
#[tokio::test]
async fn head_devolve_headers_sem_corpo() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::HEAD, "/files/a/f.png", &[]).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(header(&response, "content-length"), "10");
    assert_eq!(header(&response, "content-type"), "image/png");
    assert!(body_text(response.into_body()).await.is_empty());
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- método errado: 405 de texto ----------------------------------------------
#[tokio::test]
async fn post_em_files_da_405_de_texto() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::POST, "/files/a/f.png", &[]).await;

    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        header(&response, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    assert_eq!(
        body_text(response.into_body()).await,
        "método não permitido"
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- path barrado: 403 / 415 ---------------------------------------------------
#[tokio::test]
async fn pasta_oculta_e_pasta_fora_do_vault_da_403() {
    let fixture = fixture().await;

    for (uri, message) in [
        ("/files/.env", ".env não faz parte do vault"),
        ("/files/app/x.png", "app/x.png não faz parte do vault"),
    ] {
        let response = call(fixture.state.clone(), Method::GET, uri, &[]).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(
            header(&response, "content-type"),
            "text/plain; charset=utf-8"
        );
        assert_eq!(body_text(response.into_body()).await, message);
    }
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn extensao_nao_suportada_da_415() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::GET, "/files/a/x.exe", &[]).await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        header(&response, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        body_text(response.into_body()).await,
        "a/x.exe: tipo de arquivo não suportado"
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- arquivo que não existe: 404 de texto, com nosniff ------------------------
#[tokio::test]
async fn arquivo_inexistente_da_404_de_texto_com_nosniff() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::GET, "/files/a/nao.png", &[]).await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        header(&response, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    assert_eq!(
        body_text(response.into_body()).await,
        "a/nao.png não existe"
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- SVG: CSP sandbox; docx: attachment ---------------------------------------
#[tokio::test]
async fn svg_vem_com_csp_sandbox() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::GET, "/files/a/p.svg", &[]).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(header(&response, "content-type"), "image/svg+xml");
    let csp = header(&response, "content-security-policy");
    assert!(csp.contains("sandbox"), "csp = {csp}");
    assert!(csp.contains("allow-scripts"), "csp = {csp}");
}

#[tokio::test]
async fn docx_vem_com_attachment() {
    let fixture = fixture().await;

    let response = call(fixture.state.clone(), Method::GET, "/files/a/d.docx", &[]).await;

    assert_eq!(response.status(), StatusCode::OK);
    let disposition = header(&response, "content-disposition");
    assert!(
        disposition.starts_with("attachment; filename*=UTF-8''d.docx"),
        "disposition = {disposition}"
    );
    assert_eq!(body_text(response.into_body()).await, "docx-fake");
}

// --- nome com caractere especial: percent-encoding de encodeURIComponent ------
#[tokio::test]
async fn nome_com_espaço_e_acento_é_percent_encoded_no_disposition() {
    let fixture = fixture().await;
    std::fs::write(fixture.root.join("a/minha foto é.png"), b"x").expect("nome difícil");

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/files/a/minha%20foto%20%C3%A9.png",
        &[],
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        header(&response, "content-disposition"),
        "inline; filename*=UTF-8''minha%20foto%20%C3%A9.png"
    );
    assert_eq!(header(&response, "content-length"), "1");
    assert_eq!(body_text(response.into_body()).await, "x");
}
