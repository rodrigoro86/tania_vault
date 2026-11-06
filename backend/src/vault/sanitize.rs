//! Validação de caminhos do vault — porte fiel de `sanitize()` de
//! `app/server/vault-api.mjs`.
//!
//! Bloqueia traversal (`..`, segmentos vazios, percent-encoding de `/` e `.`)
//! e pastas que não fazem parte do vault (`SKIP_DIRS` e qualquer segmento
//! que começa com `.`).
//!
//! `sanitize_file` / `sanitize_upload` são a variante para anexos: exige uma
//! extensão da lista de `file_type` (415) e, no upload, nomes ASCII em todos
//! os segmentos (400).

use axum::http::StatusCode;

use crate::error::ApiError;
use crate::storage::constants::{file_type, is_note, is_skipped, FileType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Note,
    Folder,
}

fn http(status: StatusCode, msg: &str) -> ApiError {
    ApiError::Http(status, msg.to_string())
}

/// Devolve o caminho relativo limpo, ou um `ApiError` com o status do Node.
pub fn sanitize(raw: Option<&str>, kind: Kind) -> Result<String, ApiError> {
    let Some(raw) = raw else {
        return Err(http(StatusCode::BAD_REQUEST, "path é obrigatório"));
    };
    if raw.trim().is_empty() {
        return Err(http(StatusCode::BAD_REQUEST, "path é obrigatório"));
    }

    // `\` vira `/`, tira espaços e barras de começo (exatamente como o Node)
    let rel = raw
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_string();
    if rel.is_empty() {
        return Err(http(StatusCode::BAD_REQUEST, "path inválido"));
    }

    let parts: Vec<&str> = rel.split('/').collect();
    // `%2e`/`%2f`/`%5c` são traversal disfrazado: barrar antes de qualquer coisa
    let lower = rel.to_ascii_lowercase();
    if parts
        .iter()
        .copied()
        .any(|part| part.is_empty() || part == "." || part == "..")
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return Err(http(
            StatusCode::BAD_REQUEST,
            "path inválido (.. não é permitido)",
        ));
    }

    let top = parts
        .first()
        .copied()
        .expect("rel não-vazio tem pelo menos um segmento");
    if is_skipped(top) || top.starts_with('.') {
        return Err(http(
            StatusCode::FORBIDDEN,
            &format!("{top}/ não faz parte do vault"),
        ));
    }

    if kind == Kind::Note {
        if !is_note(&rel) {
            return Err(http(
                StatusCode::BAD_REQUEST,
                "nota precisa terminar em .md ou .base",
            ));
        }
        if rel == "AGENTS.md" {
            return Err(http(StatusCode::FORBIDDEN, "AGENTS.md é protegido"));
        }
    }

    Ok(rel)
}

/// Caminho de arquivo do vault: normaliza, barra traversal e pastas de fora,
/// e exige uma extensão da lista de anexos (`file_type`).
/// Devolve `(rel, FileType)`.
pub fn sanitize_file(raw: Option<&str>) -> Result<(String, FileType), ApiError> {
    let Some(raw) = raw else {
        return Err(http(StatusCode::BAD_REQUEST, "path é obrigatório"));
    };
    if raw.trim().is_empty() {
        return Err(http(StatusCode::BAD_REQUEST, "path é obrigatório"));
    }

    // `\` vira `/`, tira espaços e barras de começo
    let rel = raw
        .replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .to_string();

    let parts: Vec<&str> = rel.split('/').collect();
    if parts
        .iter()
        .copied()
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(http(
            StatusCode::BAD_REQUEST,
            "path inválido (.. não é permitido)",
        ));
    }

    // qualquer nível (não só o primeiro) que começa com `.` ou está em SKIP_DIRS
    for part in &parts {
        if part.starts_with('.') || is_skipped(part) {
            return Err(http(
                StatusCode::FORBIDDEN,
                &format!("{rel} não faz parte do vault"),
            ));
        }
    }

    let Some(tipo) = file_type(&rel) else {
        return Err(http(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            &format!("{rel}: tipo de arquivo não suportado"),
        ));
    };

    Ok((rel, tipo))
}

/// Nome de segmento de upload: primeiro caractere alfanumérico ASCII, resto
/// `[A-Za-z0-9._-]`. Teste manual com `chars()`, sem regex.
fn is_upload_segment(seg: &str) -> bool {
    let mut chars = seg.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Igual a `sanitize_file`, mas cada segmento precisa ser um nome ASCII de
/// upload (`99-Meta/attachments/foto-1.png` ok; `a/minha foto.png` não).
pub fn sanitize_upload(raw: Option<&str>) -> Result<(String, FileType), ApiError> {
    let (rel, tipo) = sanitize_file(raw)?;

    for seg in rel.split('/') {
        if !is_upload_segment(seg) {
            return Err(http(
                StatusCode::BAD_REQUEST,
                &format!("\"{seg}\": use nome ASCII, sem espaço nem acento (hyphens)"),
            ));
        }
    }

    Ok((rel, tipo))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// status + mensagem de um erro esperado
    fn err(raw: &str, kind: Kind) -> (StatusCode, String) {
        let error = sanitize(Some(raw), kind).expect_err("deveria falhar");
        match error {
            ApiError::Http(status, message) => (status, message),
            other => panic!("variante inesperada: {other}"),
        }
    }

    fn ok(raw: &str, kind: Kind) -> String {
        sanitize(Some(raw), kind).expect("caminho válido")
    }

    #[test]
    fn path_obrigatorio() {
        for raw in [None, Some(""), Some("   "), Some("\n\t")] {
            let (status, message) = match sanitize(raw, Kind::Note) {
                Err(ApiError::Http(status, message)) => (status, message),
                other => panic!("erro inesperado: {other:?}"),
            };
            assert_eq!(status, StatusCode::BAD_REQUEST, "{raw:?}");
            assert_eq!(message, "path é obrigatório", "{raw:?}");
        }
    }

    #[test]
    fn traversal_e_percent_encoding_devem_dar_400() {
        // tabela do teste 2 da especificação
        assert_eq!(
            err("../Home.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("00-Inbox/../01-Agenda/x.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("%2e%2e/Home.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        // case-insensitive e também barra %2f / %5c
        assert_eq!(
            err("%2E%2E/Home.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("00-Inbox%2Fx.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("00-Inbox%5cx.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        // segmento vazio e caminho só barra
        assert_eq!(
            err("00-Inbox//x.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("./x.md", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            err("/", Kind::Note),
            (StatusCode::BAD_REQUEST, "path inválido".to_string())
        );
        assert_eq!(
            err("///", Kind::Folder),
            (StatusCode::BAD_REQUEST, "path inválido".to_string())
        );
    }

    #[test]
    fn pastas_fora_do_vault_devem_dar_403() {
        for raw in [
            ".git/config.md",
            ".obsidian/x.md",
            "app/x.md",
            "node_modules/x.md",
            "tmp/x.md",
            ".trash/x.md",
        ] {
            let (status, message) = err(raw, Kind::Note);
            assert_eq!(status, StatusCode::FORBIDDEN, "{raw}");
            assert_eq!(
                message,
                format!(
                    "{}/ não faz parte do vault",
                    raw.split('/').next().expect("top")
                ),
                "{raw}"
            );
        }
        // vale também para pastas
        assert_eq!(
            err(".obsidian", Kind::Folder),
            (
                StatusCode::FORBIDDEN,
                ".obsidian/ não faz parte do vault".to_string()
            )
        );
    }

    #[test]
    fn nota_precisa_ter_extensao_md_ou_base() {
        assert_eq!(
            err("99-Meta/attachments/x.txt", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "nota precisa terminar em .md ou .base".to_string()
            )
        );
        assert_eq!(
            err("Leitura.txt", Kind::Note),
            (
                StatusCode::BAD_REQUEST,
                "nota precisa terminar em .md ou .base".to_string()
            )
        );
        assert!(is_note(&ok("Leitura.base", Kind::Note)));
        assert!(is_note(&ok("Notas/CAP.MD", Kind::Note)));
    }

    #[test]
    fn agents_md_protegido_só_como_nota_na_raiz() {
        // o caso protegido é exatamente "AGENTS.md" na raiz
        assert_eq!(
            err("AGENTS.md", Kind::Note),
            (StatusCode::FORBIDDEN, "AGENTS.md é protegido".to_string())
        );
        // dentro de uma pasta a regra não se aplica (idêntico ao Node)
        assert_eq!(ok("99-Meta/AGENTS.md", Kind::Note), "99-Meta/AGENTS.md");
    }

    #[test]
    fn caminhos_validos_normalizados() {
        assert_eq!(ok("00-Inbox/x.md", Kind::Note), "00-Inbox/x.md");
        assert_eq!(ok("/00-Inbox\\x.md", Kind::Note), "00-Inbox/x.md");
        assert_eq!(ok("  01-Agenda/nota.md  ", Kind::Note), "01-Agenda/nota.md");
        assert_eq!(
            ok("99-Meta/attachments", Kind::Folder),
            "99-Meta/attachments"
        );
        assert_eq!(ok("Home.md", Kind::Note), "Home.md");
        // pasta chamada AGENTS.md não é nota: passa (como no Node)
        assert_eq!(ok("AGENTS.md", Kind::Folder), "AGENTS.md");
    }

    /// status + mensagem de um erro de `sanitize_file`
    fn file_err(raw: &str) -> (StatusCode, String) {
        let error = sanitize_file(Some(raw)).expect_err("deveria falhar");
        match error {
            ApiError::Http(status, message) => (status, message),
            other => panic!("variante inesperada: {other}"),
        }
    }

    /// status + mensagem de um erro de `sanitize_upload`
    fn upload_err(raw: &str) -> (StatusCode, String) {
        let error = sanitize_upload(Some(raw)).expect_err("deveria falhar");
        match error {
            ApiError::Http(status, message) => (status, message),
            other => panic!("variante inesperada: {other}"),
        }
    }

    #[test]
    fn sanitize_file_ok_devolve_rel_e_filetype() {
        let (rel, tipo) = sanitize_file(Some("a/f.png")).expect("caminho válido");
        assert_eq!(rel, "a/f.png");
        assert_eq!(tipo.kind, "image");
        assert_eq!(tipo.mime, "image/png");
        // normalização: `\` -> `/`, espaços, barra inicial
        let (rel, _) = sanitize_file(Some("  /a\\b/f.PNG  ")).expect("normaliza");
        assert_eq!(rel, "a/b/f.PNG");
    }

    #[test]
    fn sanitize_file_path_obrigatorio() {
        for raw in [None, Some(""), Some("   "), Some("\n\t")] {
            let error = sanitize_file(raw).expect_err("deveria falhar");
            let ApiError::Http(status, message) = error else {
                panic!("erro inesperado: {error:?}");
            };
            assert_eq!(status, StatusCode::BAD_REQUEST, "{raw:?}");
            assert_eq!(message, "path é obrigatório", "{raw:?}");
        }
    }

    #[test]
    fn sanitize_file_pasta_oculta_ou_skipped_dá_403_em_qualquer_nível() {
        assert_eq!(
            file_err(".env"),
            (
                StatusCode::FORBIDDEN,
                ".env não faz parte do vault".to_string()
            )
        );
        assert_eq!(
            file_err("app/x.png"),
            (
                StatusCode::FORBIDDEN,
                "app/x.png não faz parte do vault".to_string()
            )
        );
        assert_eq!(
            file_err("a/.oculto.png"),
            (
                StatusCode::FORBIDDEN,
                "a/.oculto.png não faz parte do vault".to_string()
            )
        );
        assert_eq!(
            file_err("00-Inbox/tmp/x.png"),
            (
                StatusCode::FORBIDDEN,
                "00-Inbox/tmp/x.png não faz parte do vault".to_string()
            )
        );
    }

    #[test]
    fn sanitize_file_extensao_desconhecida_dá_415() {
        assert_eq!(
            file_err("a/x.exe"),
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "a/x.exe: tipo de arquivo não suportado".to_string()
            )
        );
        assert_eq!(
            file_err("a/x"),
            (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "a/x: tipo de arquivo não suportado".to_string()
            )
        );
    }

    #[test]
    fn sanitize_file_traversal_e_segmento_vazio_dão_400() {
        assert_eq!(
            file_err("../x.png"),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            file_err("a//x.png"),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
        assert_eq!(
            file_err("a/./x.png"),
            (
                StatusCode::BAD_REQUEST,
                "path inválido (.. não é permitido)".to_string()
            )
        );
    }

    #[test]
    fn sanitize_upload_ok_com_nomes_ascii() {
        let (rel, tipo) =
            sanitize_upload(Some("99-Meta/attachments/foto-1.png")).expect("upload válido");
        assert_eq!(rel, "99-Meta/attachments/foto-1.png");
        assert_eq!(tipo.kind, "image");
        // `a_b.png` e `a.b.c.png` são nomes válidos
        assert_eq!(
            sanitize_upload(Some("01/9_2024-01.txt"))
                .map(|(rel, _)| rel)
                .ok(),
            Some("01/9_2024-01.txt".to_string())
        );
    }

    #[test]
    fn sanitize_upload_nome_com_espaço_acento_ou_underline_inicial_dá_400() {
        for raw in ["a/minha foto.png", "a/ção.png", "a/_x.png"] {
            let (status, message) = upload_err(raw);
            let seg = raw.split('/').nth(1).expect("segmento");
            assert_eq!(status, StatusCode::BAD_REQUEST, "{raw}");
            assert_eq!(
                message,
                format!("\"{seg}\": use nome ASCII, sem espaço nem acento (hyphens)"),
                "{raw}"
            );
        }
    }
}
