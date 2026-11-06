//! Pool Postgres + migrador.
//!
//! A tabela `schema_migrations` é **a mesma** usada pelo Node (`app/server/db.mjs`):
//! `version text primary key, applied_at timestamptz not null default now()`, e a
//! `version` é o nome do arquivo `.sql`. Por isso as versões do Rust começam em
//! `100_` — não colidem com as migrações `001_`–`099_` do Node, e cada lado só
//! aplica o que ainda não está registrado.

use sqlx::postgres::PgPoolOptions;

pub use sqlx::PgPool;

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "100_usuarios.sql",
        include_str!("../../migrations/100_usuarios.sql"),
    ),
    (
        "101_configuracoes.sql",
        include_str!("../../migrations/101_configuracoes.sql"),
    ),
    (
        "102_agentes_config.sql",
        include_str!("../../migrations/102_agentes_config.sql"),
    ),
    (
        "103_tools.sql",
        include_str!("../../migrations/103_tools.sql"),
    ),
    (
        "104_tokens_api.sql",
        include_str!("../../migrations/104_tokens_api.sql"),
    ),
];

/// Cria o pool (max 5 conexões) a partir de uma URL `postgres://...`; URL vazia =
/// variáveis padrão do libpq (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`).
pub async fn connect(url: &str) -> Result<PgPool, sqlx::Error> {
    let pool = PgPoolOptions::new().max_connections(5);
    if url.is_empty() {
        pool.connect_with(sqlx::postgres::PgConnectOptions::new())
            .await
    } else {
        pool.connect(url).await
    }
}

/// Aplica as migrações ainda não registradas; devolve as versões aplicadas agora.
pub async fn migrate(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query(
        "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
    )
    .execute(pool)
    .await?;

    let mut applied: Vec<String> = Vec::new();

    for &(version, sql) in MIGRATIONS {
        // lock na transação: dois processos migrando ao mesmo tempo (deploy start-first,
        // testes em paralelo) não aplicam a mesma versão duas vezes
        let mut tx = pool.begin().await?;
        sqlx::query("select pg_advisory_xact_lock(74130100)")
            .execute(&mut *tx)
            .await?;
        let done = sqlx::query("select 1 from schema_migrations where version = $1")
            .bind(version)
            .fetch_optional(&mut *tx)
            .await?;
        if done.is_some() {
            continue;
        }
        sqlx::raw_sql(sql).execute(&mut *tx).await?;
        sqlx::query("insert into schema_migrations (version) values ($1)")
            .bind(version)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        tracing::info!("db: migration aplicada {version}");
        applied.push(version.to_string());
    }

    Ok(applied)
}
