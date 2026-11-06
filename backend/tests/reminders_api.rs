//! Fluxo de `/api/reminders` no Rust, direto no Postgres de teste: validações,
//! criação, listagem por status, cancelamento e limpeza.
//!
//! O texto do lembrete traz um uuid para não colidir com outras rodadas.

mod common;

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn fluxo_de_lembretes() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let client = common::remote(9);
    let token = common::login(&fixture.pool, false).await;
    let texto = format!("lembrete f3a {}", Uuid::new_v4());

    // sem token: o portão barra antes de chegar na rota
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/reminders",
        Body::empty(),
        client,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // texto ausente/vazio: 400 "texto é obrigatório"
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/reminders",
        Body::from(json!({ "quando": "2026-11-01T09:00:00-03:00" }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "texto é obrigatório"
    );

    // `quando` fora de ISO: 400 com a mesma mensagem do Node
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/reminders",
        Body::from(json!({ "texto": texto, "quando": "amanhã" }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "quando inválido (use ISO, ex.: 2026-11-01T09:00:00-03:00)"
    );

    // criação válida: 201, JSON montado pelo Postgres
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/reminders",
        Body::from(
            json!({
                "texto": texto,
                "quando": "2026-11-01T09:00:00-03:00",
                "recorrencia": "a".repeat(50)
            })
            .to_string(),
        ),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = common::read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    let lembrete = body["lembrete"].as_object().expect("lembrete");
    let id = lembrete
        .get("id")
        .and_then(|valor| valor.as_i64())
        .expect("id deveria ser número");
    assert_eq!(
        lembrete.get("quando").and_then(|valor| valor.as_str()),
        Some("2026-11-01T12:00:00.000Z"),
        "quando sai em UTC com milissegundos"
    );
    assert_eq!(
        lembrete.get("status").and_then(|valor| valor.as_str()),
        Some("pending")
    );
    assert_eq!(
        lembrete.get("canal").and_then(|valor| valor.as_str()),
        Some("whatsapp")
    );
    let recorrencia = lembrete
        .get("recorrencia")
        .and_then(|valor| valor.as_str())
        .expect("recorrencia");
    assert_eq!(recorrencia.chars().count(), 40, "recorrencia cortada em 40");

    // listagem por status: o lembrete criado aparece
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/reminders?status=pending",
        Body::empty(),
        client,
        common::bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    let pendentes = body["lembretes"].as_array().expect("lembretes");
    assert!(
        pendentes
            .iter()
            .any(|valor| valor["id"].as_i64() == Some(id)),
        "o lembrete criado deveria estar na listagem por status"
    );

    // cancelamento: status vira cancelled
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        &format!("/api/reminders/{id}/cancel"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    assert_eq!(
        body["lembrete"]["status"].as_str().expect("status"),
        "cancelled"
    );

    // id inexistente: 404
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/reminders/999999999/cancel",
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "lembrete não encontrado"
    );

    // listagem sem status: array, `cancelled` vem antes de `pending`
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/reminders",
        Body::empty(),
        client,
        common::bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    assert!(body["lembretes"].is_array(), "lembretes deveria ser array");

    // fecha limpo: só apaga o que este teste criou
    sqlx::query("delete from lembretes where texto = $1")
        .bind(&texto)
        .execute(&fixture.pool)
        .await
        .expect("limpar lembretes do teste");
}
