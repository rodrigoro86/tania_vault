//! `mod.rs` — fábrica do VaultStore (LocalFs | S3/MinIO) e dispatch por enum.
//! Porte fiel de `app/server/storage/index.mjs`: `VAULT_STORAGE=rustfs|minio|s3` ->
//! MinIO; qualquer outro valor -> filesystem local.
//!
//! Sem `dyn` nem `async-trait`: cada método de `Store` faz `match self`.

pub mod constants;
pub mod local;
pub mod s3;

use std::env;
use std::io;
use std::pin::Pin;

use bytes::Bytes;
use futures_util::stream::Stream;
use serde::Serialize;
use thiserror::Error;

use local::LocalFs;
use s3::S3Store;

pub use constants::FileType;

#[derive(Debug, Clone, Serialize)]
pub struct NoteEntry {
    pub path: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct Listing {
    pub notes: Vec<NoteEntry>,
    pub folders: Vec<String>,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyInfo {
    pub key: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stat {
    pub size: u64,
    /// JSON: `mtimeMs`, como no Node
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: i64,
}

pub type ByteStream = Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("não encontrado: {0}")]
    NotFound(String),
    #[error("erro de filesystem: {0}")]
    Io(#[from] io::Error),
    #[error("erro S3/MinIO: {0}")]
    S3(String),
    #[error("configuração inválida: {0}")]
    Config(String),
}

#[derive(Debug, Clone)]
pub enum Store {
    Local(LocalFs),
    S3(S3Store),
}

impl Store {
    /// `createStore(VAULT_STORAGE)` do Node.
    pub fn from_env() -> Result<Store, StoreError> {
        let mode = env::var("VAULT_STORAGE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if mode == "rustfs" || mode == "minio" || mode == "s3" {
            Ok(Store::S3(S3Store::from_env()?))
        } else {
            // o binário roda de `backend/`; a raiz do repo é o vault
            let root = env::var("VAULT_ROOT").unwrap_or_else(|_| "..".to_string());
            Ok(Store::Local(LocalFs::new(&root)))
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Store::Local(_) => "local",
            Store::S3(_) => "s3",
        }
    }

    pub fn label(&self) -> String {
        match self {
            Store::Local(store) => store.label(),
            Store::S3(store) => store.label(),
        }
    }

    pub async fn list(&self) -> Result<Listing, StoreError> {
        match self {
            Store::Local(store) => store.list().await,
            Store::S3(store) => store.list().await,
        }
    }

    pub async fn list_keys(&self, prefix: &str) -> Result<Vec<KeyInfo>, StoreError> {
        match self {
            Store::Local(store) => store.list_keys(prefix).await,
            Store::S3(store) => store.list_keys(prefix).await,
        }
    }

    pub async fn read(&self, rel: &str) -> Result<Vec<u8>, StoreError> {
        match self {
            Store::Local(store) => store.read(rel).await,
            Store::S3(store) => store.read(rel).await,
        }
    }

    pub async fn read_text(&self, rel: &str) -> Result<String, StoreError> {
        match self {
            Store::Local(store) => store.read_text(rel).await,
            Store::S3(store) => store.read_text(rel).await,
        }
    }

    pub async fn write(&self, rel: &str, data: &[u8]) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.write(rel, data).await,
            Store::S3(store) => store.write(rel, data).await,
        }
    }

    pub async fn write_text(&self, rel: &str, text: &str) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.write_text(rel, text).await,
            Store::S3(store) => store.write_text(rel, text).await,
        }
    }

    pub async fn remove(&self, rel: &str) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.remove(rel).await,
            Store::S3(store) => store.remove(rel).await,
        }
    }

    pub async fn remove_dir(&self, rel: &str) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.remove_dir(rel).await,
            Store::S3(store) => store.remove_dir(rel).await,
        }
    }

    pub async fn mkdir(&self, rel: &str) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.mkdir(rel).await,
            Store::S3(store) => store.mkdir(rel).await,
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), StoreError> {
        match self {
            Store::Local(store) => store.rename(from, to).await,
            Store::S3(store) => store.rename(from, to).await,
        }
    }

    pub async fn exists(&self, rel: &str) -> Result<bool, StoreError> {
        match self {
            Store::Local(store) => store.exists(rel).await,
            Store::S3(store) => store.exists(rel).await,
        }
    }

    pub async fn dir_exists(&self, rel: &str) -> Result<bool, StoreError> {
        match self {
            Store::Local(store) => store.dir_exists(rel).await,
            Store::S3(store) => store.dir_exists(rel).await,
        }
    }

    pub async fn is_empty_dir(&self, rel: &str) -> Result<bool, StoreError> {
        match self {
            Store::Local(store) => store.is_empty_dir(rel).await,
            Store::S3(store) => store.is_empty_dir(rel).await,
        }
    }

    pub async fn stat(&self, rel: &str) -> Result<Stat, StoreError> {
        match self {
            Store::Local(store) => store.stat(rel).await,
            Store::S3(store) => store.stat(rel).await,
        }
    }

    pub async fn read_stream(
        &self,
        rel: &str,
        start: Option<u64>,
        end: Option<u64>,
    ) -> Result<ByteStream, StoreError> {
        match self {
            Store::Local(store) => store.read_stream(rel, start, end).await,
            Store::S3(store) => store.read_stream(rel, start, end).await,
        }
    }

    /// local não precisa de URL assinada: `/files/` streama direto
    pub async fn presign(&self, rel: &str, download: bool) -> Result<Option<String>, StoreError> {
        match self {
            Store::Local(_) => Ok(None),
            Store::S3(store) => store.presign(rel, download).await,
        }
    }
}
