//! Usuários: hash de senha, tokens de sessão e repositório Postgres.

use sqlx::PgPool;

use crate::config::Creds;

pub mod password;
pub mod repo;
pub mod routes;
pub mod token;

pub use repo::Usuario;

/// Cria o admin inicial **só se o banco ainda não tem nenhum usuário**.
///
/// Roda no boot, a partir de `TANIA_BOOTSTRAP_ADMIN="usuario:senha"`. Idempotente:
/// se já existe qualquer usuário (mesmo inativo) não toca em nada — quem já
/// configurou o banco não é substituído por uma senha de env.
pub async fn bootstrap_admin(db: &PgPool, creds: &Creds) -> Result<bool, repo::RepoError> {
    if repo::count_users(db).await? > 0 {
        return Ok(false);
    }

    repo::create(db, &creds.user, &creds.pass, true).await?;
    tracing::warn!(
        "admin inicial '{}' criado a partir de TANIA_BOOTSTRAP_ADMIN; troque a senha",
        creds.user
    );
    Ok(true)
}
