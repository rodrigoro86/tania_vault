//! Rotas simples de `/api/investimentos` (F3a) atendidas direto no Postgres.
//!
//! Como em `reminders.rs`, o JSON nasce do próprio banco (`json_agg`/
//! `json_build_object`): `date` sai `AAAA-MM-DD`, `timestamptz` sai ISO UTC com
//! milissegundos e `numeric`/`bigint`/`jsonb` já saem número/objeto — o contrato
//! é idêntico ao de `app/server/investimentos.mjs`.
//!
//! Continuam no Node, caindo no `fallback(proxy)` de cada caminho: `GET
//! /api/investimentos/resumo`, `POST /api/investimentos/movimentos`, `POST
//! /api/investimentos/acompanhadas`, `POST /api/investimentos/relatorios` e as
//! rotinas/agendadores (F5).

use std::collections::HashMap;
use std::sync::LazyLock;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde_json::json;

use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::users::routes::{db, db_error, json_body, me};
use crate::users::Usuario;

/// Ticker B3, o mesmo regex do Node: quatro letras + 1 ou 2 dígitos (PETR4).
static TICKER: LazyLock<regex_lite::Regex> =
    LazyLock::new(|| regex_lite::Regex::new("^[A-Z]{4}\\d{1,2}$").expect("regex de ticker"));

/// Tipos de alerta aceitos, na mesma ordem da mensagem de erro do Node.
const TIPOS_ALERTA: [&str; 3] = ["queda_dia", "preco_acima", "preco_abaixo"];

/// Ticker do Node: `trim` + maiúsculas; fora do formato, 400 com a mesma frase.
fn ticker(valor: &str) -> Result<String, ApiError> {
    let t = valor.trim().to_uppercase();
    if !TICKER.is_match(&t) {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "ticker inválido, use o código da B3 (ex.: PETR4)".to_string(),
        ));
    }
    Ok(t)
}

/// `numero(v, 'valor')` do Node: aceita number ou string numérica, exige finito
/// e ≥ 0.0001; senão 400 "valor inválido".
fn valor(valor: Option<&serde_json::Value>) -> Result<f64, ApiError> {
    let n = match valor {
        Some(v) => match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        },
        None => None,
    };
    match n {
        Some(n) if n.is_finite() && n >= 0.0001 => Ok(n),
        _ => Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            "valor inválido".to_string(),
        )),
    }
}

/// O texto JSON que o Postgres devolve vira `serde_json::Value`; falha de parse
/// é tratada como erro de banco (500), nunca vazam detalhes.
fn linha_de(texto: &str) -> Result<serde_json::Value, ApiError> {
    serde_json::from_str(texto).map_err(|err| {
        tracing::error!("json do banco mal formado: {err}");
        ApiError::Http(
            StatusCode::INTERNAL_SERVER_ERROR,
            "erro no banco".to_string(),
        )
    })
}

// --- GET /api/investimentos/movimentos?carteira= -----------------------------

/// Projeção de `movimentos`, coluna por coluna do `SELECT_MOV` do Node.
const MOVIMENTO: &str = r#"json_build_object(
  'id', id,
  'carteira', carteira,
  'tipo', tipo,
  'ticker', ticker,
  'quantidade', quantidade,
  'preco', preco,
  'taxas', taxas,
  'valor', valor,
  'data', to_char(data, 'YYYY-MM-DD'),
  'motivo', motivo,
  'origem', origem,
  'espelho_de', espelho_de
)"#;

async fn listar_movimentos(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // só o ausência cai no padrão `real`; `carteira=` vazio não encontra nada,
    // como `url.searchParams.get('carteira') ?? 'real'` no Node
    let carteira = params
        .get("carteira")
        .cloned()
        .unwrap_or_else(|| "real".to_string());

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "select coalesce(json_agg({MOVIMENTO} order by data, id), '[]')::text \
           from investimentos.movimentos where carteira = $1"
    ))
    .bind(carteira)
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "movimentos": linha_de(&texto)? })))
}

// --- DELETE /api/investimentos/movimentos/{id} -------------------------------

async fn remover_movimento(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // só a carteira real tem lançamento manual; o espelho das fictícias vem da
    // rotina, então fora de `real` é 404 como no Node
    let linhas =
        sqlx::query("delete from investimentos.movimentos where id = $1 and carteira = 'real'")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(db_error)?
            .rows_affected();

    if linhas == 0 {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            "movimento não encontrado".to_string(),
        ));
    }

    Ok(Json(json!({ "ok": true })))
}

// --- GET /api/investimentos/ordens -------------------------------------------

const ORDEM: &str = r#"json_build_object(
  'id', id,
  'carteira', carteira,
  'lado', lado,
  'ticker', ticker,
  'quantidade', quantidade,
  'motivo', motivo,
  'decidida_em', to_char(decidida_em, 'YYYY-MM-DD'),
  'status', status,
  'erro', erro,
  'preco', preco,
  'executada_em', to_char(executada_em, 'YYYY-MM-DD')
)"#;

async fn listar_ordens(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // `limit` dentro da subquery; `json_agg` ordena de novo para não depender
    // da ordem do scan
    let texto = sqlx::query_scalar::<_, String>(&format!(
        "select coalesce(json_agg(o order by d desc, id desc), '[]')::text \
           from (select {ORDEM} as o, decidida_em as d, id \
                  from investimentos.ordens \
                 order by decidida_em desc, id desc limit 100) s"
    ))
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "ordens": linha_de(&texto)? })))
}

// --- GET /api/investimentos/analises?tipo= -----------------------------------

const ANALISE: &str = r#"json_build_object(
  'id', id,
  'tipo', tipo,
  'carteira', carteira,
  'data', to_char(data, 'YYYY-MM-DD'),
  'texto', texto
)"#;

async fn listar_analises(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    let tipo = params.get("tipo").cloned();

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "select coalesce(json_agg(a order by d desc, id desc), '[]')::text \
           from (select {ANALISE} as a, data as d, id \
                  from investimentos.analises \
                 where ($1::text is null or tipo = $1) \
                 order by data desc, id desc limit 30) s"
    ))
    .bind(tipo)
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "analises": linha_de(&texto)? })))
}

// --- GET/POST/DELETE /api/investimentos/alertas ------------------------------

const ALERTA: &str = r#"json_build_object(
  'id', id,
  'ticker', ticker,
  'tipo', tipo,
  'valor', valor,
  'ativo', ativo,
  'ultimo_envio', to_char(ultimo_envio, 'YYYY-MM-DD')
)"#;

async fn listar_alertas(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "select coalesce(json_agg({ALERTA} order by ticker, id), '[]')::text \
           from investimentos.alertas where ativo"
    ))
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "alertas": linha_de(&texto)? })))
}

async fn criar_alerta(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = me(user)?;
    let pool = db(&state)?;
    let corpo = json_body(body)?;

    let ticker = ticker(
        corpo
            .get("ticker")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
    )?;

    let tipo = corpo
        .get("tipo")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if !TIPOS_ALERTA.contains(&tipo) {
        return Err(ApiError::Http(
            StatusCode::BAD_REQUEST,
            format!("tipo deve ser um de: {}", TIPOS_ALERTA.join(", ")),
        ));
    }

    let valor = valor(corpo.get("valor"))?;

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "insert into investimentos.alertas (ticker, tipo, valor) values ($1, $2, $3) returning {ALERTA}::text"
    ))
    .bind(ticker)
    .bind(tipo)
    .bind(valor)
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    let alerta = linha_de(&texto)?;
    tracing::info!(
        "'{}' criou alerta {} de {}",
        who.username,
        alerta["id"].as_i64().unwrap_or_default(),
        alerta["ticker"].as_str().unwrap_or_default()
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "alerta": alerta })),
    ))
}

async fn desativar_alerta(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // desativa, não apaga: a histórico de alertas fica para as rotinas
    let linhas =
        sqlx::query("update investimentos.alertas set ativo = false where id = $1 and ativo")
            .bind(id)
            .execute(&pool)
            .await
            .map_err(db_error)?
            .rows_affected();

    if linhas == 0 {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            "alerta não encontrado".to_string(),
        ));
    }

    Ok(Json(json!({ "ok": true })))
}

// --- GET /api/investimentos/acompanhadas -------------------------------------

async fn listar_acompanhadas(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    // `ultimo` e `base` vêm do histórico de cotacoes, como no Node; o preço
    // atual é o de `ultimos` quando existe, senão o último fechamento
    let texto = sqlx::query_scalar::<_, String>(
        r#"select coalesce(json_agg(json_build_object(
              'ticker', a.ticker,
              'preco', coalesce(u.preco, m.ultimo),
              'variacao', u.variacao,
              'em', to_char(u.em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'variacao_30d', case
                when coalesce(u.preco, m.ultimo) is not null and m.base is not null
                then round((coalesce(u.preco, m.ultimo) / m.base - 1) * 10000) / 100
              end
            ) order by a.ticker), '[]')::text
            from investimentos.acompanhadas a
            left join investimentos.ultimos u using (ticker)
            left join lateral (
              select
                (select fechamento from investimentos.cotacoes c
                  where c.ticker = a.ticker order by c.data desc limit 1) as ultimo,
                (select fechamento from investimentos.cotacoes c
                  where c.ticker = a.ticker and c.data <= current_date - 30
                  order by c.data desc limit 1) as base
            ) m on true"#,
    )
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(
        json!({ "ok": true, "acompanhadas": linha_de(&texto)? }),
    ))
}

// --- DELETE /api/investimentos/acompanhadas/{ticker} -------------------------

async fn deixar_de_acompanhar(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(acao): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    let ticker = ticker(&acao)?;

    let linhas = sqlx::query("delete from investimentos.acompanhadas where ticker = $1")
        .bind(ticker)
        .execute(&pool)
        .await
        .map_err(db_error)?
        .rows_affected();

    if linhas == 0 {
        return Err(ApiError::Http(
            StatusCode::NOT_FOUND,
            "ação não está na lista".to_string(),
        ));
    }

    Ok(Json(json!({ "ok": true })))
}

// --- GET /api/investimentos/relatorios ---------------------------------------

const RELATORIO: &str = r#"json_build_object(
  'id', id,
  'titulo', titulo,
  'fonte', fonte,
  'data', to_char(data, 'YYYY-MM-DD'),
  'resumo', resumo,
  'recomendacoes', recomendacoes
)"#;

async fn listar_relatorios(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    me(user)?;
    let pool = db(&state)?;

    let texto = sqlx::query_scalar::<_, String>(&format!(
        "select coalesce(json_agg(r order by d desc, id desc), '[]')::text \
           from (select {RELATORIO} as r, data as d, id \
                  from investimentos.relatorios \
                 order by data desc, id desc limit 30) s"
    ))
    .fetch_one(&pool)
    .await
    .map_err(db_error)?;

    Ok(Json(json!({ "ok": true, "relatorios": linha_de(&texto)? })))
}

/// Rotas de investimentos. Métodos não registrados (POST de movimentos,
/// acompanhadas e relatórios, além de `resumo`) caem no proxy (Node).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/investimentos/movimentos",
            get(listar_movimentos).fallback(proxy),
        )
        .route(
            "/api/investimentos/movimentos/{id}",
            delete(remover_movimento).fallback(proxy),
        )
        .route(
            "/api/investimentos/ordens",
            get(listar_ordens).fallback(proxy),
        )
        .route(
            "/api/investimentos/analises",
            get(listar_analises).fallback(proxy),
        )
        .route(
            "/api/investimentos/alertas",
            get(listar_alertas).post(criar_alerta).fallback(proxy),
        )
        .route(
            "/api/investimentos/alertas/{id}",
            delete(desativar_alerta).fallback(proxy),
        )
        .route(
            "/api/investimentos/acompanhadas",
            get(listar_acompanhadas).fallback(proxy),
        )
        .route(
            "/api/investimentos/acompanhadas/{ticker}",
            delete(deixar_de_acompanhar).fallback(proxy),
        )
        .route(
            "/api/investimentos/relatorios",
            get(listar_relatorios).fallback(proxy),
        )
}
