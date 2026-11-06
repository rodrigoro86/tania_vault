//! Helpers compartilhados pelos testes de API que precisam de Postgres
//! (`reminders_api.rs`, e mais tarde `investimentos_api.rs`).
//!
//! `pool()` deixa o banco pronto dos dois lados: as migrações do Rust
//! (`100_`–`102_`) e as do Node que o domínio usa (`001`, `003`, `004`),
//! registradas em `schema_migrations` como o Node faz.
#![allow(dead_code)]

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, HeaderValue, Method};
use axum::response::Response;
use http_body_util::BodyExt;
use sqlx::PgPool;
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

use tania::config::Config;
use tania::db::{connect, migrate};
use tania::http::{router, AppState};
use tania::storage::local::LocalFs;
use tania::storage::Store;
use tania::users::repo;

// --- banco de teste -----------------------------------------------------------

/// Migrações do Node que o domínio de testes precisa: `lembretes` (001),
/// `movimentos`/`ordens`/`alertas`/`analises`/`relatorios` (003) e
/// `acompanhadas` (004).
const MIGRACOES_NODE: &[(&str, &str)] = &[
    (
        "001_init.sql",
        include_str!("../../../app/server/migrations/001_init.sql"),
    ),
    (
        "003_investimentos.sql",
        include_str!("../../../app/server/migrations/003_investimentos.sql"),
    ),
    (
        "004_acompanhadas.sql",
        include_str!("../../../app/server/migrations/004_acompanhadas.sql"),
    ),
];

/// Aplica as migrações do Node ainda não registradas, igual a
/// `tania::db::migrate`: lock advisory por transação + insert em
/// `schema_migrations`.
pub async fn node_migrate(pool: &PgPool) {
    sqlx::query(
        "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    )
    .execute(pool)
    .await
    .expect("criar schema_migrations");

    for &(version, sql) in MIGRACOES_NODE {
        let mut tx = pool.begin().await.expect("abrir transação");
        sqlx::query("select pg_advisory_xact_lock(74130100)")
            .execute(&mut *tx)
            .await
            .expect("lock advisory");
        let done = sqlx::query("select 1 from schema_migrations where version = $1")
            .bind(version)
            .fetch_optional(&mut *tx)
            .await
            .expect("consultar schema_migrations");
        if done.is_some() {
            continue;
        }
        sqlx::raw_sql(sql)
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|err| panic!("aplicar {version}: {err}"));
        sqlx::query("insert into schema_migrations (version) values ($1)")
            .bind(version)
            .execute(&mut *tx)
            .await
            .expect("registrar versão");
        tx.commit().await.expect("commit da migração");
    }
}

/// Pool de teste migrado; `None` quando `TEST_DATABASE_URL` não existe.
pub async fn pool() -> Option<PgPool> {
    let url = match std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
    {
        Some(url) => url,
        None => {
            eprintln!("pulado: TEST_DATABASE_URL ausente");
            return None;
        }
    };
    let pool = match connect(&url).await {
        Ok(pool) => pool,
        Err(err) => panic!("TEST_DATABASE_URL definida mas nao conectou: {err}"),
    };
    if let Err(err) = migrate(&pool).await {
        panic!("migrate falhou: {err}");
    }
    node_migrate(&pool).await;
    Some(pool)
}

pub struct Fixture {
    pub state: AppState,
    pub pool: PgPool,
    _dir: TempDir,
}

/// Vault local vazio em tempdir: o `AppState` exige um `Store`.
pub async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let dir = TempDir::new().expect("tempdir");
    let state = AppState::new(
        Config::default(),
        reqwest::Client::new(),
        Store::Local(LocalFs::new(dir.path().to_str().expect("tempdir em utf-8"))),
    )
    .with_db(pool.clone());

    Some(Fixture {
        state,
        pool,
        _dir: dir,
    })
}

/// Username único: o banco compartilhado já tem linhas de outras rodadas.
pub fn unique_username() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("t{}", &id[..12])
}

/// IP remoto distinto (n = número do teste).
pub fn remote(n: u8) -> SocketAddr {
    SocketAddr::from(([10, 0, 0, n], 5000))
}

pub async fn call(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    client: SocketAddr,
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

pub async fn read_json(response: Response) -> serde_json::Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("corpo")
        .to_bytes();
    serde_json::from_slice::<serde_json::Value>(&bytes).expect("json")
}

pub fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers
}

/// Bearer + content-type JSON: toda escrita precisa dos dois (CSRF exige JSON).
pub fn json_bearer(token: &str) -> HeaderMap {
    let mut headers = bearer(token);
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

/// Usuário criado direto no repositório + uma sessão: devolve o token.
pub async fn login(pool: &PgPool, admin: bool) -> String {
    let user = repo::create(pool, &unique_username(), "12345678", admin)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(pool, user.id)
        .await
        .expect("criar sessão de teste");
    token
}
