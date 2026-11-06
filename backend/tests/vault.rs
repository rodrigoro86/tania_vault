//! Testes de integração das rotas do vault, rodando sobre um `LocalFs` em
//! tempdir e um upstream falso (o Node) que só ecoa e conta chamadas.
//!
//! Fixture: `Home.md` = "# Home\n", pastas `00-Inbox/`, `01-Agenda/` e
//! `02-Comandos/x.md`. Estado sem banco (`AppState::new`, `db: None`) + cliente
//! `127.0.0.1`: sem Postgres o portão aceita loopback, então não precisa de cookie.

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

/// Vault de teste + upstream falso. O `TempDir` fica vivo enquanto o fixture
/// vive, e `counter` prova se uma chamada chegou (ou não) ao Node.
struct Fixture {
    root: PathBuf,
    state: AppState,
    upstream_calls: Arc<AtomicUsize>,
    // o tempdir precisa viver enquanto o LocalFs grava nele
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
    std::fs::create_dir_all(dir.join("02-Comandos")).expect("02-Comandos");
    std::fs::write(dir.join("02-Comandos/x.md"), "# comandos\n").expect("x.md");
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
                // sem banco o portão deixa entrar só loopback, e todas as
                // chamadas do teste são loopback: nenhum cookie necessário
                legacy_upstream: format!("http://{upstream}"),
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

/// Uma chamada ao router. Nas escritas o `content_type` é sempre JSON: o csrf
/// exige `application/json` para todo método ≠ GET/HEAD — inclusive as DELETE,
/// como no teste de referência do Node, que manda o header nelas também.
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
    // sem banco, loopback dispensa cookie
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4321))));
    router(state).oneshot(request).await.expect("resposta")
}

async fn body_text(body: Body) -> String {
    let bytes = body.collect().await.expect("corpo").to_bytes();
    String::from_utf8(bytes.to_vec()).expect("utf-8")
}

// --- 1) health ---------------------------------------------------------------
#[tokio::test]
async fn health_reporta_storage_local() {
    let fixture = fixture().await;
    let response = call(
        fixture.state,
        Method::GET,
        "/api/health",
        Body::empty(),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(body["ok"], serde_json::json!(true));
    assert_eq!(body["storage"], serde_json::json!("local"));
    assert_eq!(body["backend"], serde_json::json!("rust"));
}

// --- 2) traversal e pastas fora do vault -----------------------------------
#[tokio::test]
async fn traversal_e_pastas_protegidas_sao_bloqueadas() {
    let fixture = fixture().await;
    let blocked = [
        ("../Home.md", StatusCode::BAD_REQUEST),
        ("00-Inbox/../01-Agenda/x.md", StatusCode::BAD_REQUEST),
        ("%2e%2e/Home.md", StatusCode::BAD_REQUEST),
        (".git/config.md", StatusCode::FORBIDDEN),
        (".obsidian/x.md", StatusCode::FORBIDDEN),
        ("app/x.md", StatusCode::FORBIDDEN),
        ("AGENTS.md", StatusCode::FORBIDDEN),
        ("99-Meta/attachments/x.txt", StatusCode::BAD_REQUEST),
        ("Leitura.txt", StatusCode::BAD_REQUEST),
    ];

    for (path, expected) in blocked {
        let body = serde_json::json!({ "path": path, "content": "# x" });
        let response = call(
            fixture.state.clone(),
            Method::POST,
            "/api/notes",
            Body::from(body.to_string()),
            Some("application/json"),
        )
        .await;

        assert_eq!(
            response.status(),
            expected,
            "{path} deveria dar {expected}, deu {}",
            response.status()
        );
        let payload =
            serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
                .expect("json");
        assert_eq!(payload["ok"], serde_json::json!(false), "{path}");
        assert!(
            !payload["error"].as_str().unwrap_or_default().is_empty(),
            "{path} deveria devolver uma mensagem de erro"
        );
    }

    // nada foi escrito: Home.md continua "# Home\n"
    let home = std::fs::read_to_string(fixture.root.join("Home.md")).expect("Home.md");
    assert_eq!(home, "# Home\n", "Home.md foi tocado por um path bloqueado");
    assert!(
        std::fs::read_dir(fixture.root.join("00-Inbox"))
            .expect("00-Inbox")
            .next()
            .is_none(),
        "nenhuma nota entrou em 00-Inbox"
    );
    assert!(
        !fixture.root.join("Leitura.txt").exists(),
        "Leitura.txt foi criado"
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- 3) pasta nova na raiz aceita nota dentro ------------------------------
#[tokio::test]
async fn pasta_nova_na_raiz_aceita_nota_dentro() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/folders",
        Body::from(serde_json::json!({ "path": "Minha-Pasta" }).to_string()),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(created["path"], serde_json::json!("Minha-Pasta"));

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/notes",
        Body::from(
            serde_json::json!({ "path": "Minha-Pasta/x.md", "content": "# x\n" }).to_string(),
        ),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let inside =
        std::fs::read_to_string(fixture.root.join("Minha-Pasta/x.md")).expect("nota dentro");
    assert_eq!(inside, "# x\n");
}

// --- 4) create -> conflito -> edit -> rename -> delete ---------------------
#[tokio::test]
async fn ciclo_de_nota_create_conflito_edit_rename_delete() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/notes",
        Body::from(
            serde_json::json!({ "path": "00-Inbox/Nota.md", "content": "# Nota\n" }).to_string(),
        ),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(payload["created"], serde_json::json!(true));
    assert!(
        fixture.root.join("00-Inbox/Nota.md").exists(),
        "POST criou a nota"
    );

    // POST de novo: 409 "{rel} já existe"
    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/notes",
        Body::from(
            serde_json::json!({ "path": "00-Inbox/Nota.md", "content": "# outro\n" }).to_string(),
        ),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(
        payload["error"],
        serde_json::json!("00-Inbox/Nota.md já existe")
    );

    // PUT: 200, conteúdo trocado
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/notes",
        Body::from(
            serde_json::json!({ "path": "00-Inbox/Nota.md", "content": "# Nota editada\n" })
                .to_string(),
        ),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let edited =
        std::fs::read_to_string(fixture.root.join("00-Inbox/Nota.md")).expect("nota editada");
    assert_eq!(edited, "# Nota editada\n");

    // rename para 01-Agenda/Nota.md
    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/rename",
        Body::from(
            serde_json::json!({ "from": "00-Inbox/Nota.md", "to": "01-Agenda/Nota.md" })
                .to_string(),
        ),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(
        payload,
        serde_json::json!({"ok": true, "from": "00-Inbox/Nota.md", "to": "01-Agenda/Nota.md"})
    );
    assert!(
        !fixture.root.join("00-Inbox/Nota.md").exists(),
        "rename deixou o original"
    );
    assert!(
        fixture.root.join("01-Agenda/Nota.md").exists(),
        "rename moviu a nota"
    );

    // delete: 200 e arquivo sumiu
    let response = call(
        fixture.state.clone(),
        Method::DELETE,
        "/api/notes/01-Agenda/Nota.md",
        Body::empty(),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(payload["removed"], serde_json::json!(true));
    assert!(
        !fixture.root.join("01-Agenda/Nota.md").exists(),
        "DELETE não apagou o arquivo"
    );
}

// --- 5) text/plain: 415 e nada gravado -------------------------------------
#[tokio::test]
async fn post_com_text_plain_e_barrado_e_nada_e_gravado() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::POST,
        "/api/notes",
        Body::from(serde_json::json!({ "path": "Home.md", "content": "# INJETADO" }).to_string()),
        Some("text/plain"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(
        payload,
        serde_json::json!({ "ok": false, "error": "Content-Type deve ser application/json" })
    );

    // o disco não foi tocado
    let home = std::fs::read_to_string(fixture.root.join("Home.md")).expect("Home.md");
    assert_eq!(
        home, "# Home\n",
        "text/plain escreveu no vault mesmo barrado"
    );
    assert_eq!(fixture.upstream_calls.load(Ordering::Relaxed), 0);
}

// --- 6) DELETE de pasta: com conteúdo 409, vazia 200 ------------------------
#[tokio::test]
async fn delete_de_pasta_com_conteudo_e_bloqueada_no_local() {
    let fixture = fixture().await;

    let response = call(
        fixture.state.clone(),
        Method::DELETE,
        "/api/folders/02-Comandos?recursive=1",
        Body::empty(),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(
        payload["error"],
        serde_json::json!("02-Comandos/ não está vazia: no modo local apagar seria irrecuperável")
    );
    assert!(
        fixture.root.join("02-Comandos/x.md").exists(),
        "a pasta com conteúdo foi apagada"
    );

    // pasta vazia: 200 e sumiu
    std::fs::create_dir_all(fixture.root.join("01-Agenda/Vazia")).expect("pasta vazia");
    let response = call(
        fixture.state.clone(),
        Method::DELETE,
        "/api/folders/01-Agenda/Vazia",
        Body::empty(),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let payload = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(payload["removed"], serde_json::json!(true));
    assert!(
        !fixture.root.join("01-Agenda/Vazia").exists(),
        "pasta vazia não foi removida"
    );

    // pasta inexistente: 404
    let response = call(
        fixture.state,
        Method::DELETE,
        "/api/folders/99-Nada",
        Body::empty(),
        Some("application/json"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

// --- 7) GET /api/notes lista o fixture e o root é o label ------------------
#[tokio::test]
async fn lista_de_notas_mostra_o_fixture_e_o_root() {
    let fixture = fixture().await;
    let label = fixture.state.store.label();

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/notes",
        Body::empty(),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let body = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    let paths: Vec<String> = body["notes"]
        .as_array()
        .expect("notes")
        .iter()
        .map(|note| note["path"].as_str().expect("path").to_string())
        .collect();
    assert!(
        paths.contains(&"Home.md".to_string()),
        "Home.md não listado"
    );
    assert!(
        paths.contains(&"02-Comandos/x.md".to_string()),
        "02-Comandos/x.md não listado: {paths:?}"
    );
    assert_eq!(body["root"], label);
    assert_eq!(label, fixture.root.to_str().expect("root em utf-8"));
    assert_eq!(
        body["folders"],
        serde_json::json!(["00-Inbox", "01-Agenda", "02-Comandos"])
    );
}

// --- 8) GET /api/folders: método sem rota no Rust vai ao proxy --------------
#[tokio::test]
async fn get_de_folders_sem_rota_no_rust_vai_ao_proxy() {
    let fixture = fixture().await;

    let response = call(
        fixture.state,
        Method::GET,
        "/api/folders",
        Body::empty(),
        None,
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        fixture.upstream_calls.load(Ordering::Relaxed),
        1,
        "GET /api/folders deveria repassar ao Node exatamente uma vez"
    );
    let body = serde_json::from_str::<serde_json::Value>(&body_text(response.into_body()).await)
        .expect("json");
    assert_eq!(body["method"], serde_json::json!("GET"));
    assert_eq!(body["uri"], serde_json::json!("/api/folders"));
}
