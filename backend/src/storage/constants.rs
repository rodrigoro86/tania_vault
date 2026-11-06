//! constantes compartilhados entre a API e os stores (porte fiel de
//! `app/server/storage/constants.mjs`).
//!
//! Ficam aqui (e não no módulo do vault) para o store não importar a camada de
//! vault — evita ciclo.

/// nota do vault = markdown ou base (`NOTE_EXT = /\.(md|base)$/i`)
pub fn is_note(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".base")
}

/// pastas que nunca fazem parte do vault
pub const SKIP_DIRS: &[&str] = &[
    ".obsidian",
    ".git",
    ".github",
    "node_modules",
    "app",
    "agents",
    "backend", // código Rust (inclui target/ do cargo)
    "front",
    "dist",
    "dist-smoke",
    "tmp",
    ".trash",
];

pub fn is_skipped(segment: &str) -> bool {
    SKIP_DIRS.contains(&segment)
}

/// anexos servidos em `/files/<caminho>`; lista fechada de extensões
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileType {
    pub mime: &'static str,
    pub kind: &'static str,
    pub sandbox: bool,
    pub text: bool,
}

const fn ty(mime: &'static str, kind: &'static str) -> FileType {
    FileType {
        mime,
        kind,
        sandbox: false,
        text: false,
    }
}

const fn ty_text(mime: &'static str, kind: &'static str) -> FileType {
    FileType {
        mime,
        kind,
        sandbox: true,
        text: true,
    }
}

/// última extensão (minúscula) do nome, como `/\.([a-z0-9]+)$/i` do Node
fn extension(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    let tail = &name[dot + 1..];
    if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(tail.to_ascii_lowercase())
}

/// `fileType(name)` -> `Option<FileType>` (`null` quando a extensão não está na lista)
pub fn file_type(name: &str) -> Option<FileType> {
    let ext = extension(name)?;
    Some(match ext.as_str() {
        "png" => ty("image/png", "image"),
        "jpg" | "jpeg" => ty("image/jpeg", "image"),
        "gif" => ty("image/gif", "image"),
        "webp" => ty("image/webp", "image"),
        "avif" => ty("image/avif", "image"),
        "bmp" => ty("image/bmp", "image"),
        "svg" => ty_text("image/svg+xml", "image"),
        "html" | "htm" => ty_text("text/html; charset=utf-8", "html"),
        "pdf" => ty("application/pdf", "pdf"),
        "pptx" => ty(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "office",
        ),
        "docx" => ty(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "office",
        ),
        "xlsx" => ty(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "office",
        ),
        "csv" => ty_text("text/csv; charset=utf-8", "text"),
        "txt" => ty_text("text/plain; charset=utf-8", "text"),
        "mp4" => ty("video/mp4", "video"),
        "webm" => ty("video/webm", "video"),
        "mp3" => ty("audio/mpeg", "audio"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_ext_case_insensitive_e_só_extensao_final() {
        assert!(is_note("a.MD"));
        assert!(is_note("a.md"));
        assert!(is_note("x.BASE"));
        assert!(!is_note("a.md.bak"));
        assert!(!is_note("md"));
        assert!(!is_note("a.txt"));
    }

    #[test]
    fn file_type_extensoes_conhecidas() {
        let png = file_type("X.PNG").expect("png");
        assert_eq!(png.kind, "image");
        assert_eq!(png.mime, "image/png");
        assert_eq!(file_type("a.txt").expect("txt").kind, "text");
        assert!(file_type("a.exe").is_none());
        assert!(file_type("a").is_none());
        assert!(file_type("a.").is_none());
        assert!(file_type("a.SVG").expect("svg").sandbox);
    }
}
