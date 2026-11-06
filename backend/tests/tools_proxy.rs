//! Proxy `/tools/{id}/(ui|api)/*`: a tool recebe o caminho cru, a query, o corpo e
//! os headers da Tania (nunca os forjados pelo cliente, nem o cookie/bearer), e
//! caminhos fora de `ui/`/`api/` não chegam a ela.
//!
//! Requer `TEST_DATABASE_URL`; sem ela o teste é pulado.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::Json;
use http_body_util::BodyExt;
use serde_json::json;
use uuid::Uuid;

use tania::settings::crypto::Cifra;
use tania::tools::repo;

mod common;

const CIFRA_TESTE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

/// Tool que ecoa o que recebeu e conta as chamadas.
async fn tool_eco(chamadas: Arc<AtomicUsize>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener local");
    let addr: SocketAddr = listener.local_addr().expect("addr local");
    let app = axum::Router::new().fallback(move |request: Request| {
        let chamadas = chamadas.clone();
        async move {
            chamadas.fetch_add(1, Ordering::SeqCst);
            let (parts, body) = request.into_parts();
            let h = |n: &str| -> String {
                parts
                    .headers
                    .get(n)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            };
            let mut eco = json!({
                "method": parts.method.as_str(),
                "path": parts.uri.path(),
                "query": parts.uri.query().unwrap_or(""),
                "secret": h("x-tania-tool-secret"),
                "user": h("x-tania-user"),
                "admin": h("x-tania-admin"),
                "cookie": h("cookie"),
                "authorization": h("authorization"),
            });
            let corpo = body.collect().await.expect("corpo").to_bytes();
            eco["body"] = json!(String::from_utf8_lossy(&corpo));
            (StatusCode::IM_A_TEAPOT, Json(eco))
        }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn bearer_com(token: &str, extra: &[(&'static str, &str)]) -> HeaderMap {
    let mut headers = common::bearer(token);
    for (nome, valor) in extra {
        headers.insert(*nome, HeaderValue::from_str(valor).expect("header"));
    }
    headers
}

#[tokio::test]
async fn proxy_repassa_so_ui_e_api_com_os_headers_da_tania() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let state = fixture
        .state
        .clone()
        .with_cifra(Cifra::from_base64(CIFRA_TESTE));
    let client = common::remote(31);
    let admin = common::login(&fixture.pool, true).await;
    let usuario = common::login(&fixture.pool, false).await;

    let chamadas = Arc::new(AtomicUsize::new(0));
    let url = tool_eco(chamadas.clone()).await;
    let id = format!("ext-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let response = common::call(
        state.clone(),
        Method::POST,
        "/api/tools",
        Body::from(json!({ "id": id, "url": url, "segredo": "s1" }).to_string()),
        client,
        common::json_bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    // GET de página, com headers forjados pelo cliente
    let forjados = bearer_com(
        &usuario,
        &[
            ("x-tania-user", "admin"),
            ("x-tania-tool-secret", "forjado"),
            ("x-tania-admin", "1"),
        ],
    );
    let response = common::call(
        state.clone(),
        Method::GET,
        &format!("/tools/{id}/ui/tarefas?x=1"),
        Body::empty(),
        client,
        forjados,
    )
    .await;
    assert_eq!(response.status(), StatusCode::IM_A_TEAPOT);
    let eco = common::read_json(response).await;
    assert_eq!(eco["path"], "/ui/tarefas");
    assert_eq!(eco["query"], "x=1");
    assert_eq!(eco["secret"], "s1");
    assert_ne!(eco["user"], "admin");
    assert!(!eco["user"].as_str().unwrap_or("").is_empty());
    assert_eq!(eco["admin"], "0");
    assert_eq!(eco["authorization"], "");
    assert_eq!(eco["cookie"], "");

    // POST na API: corpo e status repassados; admin = 1
    let response = common::call(
        state.clone(),
        Method::POST,
        &format!("/tools/{id}/api/x"),
        Body::from("{\"a\":1}"),
        client,
        common::json_bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::IM_A_TEAPOT);
    let eco = common::read_json(response).await;
    assert_eq!(eco["method"], "POST");
    assert_eq!(eco["path"], "/api/x");
    assert_eq!(eco["body"], "{\"a\":1}");
    assert_eq!(eco["admin"], "1");

    // caminhos proibidos: 404 sem chamar a tool
    let antes = chamadas.load(Ordering::SeqCst);
    for caminho in [
        "manifest.json",
        "mcp",
        "ui/../mcp",
        "ui/%2e%2e/mcp",
        "ui%5cmcp",
    ] {
        let response = common::call(
            state.clone(),
            Method::GET,
            &format!("/tools/{id}/{caminho}"),
            Body::empty(),
            client,
            common::bearer(&admin),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{caminho}");
    }
    assert_eq!(chamadas.load(Ordering::SeqCst), antes);

    // inexistente e inativa: 404
    let response = common::call(
        state.clone(),
        Method::GET,
        "/tools/nao-existe/ui/x",
        Body::empty(),
        client,
        common::bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = common::call(
        state.clone(),
        Method::PUT,
        &format!("/api/tools/{id}"),
        Body::from(json!({ "ativo": false }).to_string()),
        client,
        common::json_bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let response = common::call(
        state.clone(),
        Method::GET,
        &format!("/tools/{id}/ui/tarefas"),
        Body::empty(),
        client,
        common::bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    repo::apagar(&fixture.pool, &id).await.expect("apaga tool");
}
