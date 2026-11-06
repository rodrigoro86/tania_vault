//! Testes do pool/migrador. Precisam de `TEST_DATABASE_URL`; sem ela, são pulados.

use sqlx::PgPool;
use tania::db::{connect, migrate};

async fn pool() -> Option<PgPool> {
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
    match connect(&url).await {
        Ok(p) => Some(p),
        Err(err) => panic!("TEST_DATABASE_URL definida mas nao conectou: {err}"),
    }
}

#[tokio::test]
async fn migrate_e_idempotente() {
    let Some(pool) = pool().await else {
        return;
    };

    // `migrate` duas vezes: a segunda nao aplica nada (ja registrada em schema_migrations).
    let _primeira = migrate(&pool).await.expect("primeira migrate falhou");
    let segunda = migrate(&pool).await.expect("segunda migrate falhou");
    assert!(
        segunda.is_empty(),
        "segunda rodada nao deveria aplicar nada, aplicou: {segunda:?}"
    );

    let count: i64 = sqlx::query_scalar(
        "select count(*) from schema_migrations where version = '100_usuarios.sql'",
    )
    .fetch_one(&pool)
    .await
    .expect("count em schema_migrations falhou");
    assert_eq!(count, 1);

    let tem_sessoes: bool = sqlx::query_scalar("select to_regclass('public.sessoes') is not null")
        .fetch_one(&pool)
        .await
        .expect("to_regclass falhou");
    assert!(tem_sessoes);
}
