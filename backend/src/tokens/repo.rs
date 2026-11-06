//! Repositório de `tokens_api`. Sem macros de compile-time, como em `users/repo.rs`.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Linha {
    pub id: Uuid,
    pub usuario_id: Uuid,
    pub usuario: String,
    pub nome: String,
    pub mcp: bool,
    pub hook: bool,
    pub ativo: bool,
    pub criado_em: DateTime<Utc>,
    pub ultimo_uso: Option<DateTime<Utc>>,
}

/// Campos que o PATCH pode mudar; `None` = não mexe.
#[derive(Debug, Default)]
pub struct Mudanca {
    pub nome: Option<String>,
    pub mcp: Option<bool>,
    pub hook: Option<bool>,
    pub ativo: Option<bool>,
}

const SELECT: &str = "select t.id, t.usuario_id, u.username as usuario, t.nome, t.mcp, t.hook, \
     t.ativo, t.criado_em, t.ultimo_uso \
     from tokens_api t join usuarios u on u.id = t.usuario_id";

/// `None` = todos os tokens (admin); `Some(id)` = só os desse usuário.
pub async fn listar(pool: &PgPool, usuario_id: Option<Uuid>) -> Result<Vec<Linha>, sqlx::Error> {
    let sql = format!("{SELECT} where ($1::uuid is null or t.usuario_id = $1) order by t.criado_em");
    sqlx::query_as::<_, Linha>(&sql)
        .bind(usuario_id)
        .fetch_all(pool)
        .await
}

pub async fn buscar(pool: &PgPool, id: Uuid) -> Result<Option<Linha>, sqlx::Error> {
    let sql = format!("{SELECT} where t.id = $1");
    sqlx::query_as::<_, Linha>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn criar(
    pool: &PgPool,
    usuario_id: Uuid,
    nome: &str,
    mcp: bool,
    hook: bool,
    token_hash: &[u8],
) -> Result<Uuid, sqlx::Error> {
    let (id,): (Uuid,) = sqlx::query_as(
        "insert into tokens_api (usuario_id, nome, token_hash, mcp, hook) \
         values ($1, $2, $3, $4, $5) returning id",
    )
    .bind(usuario_id)
    .bind(nome)
    .bind(token_hash)
    .bind(mcp)
    .bind(hook)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// `false` se o id não existe.
pub async fn atualizar(pool: &PgPool, id: Uuid, m: &Mudanca) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "update tokens_api set \
             nome = coalesce($2, nome), \
             mcp = coalesce($3, mcp), \
             hook = coalesce($4, hook), \
             ativo = coalesce($5, ativo) \
         where id = $1",
    )
    .bind(id)
    .bind(m.nome.as_deref())
    .bind(m.mcp)
    .bind(m.hook)
    .bind(m.ativo)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn apagar(pool: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("delete from tokens_api where id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}
