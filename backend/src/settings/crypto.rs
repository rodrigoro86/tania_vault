//! Cifra dos segredos guardados em `configuracoes`.
//!
//! Chave: `TANIA_CONFIG_KEY` = 32 bytes em base64 STANDARD. Algoritmo:
//! AES-256-GCM com nonce aleatório de 12 bytes. Valor gravado:
//! `"v1:" + base64(nonce ‖ texto cifrado ‖ tag)`. O formato é idêntico ao do
//! Node (`app/server/config-db.mjs`), então um valor gravado por um lado é
//! legível pelo outro.

use aes_gcm::aead::generic_array::typenum::U12;
use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::{prelude::BASE64_STANDARD, Engine};

const VERSAO: &str = "v1:";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;

type Nonce = GenericArray<u8, U12>;

pub struct Cifra(Aes256Gcm);

// A chave não pode aparecer em log nem no Debug do estado: só mostra que existe.
impl std::fmt::Debug for Cifra {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Cifra(..)")
    }
}

impl Cifra {
    /// `None` se a base64 é inválida ou não tem exatamente 32 bytes.
    pub fn from_base64(b64: &str) -> Option<Cifra> {
        let bytes = BASE64_STANDARD.decode(b64.trim()).ok()?;
        if bytes.len() != KEY_LEN {
            return None;
        }
        // tamanho já conferido acima; `new_from_slice` só falha fora disso
        Some(Cifra(Aes256Gcm::new_from_slice(&bytes).ok()?))
    }

    /// Cifra com nonce novo. O resultado é o texto que vai na coluna `valor`.
    pub fn cifrar(&self, texto: &str) -> String {
        self.cifrar_com_nonce(texto, rand::random::<[u8; NONCE_LEN]>())
    }

    /// `None` se não tem o prefixo `v1:`, a base64 é inválida, é curta demais
    /// ou a tag não confere (chave errada ou valor adulterado).
    pub fn decifrar(&self, valor: &str) -> Option<String> {
        let corpo = valor.strip_prefix(VERSAO)?;
        let blob = BASE64_STANDARD.decode(corpo).ok()?;
        if blob.len() < NONCE_LEN + TAG_LEN {
            return None;
        }
        let nonce: [u8; NONCE_LEN] = blob[..NONCE_LEN].try_into().ok()?;
        let texto = self
            .0
            .decrypt(&Nonce::from(nonce), &blob[NONCE_LEN..])
            .ok()?;
        String::from_utf8(texto).ok()
    }

    /// Usada por `cifrar` e pelos testes (o vetor da spec exige nonce fixo).
    fn cifrar_com_nonce(&self, texto: &str, nonce_bytes: [u8; NONCE_LEN]) -> String {
        // com chave e nonce de tamanho correto a cifração não falha;
        // `unwrap_or_default` evita qualquer unwrap
        let cifrado = self
            .0
            .encrypt(&Nonce::from(nonce_bytes), texto.as_bytes())
            .unwrap_or_default();
        let mut blob = Vec::with_capacity(NONCE_LEN + cifrado.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&cifrado);
        format!("{VERSAO}{}", BASE64_STANDARD.encode(blob))
    }
}

/// `None` quando `TANIA_CONFIG_KEY` não está definida, está vazia ou é inválida:
/// sem cifra só os não-segredos podem ser gravados (a API responde 503).
pub fn from_env() -> Option<Cifra> {
    let b64 = std::env::var("TANIA_CONFIG_KEY").ok()?;
    if b64.trim().is_empty() {
        return None;
    }
    Cifra::from_base64(&b64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // vetor da spec: chave 32×0x01, nonce 12×0x02, texto "segredo-123"
    const CHAVE_VETOR: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const VALOR_VETOR: &str = "v1:AgICAgICAgICAgICdLOuOy8zrtDi/o+FiZpSjLX0DVK6OayjlgMf";

    fn cifra_de(bytes: [u8; 32]) -> Cifra {
        Cifra::from_base64(&BASE64_STANDARD.encode(bytes)).expect("chave deveria ser válida")
    }

    #[test]
    fn vetor_da_spec() {
        let cifra = Cifra::from_base64(CHAVE_VETOR).expect("chave da spec deveria ser válida");
        assert_eq!(
            cifra.cifrar_com_nonce("segredo-123", [2u8; 12]),
            VALOR_VETOR
        );
        assert_eq!(cifra.decifrar(VALOR_VETOR).as_deref(), Some("segredo-123"));
    }

    #[test]
    fn ida_e_volta_com_nonce_aleatorio() {
        let cifra = cifra_de([0x01; 32]);
        let valor = cifra.cifrar("sk-abc123");
        assert!(valor.starts_with("v1:"));
        // nonce aleatório: cifrar duas vezes dá valores diferentes
        assert_ne!(valor, cifra.cifrar("sk-abc123"));
        assert_eq!(cifra.decifrar(&valor).as_deref(), Some("sk-abc123"));
    }

    #[test]
    fn texto_vazio_round_trip() {
        let cifra = cifra_de([0x07; 32]);
        let valor = cifra.cifrar("");
        assert_eq!(cifra.decifrar(&valor).as_deref(), Some(""));
    }

    #[test]
    fn chave_diferente_nao_decifra() {
        let certa = cifra_de([0x01; 32]);
        let errada = cifra_de([0x03; 32]);
        let valor = certa.cifrar("segredo-123");
        assert!(errada.decifrar(&valor).is_none());
    }

    #[test]
    fn valores_ruins_dao_none() {
        let cifra = cifra_de([0x01; 32]);
        assert!(cifra.decifrar("lixo").is_none());
        assert!(cifra.decifrar("v1:xx").is_none());
        assert!(cifra.decifrar("").is_none());
        assert!(cifra.decifrar("v1:").is_none());
        // nonce + tag mínimos, mas a tag não confere
        let blob = vec![2u8; NONCE_LEN + TAG_LEN];
        assert!(cifra
            .decifrar(&format!("{VERSAO}{}", BASE64_STANDARD.encode(&blob)))
            .is_none());
    }

    #[test]
    fn chave_com_tamanho_errado_da_none() {
        let curta = BASE64_STANDARD.encode(vec![0x01u8; 16]);
        assert!(Cifra::from_base64(&curta).is_none());
        let longa = BASE64_STANDARD.encode(vec![0x01u8; 33]);
        assert!(Cifra::from_base64(&longa).is_none());
        assert!(Cifra::from_base64("not base64 at all").is_none());
        assert!(Cifra::from_base64("").is_none());
    }

    #[test]
    fn from_env_com_e_sem_chave() {
        std::env::set_var("TANIA_CONFIG_KEY", CHAVE_VETOR);
        assert!(from_env().is_some());
        std::env::set_var("TANIA_CONFIG_KEY", "");
        assert!(from_env().is_none());
        std::env::set_var("TANIA_CONFIG_KEY", "   ");
        assert!(from_env().is_none());
        std::env::set_var("TANIA_CONFIG_KEY", "chave-invalida");
        assert!(from_env().is_none());
        std::env::remove_var("TANIA_CONFIG_KEY");
    }
}
