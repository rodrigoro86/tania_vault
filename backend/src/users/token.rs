//! Tokens de sessão: geração aleatória e hash usado no banco.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

/// Dias de vida de uma sessão.
pub const SESSION_DAYS: i64 = 30;

/// 32 bytes aleatórios em base64 URL-safe sem padding (43 chars).
pub fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

/// sha256 do texto do token: é o valor binário que vai em `sessoes.token_hash`.
pub fn hash_token(token: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.finalize().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_sao_diferentes_e_do_tamanho_certo() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert_eq!(b.len(), 43);
    }

    #[test]
    fn hash_do_token_tem_32_bytes() {
        let hashed = hash_token(&new_token());
        assert_eq!(hashed.len(), 32);
    }
}
