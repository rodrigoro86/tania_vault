//! `local.rs` — VaultStore sobre o filesystem (dev / fallback / `VAULT_STORAGE=local`).
//! Porte fiel de `app/server/storage/local.mjs`.

use std::io;
use std::pin::Pin;
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use futures_util::stream::Stream;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::storage::constants::{file_type, is_note, is_skipped};
use crate::storage::{FileEntry, KeyInfo, Listing, NoteEntry, Stat, StoreError};

/// `path.normalize(path.join(root, rel))` — separador sempre `/`.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<String> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// `path.resolve(...)` raiz do vault: absoluta fica como está, relativa vira
/// absoluta em relação ao cwd.
fn resolve_root(raw: &str) -> String {
    if raw.starts_with('/') {
        return normalize(raw);
    }
    match std::env::current_dir() {
        Ok(cwd) => normalize(&format!("{}/{}", cwd.display(), raw)),
        Err(_) => normalize(raw),
    }
}

#[derive(Debug, Clone)]
pub struct LocalFs {
    root: String,
    label: String,
}

impl LocalFs {
    pub fn new(root: &str) -> Self {
        let root = resolve_root(root);
        Self {
            label: root.clone(),
            root,
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn label(&self) -> String {
        self.label.clone()
    }

    fn abs(&self, rel: &str) -> String {
        normalize(&format!("{}/{}", self.root, rel))
    }

    pub async fn list(&self) -> Result<Listing, StoreError> {
        let mut notes: Vec<NoteEntry> = Vec::new();
        let mut folders: Vec<String> = Vec::new();
        let mut files: Vec<FileEntry> = Vec::new();

        // pilha (sem recursão): (diretório absoluto, caminho relativo à raiz)
        let mut stack: Vec<(String, String)> = vec![(self.root.clone(), String::new())];

        while let Some((dir, rel)) = stack.pop() {
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name();
                let name = name.to_string_lossy().to_string();
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                let child_abs = format!("{dir}/{name}");

                if entry_is_dir(&entry).await {
                    if is_skipped(&name) || name.starts_with('.') {
                        continue;
                    }
                    folders.push(child_rel.clone());
                    stack.push((child_abs, child_rel));
                } else if name.starts_with('.') {
                    continue;
                } else if is_note(&name) {
                    let raw = tokio::fs::read(&child_abs)
                        .await
                        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())?;
                    notes.push(NoteEntry {
                        path: child_rel,
                        raw,
                    });
                } else if let Some(kind) = file_type(&name) {
                    let size = tokio::fs::metadata(&child_abs)
                        .await
                        .map(|meta| meta.len())
                        .unwrap_or(0);
                    files.push(FileEntry {
                        path: child_rel,
                        size,
                        kind: kind.kind,
                    });
                }
            }
        }

        notes.sort_by(|a, b| a.path.cmp(&b.path));
        folders.sort();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Listing {
            notes,
            folders,
            files,
        })
    }

    pub async fn read_text(&self, rel: &str) -> Result<String, StoreError> {
        let bytes = tokio::fs::read(self.abs(rel)).await?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    pub async fn read(&self, rel: &str) -> Result<Vec<u8>, StoreError> {
        Ok(tokio::fs::read(self.abs(rel)).await?)
    }

    pub async fn write_text(&self, rel: &str, text: &str) -> Result<(), StoreError> {
        self.write(rel, text.as_bytes()).await
    }

    pub async fn write(&self, rel: &str, data: &[u8]) -> Result<(), StoreError> {
        let path = self.abs(rel);
        if let Some(parent) = parent_of(&path) {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&path, data).await?;
        Ok(())
    }

    pub async fn remove(&self, rel: &str) -> Result<(), StoreError> {
        tokio::fs::remove_file(self.abs(rel)).await?;
        Ok(())
    }

    pub async fn mkdir(&self, rel: &str) -> Result<(), StoreError> {
        tokio::fs::create_dir_all(self.abs(rel)).await?;
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), StoreError> {
        let to_abs = self.abs(to);
        if let Some(parent) = parent_of(&to_abs) {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(self.abs(from), to_abs).await?;
        Ok(())
    }

    pub async fn exists(&self, rel: &str) -> Result<bool, StoreError> {
        Ok(tokio::fs::metadata(self.abs(rel)).await.is_ok())
    }

    pub async fn dir_exists(&self, rel: &str) -> Result<bool, StoreError> {
        match tokio::fs::metadata(self.abs(rel)).await {
            Ok(meta) => Ok(meta.is_dir()),
            Err(_) => Ok(false),
        }
    }

    pub async fn is_empty_dir(&self, rel: &str) -> Result<bool, StoreError> {
        let path = self.abs(rel);
        let mut entries = match tokio::fs::read_dir(&path).await {
            Ok(entries) => entries,
            Err(_) => return Ok(true),
        };
        Ok(entries.next_entry().await?.is_none())
    }

    pub async fn remove_dir(&self, rel: &str) -> Result<(), StoreError> {
        match tokio::fs::remove_dir_all(self.abs(rel)).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    pub async fn list_keys(&self, prefix: &str) -> Result<Vec<KeyInfo>, StoreError> {
        let base = self.abs(prefix);
        let prefix_rel = prefix.trim_end_matches('/');
        let mut out: Vec<KeyInfo> = Vec::new();
        let mut stack: Vec<(String, String)> = vec![(base, prefix_rel.to_string())];

        while let Some((dir, rel)) = stack.pop() {
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                let child_abs = format!("{dir}/{name}");
                if entry_is_dir(&entry).await {
                    stack.push((child_abs, child_rel));
                } else {
                    let size = tokio::fs::metadata(&child_abs)
                        .await
                        .map(|meta| meta.len())
                        .unwrap_or(0);
                    out.push(KeyInfo {
                        key: child_rel,
                        size,
                    });
                }
            }
        }
        Ok(out)
    }

    pub async fn stat(&self, rel: &str) -> Result<Stat, StoreError> {
        let meta = tokio::fs::metadata(self.abs(rel)).await?;
        let mtime_ms = match meta.modified() {
            Ok(modified) => match modified.duration_since(UNIX_EPOCH) {
                Ok(dur) => dur.as_millis() as i64,
                Err(_) => 0,
            },
            Err(_) => 0,
        };
        Ok(Stat {
            size: meta.len(),
            mtime_ms,
        })
    }

    /// `createReadStream(abs(rel), { start, end })` — `end` inclusivo.
    pub async fn read_stream(
        &self,
        rel: &str,
        start: Option<u64>,
        end: Option<u64>,
    ) -> Result<Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>, StoreError> {
        let mut file = tokio::fs::File::open(self.abs(rel)).await?;
        let start = start.unwrap_or(0);
        if start > 0 {
            file.seek(io::SeekFrom::Start(start)).await?;
        }
        // `end` é inclusivo, como em createReadStream; sem `end`, lê até o fim
        let limit = match end {
            Some(end) if end >= start => end - start + 1,
            Some(_) => 0,
            None => u64::MAX,
        };
        Ok(Box::pin(tokio_util::io::ReaderStream::new(
            file.take(limit),
        )))
    }

    /// local não precisa de URL assinada: `/files/` streama direto
    pub fn presign(&self, _rel: &str, _download: bool) -> Option<String> {
        None
    }
}

fn parent_of(path: &str) -> Option<&str> {
    path.rfind('/').map(|index| &path[..index])
}

/// `entry.isDirectory()` do Node
async fn entry_is_dir(entry: &tokio::fs::DirEntry) -> bool {
    match entry.file_type().await {
        Ok(file_type) => file_type.is_dir(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolve_pontos_e_pai() {
        assert_eq!(normalize("/a/b/../c/./d"), "/a/c/d");
        assert_eq!(normalize("/vault/"), "/vault");
        let root = resolve_root("");
        assert!(root.starts_with('/'));
    }
}
