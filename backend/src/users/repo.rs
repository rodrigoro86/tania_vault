//! Repositório de usuários e sessões (`usuarios` / `sessoes`).
//!
//! Sem macros de compile-time (`query!`): todas as consultas são `sqlx::query` /
//! `sqlx::query_as` com `.bind`, o que permite rodar os testes sem `DATABASE_URL`
//! disponível na compilação.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::password;
use super::token;

const COLS: &str = "id, username, admin, ativo, criado_em";
// no join com `sessoes` (que também tem `criado_em`), tudo precisa de prefixo
const USUARIO_COLS: &str = "u.id, u.username, u.admin, u.ativo, u.criado_em";

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usuario {
    pub id: Uuid,
    pub username: String,
    pub admin: bool,
    pub ativo: bool,
    pub criado_em: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error("usuário já existe")]
    Duplicate,
    #[error("senha inválida")]
    Hash,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// `find_login` precisa de `senha_hash`, que não faz parte de `Usuario`.
#[derive(sqlx::FromRow)]
struct LoginRow {
    id: Uuid,
    username: String,
    senha_hash: String,
    admin: bool,
    ativo: bool,
    criado_em: DateTime<Utc>,
}

impl LoginRow {
    fn into_usuario(self) -> (Usuario, String) {
        (
            Usuario {
                id: self.id,
                username: self.username,
                admin: self.admin,
                ativo: self.ativo,
                criado_em: self.criado_em,
            },
            self.senha_hash,
        )
    }
}

pub async fn count_users(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*) from usuarios")
        .fetch_one(pool)
        .await
}

pub async fn count_active_admins(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*) from usuarios where admin and ativo")
        .fetch_one(pool)
        .await
}

pub async fn create(
    pool: &PgPool,
    username: &str,
    senha: &str,
    admin: bool,
) -> Result<Usuario, RepoError> {
    let senha_hash = password::hash(senha).map_err(|_| RepoError::Hash)?;

    match sqlx::query_as::<_, Usuario>(&format!(
        "insert into usuarios (username, senha_hash, admin) values ($1, $2, $3) returning {COLS}"
    ))
    .bind(username)
    .bind(&senha_hash)
    .bind(admin)
    .fetch_one(pool)
    .await
    {
        Ok(usuario) => Ok(usuario),
        Err(err) => {
            // 23505 = unique violation (idx em lower(username))
            if err
                .as_database_error()
                .is_some_and(|db| db.code().as_deref() == Some("23505"))
            {
                return Err(RepoError::Duplicate);
            }
            Err(RepoError::Db(err))
        }
    }
}

pub async fn list(pool: &PgPool) -> Result<Vec<Usuario>, sqlx::Error> {
    sqlx::query_as::<_, Usuario>(&format!(
        "select {COLS} from usuarios order by lower(username)"
    ))
    .fetch_all(pool)
    .await
}

pub async fn get(pool: &PgPool, id: Uuid) -> Result<Option<Usuario>, sqlx::Error> {
    sqlx::query_as::<_, Usuario>(&format!("select {COLS} from usuarios where id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Devolve o usuário (qualquer estado) mais o hash da senha, comparando o
/// username case-insensitive.
pub async fn find_login(
    pool: &PgPool,
    username: &str,
) -> Result<Option<(Usuario, String)>, sqlx::Error> {
    let row = sqlx::query_as::<_, LoginRow>(&format!(
        "select {COLS}, senha_hash from usuarios where lower(username) = lower($1)"
    ))
    .bind(username)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(LoginRow::into_usuario))
}

pub async fn update(
    pool: &PgPool,
    id: Uuid,
    admin: Option<bool>,
    ativo: Option<bool>,
    senha: Option<&str>,
) -> Result<Option<Usuario>, RepoError> {
    let senha_hash = match senha {
        Some(s) => Some(password::hash(s).map_err(|_| RepoError::Hash)?),
        None => None,
    };

    sqlx::query_as::<_, Usuario>(&format!(
        "update usuarios set admin = coalesce($2, admin), \
             ativo = coalesce($3, ativo), \
             senha_hash = coalesce($4, senha_hash), \
             atualizado_em = now() \
             where id = $1 returning {COLS}",
    ))
    .bind(id)
    .bind(admin)
    .bind(ativo)
    .bind(&senha_hash)
    .fetch_optional(pool)
    .await
    .map_err(RepoError::Db)
}

pub async fn delete(pool: &PgPool, id: Uuid) -> Result<bool, sqlx::Error> {
    let res = sqlx::query("delete from usuarios where id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() == 1)
}

/// Cria uma sessão: limpa as vencidas, gera token e devolve o token (texto) e a
/// data de expiração.
pub async fn create_session(
    pool: &PgPool,
    usuario_id: Uuid,
) -> Result<(String, DateTime<Utc>), sqlx::Error> {
    sqlx::query("delete from sessoes where expira_em < now()")
        .execute(pool)
        .await?;

    let token_text = token::new_token();
    let expira_em: DateTime<Utc> = sqlx::query_scalar(
        "insert into sessoes (token_hash, usuario_id, expira_em) \
         values ($1, $2, now() + make_interval(days => $3::int)) \
         returning expira_em",
    )
    .bind(token::hash_token(&token_text))
    .bind(usuario_id)
    .bind(token::SESSION_DAYS)
    .fetch_one(pool)
    .await?;

    Ok((token_text, expira_em))
}

/// Usuário dono de uma sessão ainda válida (token não vencido e usuário ativo).
pub async fn session_user(pool: &PgPool, token: &str) -> Result<Option<Usuario>, sqlx::Error> {
    sqlx::query_as::<_, Usuario>(&format!(
        "select {USUARIO_COLS} from sessoes s \
         join usuarios u on u.id = s.usuario_id \
         where s.token_hash = $1 and s.expira_em > now() and u.ativo",
    ))
    .bind(token::hash_token(token))
    .fetch_optional(pool)
    .await
}

pub async fn delete_session(pool: &PgPool, token: &str) -> Result<(), sqlx::Error> {
    sqlx::query("delete from sessoes where token_hash = $1")
        .bind(token::hash_token(token))
        .execute(pool)
        .await
        .map(|_| ())
}

/// Apaga todas as sessões do usuário, exceto a do `keep_token` (se informado).
pub async fn delete_sessions_except(
    pool: &PgPool,
    usuario_id: Uuid,
    keep_token: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from sessoes where usuario_id = $1 and ($2::bytea is null or token_hash <> $2)",
    )
    .bind(usuario_id)
    .bind(keep_token.map(token::hash_token))
    .execute(pool)
    .await
    .map(|_| ())
}
