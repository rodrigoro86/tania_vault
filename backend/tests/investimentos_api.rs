//! Fluxo de `/api/investimentos` no Rust: validações do POST de alertas, CRUD de
//! alertas, movimentos e acompanhadas, mais as listagens simples (ordens,
//! analises, relatorios). O banco de teste já vem migrado pelo `common`.
//!
//! O ticker é único por rodada: quatro letras saídas dos bytes do uuid, para
//! casar com `^[A-Z]{4}\d{1,2}$` (o hex do uuid tem dígitos, daí a conversão).

mod common;

use axum::body::Body;
use axum::http::{HeaderMap, Method, StatusCode};
use serde_json::json;
use uuid::Uuid;

/// Ticker de teste: quatro letras maiúsculas dos primeiros bytes do uuid + "3".
fn ticker_de_teste() -> String {
    let id = Uuid::new_v4();
    let letras: String = id
        .as_bytes()
        .iter()
        .take(4)
        .map(|byte| (b'A' + byte % 26) as char)
        .collect();
    format!("{letras}3")
}

#[tokio::test]
async fn fluxo_de_investimentos() {
    let Some(fixture) = common::fixture().await else {
        return;
    };
    let client = common::remote(12);
    let token = common::login(&fixture.pool, false).await;
    let ticker = ticker_de_teste();
    let referencia = Uuid::new_v4().simple().to_string();

    // sem token: o portão barra antes de chegar na rota
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/investimentos/alertas",
        Body::empty(),
        client,
        HeaderMap::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // ticker fora do formato da B3: 400 com a mesma mensagem do Node
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/investimentos/alertas",
        Body::from(json!({ "ticker": "xx", "tipo": "preco_acima", "valor": 12.5 }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "ticker inválido, use o código da B3 (ex.: PETR4)"
    );

    // tipo desconhecido
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/investimentos/alertas",
        Body::from(json!({ "ticker": ticker, "tipo": "nada", "valor": 12.5 }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "tipo deve ser um de: queda_dia, preco_acima, preco_abaixo"
    );

    // valor abaixo do mínimo (0.0001)
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/investimentos/alertas",
        Body::from(json!({ "ticker": ticker, "tipo": "preco_acima", "valor": 0 }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = common::read_json(response).await;
    assert_eq!(body["error"].as_str().expect("error"), "valor inválido");

    // criação válida: 201, `valor` sai número
    let response = common::call(
        fixture.state.clone(),
        Method::POST,
        "/api/investimentos/alertas",
        Body::from(json!({ "ticker": ticker, "tipo": "preco_acima", "valor": 12.5 }).to_string()),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = common::read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    let alerta = body["alerta"].as_object().expect("alerta");
    let id = alerta
        .get("id")
        .and_then(|valor| valor.as_i64())
        .expect("id deveria ser número");
    assert_eq!(
        alerta.get("valor").and_then(|valor| valor.as_f64()),
        Some(12.5),
        "valor deveria sair número"
    );
    assert_eq!(
        alerta.get("ticker").and_then(|valor| valor.as_str()),
        Some(ticker.as_str())
    );

    // listagem: o alerta ativo aparece
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/investimentos/alertas",
        Body::empty(),
        client,
        common::bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    let alertas = body["alertas"].as_array().expect("alertas");
    assert!(
        alertas.iter().any(|valor| valor["id"].as_i64() == Some(id)),
        "o alerta criado deveria estar na listagem"
    );

    // desativar: 200 e depois 404, porque `ativo` já é false
    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/alertas/{id}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/alertas/{id}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "alerta não encontrado"
    );

    // movimento `real` direto no banco: `data` sai AAAA-MM-DD e `valor` número
    let movimento = sqlx::query_scalar::<_, i64>(
        "insert into investimentos.movimentos (carteira, tipo, valor, data, ref) \
         values ('real', 'aporte', 100, '2026-01-02', $1) returning id",
    )
    .bind(&referencia)
    .fetch_one(&fixture.pool)
    .await
    .expect("insert de movimento");

    sqlx::query("insert into investimentos.acompanhadas (ticker) values ($1)")
        .bind(&ticker)
        .execute(&fixture.pool)
        .await
        .expect("insert de acompanhada");
    sqlx::query("insert into investimentos.ultimos (ticker, preco, variacao) values ($1, 20, 1.5)")
        .bind(&ticker)
        .execute(&fixture.pool)
        .await
        .expect("insert de ultimo preço");
    sqlx::query(
        "insert into investimentos.cotacoes (ticker, data, fechamento) values ($1, current_date - 40, 10)",
    )
    .bind(&ticker)
    .execute(&fixture.pool)
    .await
    .expect("insert de cotacao");

    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/investimentos/movimentos?carteira=real",
        Body::empty(),
        client,
        common::bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    let movimentos = body["movimentos"].as_array().expect("movimentos");
    let mov = movimentos
        .iter()
        .find(|valor| valor["id"].as_i64() == Some(movimento))
        .expect("movimento criado deveria estar na listagem");
    assert_eq!(
        mov["valor"].as_f64(),
        Some(100.0),
        "valor deveria sair número"
    );
    assert_eq!(mov["data"].as_str(), Some("2026-01-02"));
    assert_eq!(mov["tipo"].as_str(), Some("aporte"));

    // remover: 200 e, se repetir, 404
    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/movimentos/{movimento}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/movimentos/{movimento}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "movimento não encontrado"
    );

    // acompanhadas: preco vem de `ultimos` e a variacao_30d do histórico
    let response = common::call(
        fixture.state.clone(),
        Method::GET,
        "/api/investimentos/acompanhadas",
        Body::empty(),
        client,
        common::bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = common::read_json(response).await;
    let acompanhadas = body["acompanhadas"].as_array().expect("acompanhadas");
    let acompanhada = acompanhadas
        .iter()
        .find(|valor| valor["ticker"].as_str() == Some(ticker.as_str()))
        .expect("ticker criado deveria estar na lista");
    assert_eq!(acompanhada["preco"].as_f64(), Some(20.0));
    assert_eq!(acompanhada["variacao_30d"].as_f64(), Some(100.0));

    // deixar de acompanhar: 200 e depois 404
    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/acompanhadas/{ticker}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let response = common::call(
        fixture.state.clone(),
        Method::DELETE,
        &format!("/api/investimentos/acompanhadas/{ticker}"),
        Body::empty(),
        client,
        common::json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = common::read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "ação não está na lista"
    );

    // listagens simples: arrays mesmo sem linhas
    for (path, chave) in [
        ("/api/investimentos/ordens", "ordens"),
        ("/api/investimentos/analises?tipo=resumo", "analises"),
        ("/api/investimentos/relatorios", "relatorios"),
    ] {
        let response = common::call(
            fixture.state.clone(),
            Method::GET,
            path,
            Body::empty(),
            client,
            common::bearer(&token),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "GET {path}");
        let body = common::read_json(response).await;
        assert!(body["ok"].is_boolean(), "ok booleano em {path}");
        assert!(
            body[chave].is_array(),
            "{chave} deveria ser array em {path}"
        );
    }

    // fecha limpo: só apaga o que este teste criou
    for table in ["ultimos", "cotacoes", "alertas"] {
        sqlx::query(&format!(
            "delete from investimentos.{table} where ticker = $1",
            table = table
        ))
        .bind(&ticker)
        .execute(&fixture.pool)
        .await
        .unwrap_or_else(|err| panic!("limpar {table}: {err}"));
    }
    sqlx::query("delete from investimentos.movimentos where ref = $1")
        .bind(&referencia)
        .execute(&fixture.pool)
        .await
        .expect("limpar movimento do teste");
}
