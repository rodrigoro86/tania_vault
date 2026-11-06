//! Autenticação dos canais de integração (MCP e Hook) por token `tania_…`.
//!
//! O portão (`http/auth.rs::gate_integracao`) chama `autorizar` para `/mcp` e
//! `/api/agenda/registro`. Um token só abre esses dois canais: não vale como
//! sessão e não passa pelo resto da API.

use axum::http::{header, HeaderMap, StatusCode};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;
use crate::tokens::{hash, routes::CHAVE_HOOK, routes::CHAVE_MCP, PREFIXO};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Canal {
    Mcp,
    Hook,
}

/// Quem está chamando por um canal de integração; vai nas extensions do request.
#[derive(Debug, Clone)]
pub struct IntegracaoAuth {
    pub token_id: Uuid,
    pub usuario: String,
}

/// `Authorization: Bearer tania_…`. Outro formato (inclusive sessão) = `None`.
pub fn token_do_header(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| t.starts_with(PREFIXO))
}

fn nao_autorizado() -> ApiError {
    ApiError::Http(StatusCode::UNAUTHORIZED, "token inválido".to_string())
}

/// Confere, nesta ordem: token existe e está ativo (e o usuário também), o
/// token tem o canal marcado, e o canal está ligado nas Integrações. Só então
/// atualiza `ultimo_uso`.
pub async fn autorizar(
    pool: &PgPool,
    token: &str,
    canal: Canal,
) -> Result<IntegracaoAuth, ApiError> {
    let linha: Option<(Uuid, String, bool, bool, bool)> = sqlx::query_as(
        "select t.id, u.username, t.mcp, t.hook, (t.ativo and u.ativo) \
         from tokens_api t join usuarios u on u.id = t.usuario_id \
         where t.token_hash = $1",
    )
    .bind(hash(token))
    .fetch_optional(pool)
    .await
    .map_err(erro_banco)?;

    let Some((token_id, usuario, mcp, hook, ativo)) = linha else {
        return Err(nao_autorizado());
    };
    if !ativo {
        return Err(nao_autorizado());
    }

    let permitido = match canal {
        Canal::Mcp => mcp,
        Canal::Hook => hook,
    };
    if !permitido {
        return Err(ApiError::Http(
            StatusCode::FORBIDDEN,
            "token sem permissão para este canal".to_string(),
        ));
    }

    let chave = match canal {
        Canal::Mcp => CHAVE_MCP,
        Canal::Hook => CHAVE_HOOK,
    };
    let valor: Option<String> =
        sqlx::query_scalar("select valor from configuracoes where chave = $1")
            .bind(chave)
            .fetch_optional(pool)
            .await
            .map_err(erro_banco)?;
    if valor.as_deref() != Some("true") {
        return Err(ApiError::Http(
            StatusCode::FORBIDDEN,
            "canal desligado nas Integrações".to_string(),
        ));
    }

    // o uso não bloqueia a resposta: falha só vai para o log
    if let Err(err) = sqlx::query("update tokens_api set ultimo_uso = now() where id = $1")
        .bind(token_id)
        .execute(pool)
        .await
    {
        tracing::warn!("tokens: não foi possível gravar ultimo_uso: {err}");
    }

    Ok(IntegracaoAuth { token_id, usuario })
}

fn erro_banco(err: sqlx::Error) -> ApiError {
    tracing::error!("tokens: banco: {err}");
    ApiError::Http(StatusCode::INTERNAL_SERVER_ERROR, "erro no banco".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn com_auth(valor: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_str(valor).unwrap());
        h
    }

    #[test]
    fn so_aceita_bearer_com_prefixo_de_token_de_integracao() {
        assert_eq!(token_do_header(&com_auth("Bearer tania_abc")), Some("tania_abc"));
        // sessão (token sem o prefixo) não abre canal de integração
        assert_eq!(token_do_header(&com_auth("Bearer abc123")), None);
        assert_eq!(token_do_header(&com_auth("Basic tania_abc")), None);
        assert_eq!(token_do_header(&HeaderMap::new()), None);
    }
}
