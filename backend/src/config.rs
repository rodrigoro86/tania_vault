use std::env;

use thiserror::Error;

/// Credenciais de um usuário, vindas de `TANIA_BOOTSTRAP_ADMIN="usuario:senha"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Creds {
    pub user: String,
    pub pass: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("deve ter o formato usuario:senha (ambos não vazios)")]
pub struct CredsError;

/// `"user:pass" -> Some({user, pass})`; a senha pode conter `":"` (corta só no 1º).
///
/// Ausente ou vazio -> `None` (nenhum admin inicial). Remove aspas em
/// volta — o env_file do Docker/Swarm entrega `'usuario:senha'` literal — só UMA
/// camada, exatamente como o `replace(/^(['"])([\s\S]*)\1$/, '$2')` do Node.
pub fn parse_creds(raw: Option<&str>) -> Result<Option<Creds>, CredsError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    let mut clean = raw.trim();
    let first = clean.chars().next();
    if let Some(quote) = first {
        if (quote == '\'' || quote == '"') && clean.len() >= 2 && clean.ends_with(quote) {
            // primeiro e último byte são ASCII (a aspa), então fatiar é seguro.
            clean = &clean[1..clean.len() - 1];
        }
    }
    if clean.is_empty() {
        return Ok(None);
    }

    let split = match clean.find(':') {
        Some(index) if index > 0 => index,
        _ => return Err(CredsError),
    };
    let user = &clean[..split];
    let pass = &clean[split + 1..];
    if user.is_empty() || pass.is_empty() {
        return Err(CredsError);
    }
    Ok(Some(Creds {
        user: user.to_string(),
        pass: pass.to_string(),
    }))
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub legacy_upstream: String,
    /// `None` = sem Postgres: só loopback entra (o portão responde 503 ao remoto).
    pub database_url: Option<String>,
    /// Admin criado no primeiro boot, se o banco está vazio (`usuario:senha`).
    pub bootstrap_admin: Option<Creds>,
    /// Segredo que o Rust manda ao Node para confirmar "essa requisição já passou
    /// pelo portão". `None` = não manda nada.
    pub legacy_proxy_secret: Option<String>,
    pub rate_limit_max: u32,
    pub rate_limit_window_ms: i64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 3100,
            legacy_upstream: "http://127.0.0.1:3101".to_string(),
            database_url: None,
            bootstrap_admin: None,
            legacy_proxy_secret: None,
            rate_limit_max: 300,
            rate_limit_window_ms: 60_000,
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, CredsError> {
        Ok(Self {
            port: env::var("PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(3100),
            legacy_upstream: env::var("LEGACY_UPSTREAM")
                .unwrap_or_else(|_| "http://127.0.0.1:3101".to_string()),
            // DATABASE_URL vazio == ausente. Sem ela, PGHOST liga o banco pelas variáveis
            // padrão do libpq (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE): `Some("")`.
            database_url: env::var("DATABASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    env::var("PGHOST")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|_| String::new())
                }),
            // TANIA_BOOTSTRAP_ADMIN vazio == ausente: nenhum admin inicial.
            bootstrap_admin: parse_creds(env::var("TANIA_BOOTSTRAP_ADMIN").ok().as_deref())?,
            legacy_proxy_secret: env::var("LEGACY_PROXY_SECRET")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            rate_limit_max: env::var("RATE_LIMIT_MAX")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(300),
            rate_limit_window_ms: env::var("RATE_LIMIT_WINDOW_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(60_000),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_creds_aceita_aspas_e_senha_com_colon() {
        assert_eq!(parse_creds(None).expect("None"), None);
        assert_eq!(parse_creds(Some("")).expect("vazio"), None);
        assert_eq!(parse_creds(Some("   ")).expect("só espaço"), None);
        assert_eq!(
            parse_creds(Some("rodrigo:a:b")).expect("parse"),
            Some(Creds {
                user: "rodrigo".to_string(),
                pass: "a:b".to_string()
            })
        );
        assert_eq!(
            parse_creds(Some("'rodrigo:a:b'")).expect("parse aspas simples"),
            Some(Creds {
                user: "rodrigo".to_string(),
                pass: "a:b".to_string()
            })
        );
        assert_eq!(
            parse_creds(Some("\"rodrigo:senha\"")).expect("parse aspas duplas"),
            Some(Creds {
                user: "rodrigo".to_string(),
                pass: "senha".to_string()
            })
        );
        // só uma camada de aspa sai: `''u:p''` vira `'u:p'`, que já não é aspa pura
        assert_eq!(
            parse_creds(Some("''u:p''")).expect("parse dupla camada"),
            Some(Creds {
                user: "'u".to_string(),
                pass: "p'".to_string()
            })
        );
    }

    #[test]
    fn parse_creds_rejeita_formato_invalido() {
        assert!(parse_creds(Some("sem-dois-pontos")).is_err());
        assert!(parse_creds(Some(":senha")).is_err());
        assert!(parse_creds(Some("user:")).is_err());
        assert!(parse_creds(Some("'")).is_err());
    }
}
