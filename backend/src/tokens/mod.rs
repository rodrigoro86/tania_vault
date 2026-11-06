//! Tokens de integração (`tokens_api`, migração `104_tokens_api.sql`) e as
//! chaves gerais que ligam cada canal (MCP e Hook). Design:
//! `docs/superpowers/specs/2026-11-06-tokens-integracao-design.md`.
//!
//! `auth` valida o token nas rotas `/mcp` e `/api/agenda/registro` (portão em
//! `http/auth.rs`); `agenda` grava no diário; `mcp` é o servidor MCP.

pub mod agenda;
pub mod auth;
pub mod mcp;
pub mod repo;
pub mod routes;

use crate::users::token::{hash_token, new_token};
use crate::users::Usuario;

/// Prefixo que deixa o token reconhecível num log ou num `.env`.
pub const PREFIXO: &str = "tania_";
pub const MAX_NOME: usize = 60;

/// Novo token em claro (só vai para a resposta da criação).
pub fn novo_token() -> String {
    format!("{PREFIXO}{}", new_token())
}

/// sha256 do token, o valor gravado em `tokens_api.token_hash`.
pub fn hash(token: &str) -> Vec<u8> {
    hash_token(token)
}

/// Nome sem espaços nas pontas, de 1 a `MAX_NOME` caracteres. `None` = inválido.
pub fn nome_valido(nome: &str) -> Option<String> {
    let t = nome.trim();
    let n = t.chars().count();
    (1..=MAX_NOME).contains(&n).then(|| t.to_string())
}

/// Admin mexe em qualquer token; o usuário, só nos próprios.
pub fn pode_mexer(usuario: &Usuario, dono: uuid::Uuid) -> bool {
    usuario.admin || usuario.id == dono
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn usuario(admin: bool) -> Usuario {
        Usuario {
            id: Uuid::new_v4(),
            username: "u".into(),
            admin,
            ativo: true,
            criado_em: Utc::now(),
        }
    }

    #[test]
    fn token_novo_tem_prefixo_e_hash_de_32_bytes() {
        let t = novo_token();
        assert!(t.starts_with(PREFIXO));
        assert_eq!(t.len(), PREFIXO.len() + 43);
        assert_eq!(hash(&t).len(), 32);
        assert_ne!(t.as_bytes(), hash(&t).as_slice());
    }

    #[test]
    fn nome_e_aparado_e_limitado() {
        assert_eq!(nome_valido("  notebook  ").as_deref(), Some("notebook"));
        assert_eq!(nome_valido("   "), None);
        assert_eq!(nome_valido(&"a".repeat(MAX_NOME)).map(|n| n.len()), Some(MAX_NOME));
        assert_eq!(nome_valido(&"a".repeat(MAX_NOME + 1)), None);
    }

    #[test]
    fn so_admin_ou_dono_mexe_no_token() {
        let dono = usuario(false);
        let outro = usuario(false);
        let admin = usuario(true);
        assert!(pode_mexer(&dono, dono.id));
        assert!(!pode_mexer(&outro, dono.id));
        assert!(pode_mexer(&admin, dono.id));
    }
}
