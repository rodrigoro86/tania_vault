//! Testes de integração de `PUT /api/files/{*rel}` (F2b-2b), sobre o mesmo
//! fixture de `tests/vault.rs`: `LocalFs` em tempdir + upstream falso que só
//! ecoa e conta chamadas. O CSRF deixa `PUT /api/files/` passar, então um
//! 415 aqui vem do handler, não do middleware — e prova que o corpo nunca
//! chegou ao Node.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderValue, Method, StatusCode};
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
    std::fs::create_dir(dir.join("01-Agenda")).expect("01-Agenda");
    std::fs::create_dir_all(dir.join("99-Meta/attachments")).expect("attachments");
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

async fn call(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    content_type: Option<&str>,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(body)
        .expect("request");
    if let Some(value) = content_type {
        request.headers_mut().insert(
            "content-type",
            HeaderValue::from_str(value).expect("content-type header"),
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

async fn json_body(response: Response) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await).expect("json")
}

// --- upload octet-stream cria o arquivo no disco ----------------------------
#[tokio::test]
async fn octet_stream_grava_o_arquivo_e_devolve_201() {
    let fixture = fixture().await;
    let content: Vec<u8> = b"\x00\x01\x02png-bytes\x00\xff".to_vec();

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/99-Meta/attachments/foto-1.png",
        Body::from(content.clone()),
        Some("application/octet-stream"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::CREATED);
    let payload = json_body(response).await;
    assert_eq!(
        payload,
        serde_json::json!({
            "ok": true,
            "path": "99-Meta/attachments/foto-1.png",
            "created": true,
            "size": content.len(),
        })
    );

    let on_disk = std::fs::read(fixture.root.join("99-Meta/attachments/foto-1.png"))
        .expect("arquivo gravado");
    assert_eq!(on_disk, content, "conteúdo gravado difere do enviado");
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- repetir o mesmo path dá 409 --------------------------------------------
#[tokio::test]
async fn upload_repetido_dá_409_e_não_sobrescreve() {
    let fixture = fixture().await;
    let first: Vec<u8> = b"primeiro".to_vec();
    let second: Vec<u8> = b"segundo".to_vec();

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/00-Inbox/anexo.txt",
        Body::from(first.clone()),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/00-Inbox/anexo.txt",
        Body::from(second),
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload = json_body(response).await;
    assert_eq!(
        payload,
        serde_json::json!({ "ok": false, "error": "00-Inbox/anexo.txt já existe" })
    );

    // o conteúdo original permanece intacto
    let on_disk = std::fs::read(fixture.root.join("00-Inbox/anexo.txt")).expect("anexo");
    assert_eq!(on_disk, first, "o 409 sobrescreveu o arquivo");
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- content-type errado: 415 antes de qualquer leitura ---------------------
#[tokio::test]
async fn content_type_errado_dá_415_e_não_chega_ao_proxy() {
    let fixture = fixture().await;

    for content_type in ["application/json", "text/plain", "image/png"] {
        let response = call(
            fixture.state.clone(),
            Method::PUT,
            "/api/files/00-Inbox/x.png",
            Body::from(serde_json::json!({ "path": "x.png" }).to_string()),
            Some(content_type),
        )
        .await;

        assert_eq!(
            response.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{content_type} deveria dar 415"
        );
        let payload = json_body(response).await;
        assert_eq!(
            payload,
            serde_json::json!({
                "ok": false,
                "error": "Content-Type deve ser application/octet-stream"
            })
        );
        // o CSRF deixa PUT /api/files passar: o 415 é do handler, e o Node
        // nunca viu a chamada
        assert_eq!(
            fixture.upstream_calls.load(Ordering::Relaxed),
            0,
            "{content_type}"
        );
    }
    assert!(
        !fixture.root.join("00-Inbox/x.png").exists(),
        "escreveu mesmo barrado"
    );
}

// --- nome não-ASCII: 400 ------------------------------------------------------
#[tokio::test]
async fn nome_com_espaço_e_acento_dá_400() {
    let fixture = fixture().await;

    // axum percent-decodifica o wildcard: a URL chega como "a/minha foto.png"
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/a/minha%20foto.png",
        Body::from("conteúdo"),
        Some("application/octet-stream"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let payload = json_body(response).await;
    assert_eq!(
        payload["error"],
        serde_json::json!("\"minha foto.png\": use nome ASCII, sem espaço nem acento (hyphens)")
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
    assert!(
        !fixture.root.join("a").exists(),
        "path barrado criou a pasta 'a'"
    );
}

// --- extensão fora da lista: 415 --------------------------------------------
#[tokio::test]
async fn extensão_nao_suportada_dá_415() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/a/x.exe",
        Body::from("binário suspeito"),
        Some("application/octet-stream"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let payload = json_body(response).await;
    assert_eq!(
        payload,
        serde_json::json!({ "ok": false, "error": "a/x.exe: tipo de arquivo não suportado" })
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
    assert!(!fixture.root.join("a/x.exe").exists(), "x.exe foi gravado");
}

// --- corpo de 3 MB: o limite padrão do axum (2 MB) não corta ----------------
#[tokio::test]
async fn corpo_de_3_mb_é_aceito() {
    let fixture = fixture().await;
    let content = vec![0x5a_u8; 3 * 1024 * 1024];

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/files/99-Meta/attachments/grande.pdf",
        Body::from(content.clone()),
        Some("application/octet-stream"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::CREATED);
    let payload = json_body(response).await;
    assert_eq!(payload["size"], serde_json::json!(content.len()));

    let on_disk =
        std::fs::read(fixture.root.join("99-Meta/attachments/grande.pdf")).expect("arquivo grande");
    assert_eq!(on_disk, content, "corpo de 3 MB foi truncado");
}
