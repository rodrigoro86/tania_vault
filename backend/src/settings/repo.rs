//! Repositório da tabela `configuracoes` (migração `101_configuracoes.sql`).
//!
//! Sem macros de compile-time (`query!`): `sqlx::query` / `query_as` com
//! `.bind`, como em `users/repo.rs`, para compilar e testar sem `DATABASE_URL`.
//! Aqui o repositório **não** valida a lista de chaves nem cifra: quem valida é
//! a API (`keys::validar`) e quem cifra é `crypto`.

use sqlx::PgPool;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Linha {
    pub chave: String,
    pub valor: String,
    pub segredo: bool,
    pub atualizado_em: chrono::DateTime<chrono::Utc>,
    pub atualizado_por: Option<String>,
}

pub async fn listar(pool: &PgPool) -> Result<Vec<Linha>, sqlx::Error> {
    sqlx::query_as::<_, Linha>(
        "select chave, valor, segredo, atualizado_em, atualizado_por \
         from configuracoes order by chave",
    )
    .fetch_all(pool)
    .await
}

/// Insert ou update da mesma chave; devolve a linha como está no banco.
pub async fn gravar(
    pool: &PgPool,
    chave: &str,
    valor: &str,
    segredo: bool,
    por: &str,
) -> Result<Linha, sqlx::Error> {
    sqlx::query_as::<_, Linha>(
        "insert into configuracoes (chave, valor, segredo, atualizado_por) \
         values ($1, $2, $3, $4) \
         on conflict (chave) do update set \
             valor = excluded.valor, \
             segredo = excluded.segredo, \
             atualizado_em = now(), \
             atualizado_por = excluded.atualizado_por \
         returning chave, valor, segredo, atualizado_em, atualizado_por",
    )
    .bind(chave)
    .bind(valor)
    .bind(segredo)
    .bind(por)
    .fetch_one(pool)
    .await
}

/// `true` se existia e foi apagada (volta a valer o env).
pub async fn remover(pool: &PgPool, chave: &str) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("delete from configuracoes where chave = $1")
        .bind(chave)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() == 1)
}
