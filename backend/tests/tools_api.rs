//! Testes de integração de `/api/tools`: cadastro, leitura do manifesto,
//! edição, exclusão e o 503 sem `TANIA_CONFIG_KEY`. Precisam de
//! `TEST_DATABASE_URL`; sem ela são pulados.
//!
//! A "tool falsa" é um mini-servidor axum numa porta efêmera local: responde
//! `GET /manifest.json` só com `x-tania-tool-secret: s1`, e 401 sem ele. Toda
//! tool criada pelo teste é apagada no fim.

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use serde_json::json;
use uuid::Uuid;

use tania::settings::crypto::Cifra;
use tania::tools::repo;

mod common;

/// Chave de cifra de teste (32 × 0x01), a mesma do vetor da spec.
const CIFRA_TESTE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

/// `ext-` + 8 chars do uuid: id válido e único a cada rodada.
fn novo_id() -> String {
    format!("ext-{}", &Uuid::new_v4().simple().to_string()[..8])
}

/// Tool falsa servida numa porta local efêmera; o manifesto traz o `id` dado.
/// Devolve a URL base.
async fn ferramenta_falsa(id: &str) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener local");
    let addr: SocketAddr = listener.local_addr().expect("addr local");

    let id = id.to_string();
    let app = axum::Router::new().route(
        "/manifest.json",
        get(move |headers: HeaderMap| {
            let id = id.clone();
            async move {
                let segredo = headers
                    .get("x-tania-tool-secret")
                    .and_then(|value| value.to_str().ok());
                if segredo != Some("s1") {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "ok": false, "error": "sem segredo" })),
                    )
                        .into_response();
                }
                Json(json!({
                    "id": id,
                    "nome": "Falsa",
                    "icone": "🧪",
                    "paginas": [{ "id": "inicio", "titulo": "Início" }],
                }))
                .into_response()
            }
        }),
    );

    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("tool falsa: {err}");
        }
    });

    format!("http://{addr}")
}

/// Item de uma tool na resposta do `GET /api/tools`.
fn item_da_tools(body: &serde_json::Value, id: &str) -> serde_json::Value {
    body["tools"]
        .as_array()
        .expect("lista de tools")
        .iter()
        .find(|item| item["id"].as_str() == Some(id))
        .cloned()
        .unwrap_or_else(|| panic!("tool {id} não está na lista"))
}

async fn post(
    state: tania::http::AppState,
    uri: &str,
    corpo: &serde_json::Value,
    token: &str,
    client: SocketAddr,
) -> axum::response::Response {
    common::call(
        state,
        Method::POST,
        uri,
        Body::from(corpo.to_string()),
        client,
        common::json_bearer(token),
    )
    .await
}

// --- 1) fluxo: criar, ler, desativar, apagar ---------------------------------

#[tokio::test]
async fn fluxo_de_cadastro_e_leitura() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let state = fixture
        .state
        .clone()
        .with_cifra(Cifra::from_base64(CIFRA_TESTE));
    let client = common::remote(11);

    let admin = common::login(&fixture.pool, true).await;
    let usuario = common::login(&fixture.pool, false).await;
    let id = novo_id();
    let corpo = json!({ "id": id, "url": "http://127.0.0.1:9", "segredo": "s1" });

    // não admin não cadastra
    let response = post(state.clone(), "/api/tools", &corpo, &usuario, client).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // admin cadastra; repetir é 409
    let response = post(state.clone(), "/api/tools", &corpo, &admin, client).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(common::read_json(response).await["ok"], json!(true));

    let response = post(state.clone(), "/api/tools", &corpo, &admin, client).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);

    // admin vê a url, o erro do manifesto e nunca o segredo
    let response = common::call(
        state.clone(),
        Method::GET,
        "/api/tools",
        Body::empty(),
        client,
        common::bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let item = item_da_tools(&common::read_json(response).await, &id);
    assert_eq!(item["origem"], json!("banco"));
    assert_eq!(item["ativo"], json!(true));
    assert!(item["manifest"].is_null());
    let erro = item["erro"].as_str().expect("erro do manifesto");
    assert!(!erro.is_empty());
    assert_eq!(item["url"].as_str(), Some("http://127.0.0.1:9"));
    assert!(item.get("segredo").is_none(), "o segredo nunca sai");

    // não admin vê a tool, mas sem a url
    let response = common::call(
        state.clone(),
        Method::GET,
        "/api/tools",
        Body::empty(),
        client,
        common::bearer(&usuario),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let item = item_da_tools(&common::read_json(response).await, &id);
    assert!(item.get("url").is_none(), "url só para admin");

    // desativar: 200 e o GET mostra `ativo: false`
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
        "/api/tools",
        Body::empty(),
        client,
        common::bearer(&admin),
    )
    .await;
    assert_eq!(
        item_da_tools(&common::read_json(response).await, &id)["ativo"],
        json!(false)
    );

    // apagar; apagar de novo é 404
    let response = common::call(
        state.clone(),
        Method::DELETE,
        &format!("/api/tools/{id}"),
        Body::empty(),
        client,
        common::json_bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = common::call(
        state.clone(),
        Method::DELETE,
        &format!("/api/tools/{id}"),
        Body::empty(),
        client,
        common::json_bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    repo::apagar(&fixture.pool, &id)
        .await
        .expect("limpar a tool do teste");
}

// --- 2) manifesto: id certo e id errado --------------------------------------

#[tokio::test]
async fn manifesto_da_tool_falsa() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let state = fixture
        .state
        .clone()
        .with_cifra(Cifra::from_base64(CIFRA_TESTE));
    let client = common::remote(12);
    let admin = common::login(&fixture.pool, true).await;

    // a tool cujo id bate com o do manifesto
    let id = novo_id();
    let url = ferramenta_falsa(&id).await;
    let response = post(
        state.clone(),
        "/api/tools",
        &json!({ "id": id, "url": url, "segredo": "s1" }),
        &admin,
        client,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    // outra tool, mesma url, id diferente do do manifesto
    let outro = novo_id();
    let response = post(
        state.clone(),
        "/api/tools",
        &json!({ "id": outro, "url": url, "segredo": "s1" }),
        &admin,
        client,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = common::call(
        state.clone(),
        Method::GET,
        "/api/tools",
        Body::empty(),
        client,
        common::bearer(&admin),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;

    let item = item_da_tools(&body, &id);
    assert_eq!(item["manifest"]["nome"].as_str(), Some("Falsa"));

    let item = item_da_tools(&body, &outro);
    assert!(item["manifest"].is_null());
    let erro = item["erro"].as_str().expect("erro do manifesto");
    assert!(erro.contains("id"), "erro deveria falar do id: {erro}");

    for id in [id, outro] {
        repo::apagar(&fixture.pool, &id)
            .await
            .expect("limpar a tool do teste");
    }
}

// --- 3) sem TANIA_CONFIG_KEY não se cadastra -----------------------------------

#[tokio::test]
async fn cadastro_sem_cifra_da_503() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let client = common::remote(13);
    let admin = common::login(&fixture.pool, true).await;

    let response = post(
        fixture.state.clone(),
        "/api/tools",
        &json!({ "id": novo_id(), "url": "http://127.0.0.1:9", "segredo": "s1" }),
        &admin,
        client,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        common::read_json(response).await["error"]
            .as_str()
            .expect("error"),
        "defina TANIA_CONFIG_KEY para cadastrar tools"
    );
}
