//! Repositório da tabela `tools` (migração `103_tools.sql`).
//!
//! Sem macros de compile-time: `sqlx::query` + `.bind`, como em
//! `settings/repo.rs`, para compilar e testar sem `DATABASE_URL`. Aqui não se
//! valida nada nem se cifra: a API valida (`valid_id`/`valid_url`) e quem cifra
//! é `settings::crypto::Cifra`.

use sqlx::PgPool;

/// Cadastra uma tool do banco: segredo já cifrado, `ativo = true`.
pub async fn inserir(
    pool: &PgPool,
    id: &str,
    url: &str,
    segredo_cifrado: &str,
    por: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into tools (id, url, segredo, ativo, atualizado_por) \
         values ($1, $2, $3, true, $4)",
    )
    .bind(id)
    .bind(url)
    .bind(segredo_cifrado)
    .bind(por)
    .execute(pool)
    .await?;
    Ok(())
}

/// Troca só o que foi informado (`None` = deixa como está). `false` = não
/// existe nenhuma tool com esse id.
pub async fn atualizar(
    pool: &PgPool,
    id: &str,
    url: Option<&str>,
    segredo_cifrado: Option<&str>,
    ativo: Option<bool>,
    por: &str,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "update tools set \
            url = coalesce($1, url), \
            segredo = coalesce($2, segredo), \
            ativo = coalesce($3, ativo), \
            atualizado_em = now(), \
            atualizado_por = $4 \
         where id = $5",
    )
    .bind(url)
    .bind(segredo_cifrado)
    .bind(ativo)
    .bind(por)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Apaga a tool e toda a config dela (`tools_config`), na mesma transação.
/// `false` = a tool não existia.
pub async fn apagar(pool: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query("delete from tools_config where tool_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    let res = sqlx::query("delete from tools where id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(res.rows_affected() == 1)
}

/// Já tem uma linha no banco com esse id?
pub async fn existe(pool: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    let linha = sqlx::query("select 1 from tools where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(linha.is_some())
}
