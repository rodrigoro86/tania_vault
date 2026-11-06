//! Portão do `/api/core/*` e `GET /api/core/config`: a tool entra com
//! `Authorization: Tool <id>:<segredo>` (sem sessão), e os valores de config
//! saem já decifrados — o segredo da tool nunca aparece.
//!
//! Requer `TEST_DATABASE_URL`; sem ela o teste é pulado. A "tool falsa" é um
//! mini-servidor axum local cujo manifesto declara duas chaves de config
//! (`TOKEN`, secreta; `MODO`, não). Tudo é apagado no fim.

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use serde_json::json;
use uuid::Uuid;

use tania::http::AppState;
use tania::settings::crypto::Cifra;
use tania::tools::repo;

mod common;

/// Chave de cifra de teste (32 × 0x01), a mesma do vetor da spec.
const CIFRA_TESTE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

/// `ext-` + 8 chars do uuid: id válido e único a cada rodada.
fn novo_id() -> String {
    format!("ext-{}", &Uuid::new_v4().simple().to_string()[..8])
}

/// Tool falsa com manifesto que declara `config`. Devolve a URL base.
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
                    "config": [
                        { "chave": "TOKEN", "segredo": true, "descricao": "token de acesso" },
                        { "chave": "MODO", "segredo": false, "descricao": "modo de operação" },
                    ],
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

/// `Authorization: Tool <id>:<segredo>`, sem sessão nenhuma.
fn tool_header(id: &str, segredo: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Tool {id}:{segredo}")).expect("header da tool"),
    );
    headers
}

async fn get_json(
    state: AppState,
    uri: &str,
    headers: HeaderMap,
    client: SocketAddr,
) -> (StatusCode, serde_json::Value) {
    let response = common::call(state, Method::GET, uri, Body::empty(), client, headers).await;
    (response.status(), common::read_json(response).await)
}

async fn put_json(
    state: AppState,
    uri: &str,
    corpo: &serde_json::Value,
    token: &str,
    client: SocketAddr,
) -> StatusCode {
    let response = common::call(
        state,
        Method::PUT,
        uri,
        Body::from(corpo.to_string()),
        client,
        common::json_bearer(token),
    )
    .await;
    response.status()
}

#[tokio::test]
async fn config_da_tool_passa_pelo_portao_do_core() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let state = fixture
        .state
        .clone()
        .with_cifra(Cifra::from_base64(CIFRA_TESTE));
    let client = common::remote(21);
    let admin = common::login(&fixture.pool, true).await;

    let id = novo_id();
    let url = ferramenta_falsa(&id).await;

    // cadastrar a tool falsa com segredo "s1"
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

    // 1) nada gravado ainda: as duas chaves declaradas estão indefinidas
    let (status, body) = get_json(
        state.clone(),
        &format!("/api/tools/{id}/config"),
        common::bearer(&admin),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let chaves = body["chaves"].as_array().expect("chaves do manifesto");
    assert_eq!(chaves.len(), 2);
    for chave in chaves {
        assert_eq!(
            chave["definido"],
            json!(false),
            "{chave} deveria estar indefinida"
        );
        assert!(chave.get("valor").is_none(), "indefinida não tem valor");
    }

    // 2) chave fora do manifesto → 400
    assert_eq!(
        put_json(
            state.clone(),
            &format!("/api/tools/{id}/config"),
            &json!({ "valores": { "OUTRA": "y" } }),
            &admin,
            client
        )
        .await,
        StatusCode::BAD_REQUEST
    );

    // 3) gravar as duas → 200
    assert_eq!(
        put_json(
            state.clone(),
            &format!("/api/tools/{id}/config"),
            &json!({ "valores": { "TOKEN": "abc", "MODO": "x" } }),
            &admin,
            client
        )
        .await,
        StatusCode::OK
    );

    // 4) o GET admin mostra o secreto definido, mas nunca o valor
    let (status, body) = get_json(
        state.clone(),
        &format!("/api/tools/{id}/config"),
        common::bearer(&admin),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let chaves = body["chaves"].as_array().expect("chaves");
    let token = chaves
        .iter()
        .find(|c| c["chave"].as_str() == Some("TOKEN"))
        .expect("TOKEN declarada");
    assert_eq!(token["segredo"], json!(true));
    assert_eq!(token["definido"], json!(true));
    assert!(token.get("valor").is_none(), "segredo nunca sai no GET");

    let modo = chaves
        .iter()
        .find(|c| c["chave"].as_str() == Some("MODO"))
        .expect("MODO declarada");
    assert_eq!(modo["definido"], json!(true));
    assert_eq!(modo["valor"], json!("x"));

    // 5) o core, com o segredo da tool e sem sessão: valores decifrados
    let (status, body) = get_json(
        state.clone(),
        "/api/core/config",
        tool_header(&id, "s1"),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["valores"], json!({ "TOKEN": "abc", "MODO": "x" }));

    // 6) segredo errado, sem header e só com sessão admin: todos 401
    let (status, body) = get_json(
        state.clone(),
        "/api/core/config",
        tool_header(&id, "errado"),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], json!("tool não autorizada"));

    let (status, _) = get_json(state.clone(), "/api/core/config", HeaderMap::new(), client).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = get_json(
        state.clone(),
        "/api/core/config",
        common::bearer(&admin),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 7) apagar o secreto: 200 e ele sai dos valores do core
    assert_eq!(
        put_json(
            state.clone(),
            &format!("/api/tools/{id}/config"),
            &json!({ "valores": { "TOKEN": null } }),
            &admin,
            client
        )
        .await,
        StatusCode::OK
    );

    let (status, body) = get_json(
        state.clone(),
        "/api/core/config",
        tool_header(&id, "s1"),
        client,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["valores"], json!({ "MODO": "x" }));

    repo::apagar(&fixture.pool, &id)
        .await
        .expect("limpar a tool do teste");
}
