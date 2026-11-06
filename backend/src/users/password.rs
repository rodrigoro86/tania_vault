//! Senhas: hash argon2id, verificação e validação de formato.

use std::sync::OnceLock;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

/// Hash argon2id (string PHC) com salt aleatório novo a cada chamada.
pub fn hash(senha: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut rand::rngs::OsRng);
    Argon2::default()
        .hash_password(senha.as_bytes(), &salt)
        .map(|phc| phc.to_string())
}

/// `true` se `senha` bate com o hash PHC `phc`. Qualquer erro de parsing do hash
/// (lixo, formato desconhecido) é tratado como "não bate".
pub fn verify(senha: &str, phc: &str) -> bool {
    let Ok(phc) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(senha.as_bytes(), &phc)
        .is_ok()
}

/// Verifica contra um hash fixo gerado uma vez. Serve para gastar o mesmo tempo
/// de argon2 quando o usuário não existe, igualando o tempo de resposta.
pub fn verify_dummy(senha: &str) -> bool {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let phc = DUMMY.get_or_init(|| match hash("senha-de-timing-nunca-usada") {
        Ok(phc) => phc,
        Err(err) => {
            tracing::error!("password: nao conseguiu gerar o hash dummy: {err}");
            String::new()
        }
    });
    verify(senha, phc)
}

/// Username: 3..=32 chars, só ascii alfanumérico, `.` `_` `-`.
pub fn valid_username(u: &str) -> bool {
    (3..=32).contains(&u.chars().count())
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Senha: 8..=128 chars.
pub fn valid_password(p: &str) -> bool {
    (8..=128).contains(&p.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_verify_roundtrip() {
        let phc = hash("12345678").expect("hash deveria funcionar");
        assert!(phc.starts_with("$argon2"));
        assert!(verify("12345678", &phc));
        assert!(!verify("12345679", &phc));
    }

    #[test]
    fn phc_lixo_nao_verify() {
        assert!(!verify("qualquer", "not-a-phc-string"));
    }

    #[test]
    fn usernames() {
        assert!(!valid_username("ab"));
        assert!(valid_username("joao.silva"));
        assert!(!valid_username("a b c"));
    }

    #[test]
    fn passwords() {
        assert!(!valid_password("1234567"));
        assert!(valid_password("12345678"));
    }
}
