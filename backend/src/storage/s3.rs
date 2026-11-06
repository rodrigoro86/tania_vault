//! `s3.rs` — VaultStore sobre MinIO/S3 (`VAULT_STORAGE=minio`).
//! Porte fiel de `app/server/storage/s3.mjs`: "pastas" são prefixes; rename =
//! copy+delete; `mkdir` grava um marcador oculto.

use std::collections::HashSet;
use std::env;
use std::time::Duration;

use aws_sdk_s3::config::{BehaviorVersion, Builder, Credentials, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use bytes::Bytes;
use futures_util::stream::StreamExt;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tokio::io::AsyncReadExt;

use crate::storage::constants::{file_type, is_note, is_skipped};
use crate::storage::{ByteStream, FileEntry, KeyInfo, Listing, NoteEntry, Stat, StoreError};

/// S3 não tem pasta vazia: este objeto mantém o prefixo; `list()` não o mostra
/// (sem extensão conhecida).
const FOLDER_MARKER: &str = ".keep";

/// equivalente de `encodeURIComponent` (deixa `- _ . ! ~ * ' ( )` intactos)
const JS_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// resultado de `parseEndpoint` do Node: endpoint já com scheme
struct Endpoint {
    endpoint: String,
    #[allow(dead_code)]
    ssl: bool,
}

/// aceita "https://host/", "host:9000" e `RUSTFS_USE_SSL` booleano/string
fn parse_endpoint(raw: &str, use_ssl: &str) -> Endpoint {
    let mut s = raw.trim().to_string();
    let flag = use_ssl.trim().to_ascii_lowercase();
    let mut ssl = flag == "true" || flag == "1" || flag == "yes";

    let lower = s.to_ascii_lowercase();
    if lower.starts_with("https://") {
        ssl = true;
        s = s[8..].to_string();
    } else if lower.starts_with("http://") {
        ssl = false;
        s = s[7..].to_string();
    }
    while s.ends_with('/') {
        s.pop();
    }
    Endpoint {
        endpoint: format!("{}://{}", if ssl { "https" } else { "http" }, s),
        ssl,
    }
}

/// RUSTFS_* é o nome atual; MINIO_* continua valendo.
/// shortcut: fallback até renomear o .env de produção, depois remova
fn s3_env(name: &str) -> String {
    let current = env_or_empty(&format!("RUSTFS_{name}"));
    if current.is_empty() {
        env_or_empty(&format!("MINIO_{name}"))
    } else {
        current
    }
}

fn env_or_empty(key: &str) -> String {
    env::var(key).unwrap_or_default()
}

fn build_client(endpoint: &str, region: &str, access: &str, secret: &str) -> Client {
    let mut builder = Builder::new()
        .region(Region::new(region.to_string()))
        .endpoint_url(endpoint.to_string())
        .force_path_style(true)
        .behavior_version(BehaviorVersion::latest());
    if !access.is_empty() && !secret.is_empty() {
        builder = builder.credentials_provider(Credentials::new(
            access.to_string(),
            secret.to_string(),
            None,
            None,
            "env",
        ));
    }
    Client::from_conf(builder.build())
}

#[derive(Debug, Clone)]
pub struct S3Store {
    bucket: String,
    label: String,
    client: Client,
    /// endpoint público só para URLs assinadas (o browser não resolve "minio:9000")
    public_client: Client,
    presign_ttl: Duration,
}

impl S3Store {
    pub fn from_env() -> Result<Self, StoreError> {
        let bucket = s3_env("BUCKET");
        if bucket.is_empty() {
            return Err(StoreError::Config(
                "S3Store: RUSTFS_BUCKET não definido".to_string(),
            ));
        }
        Self::new(
            &bucket,
            &s3_env("ENDPOINT"),
            &s3_env("USE_SSL"),
            &s3_env("ACCESS_KEY"),
            &s3_env("SECRET_KEY"),
            &s3_env("PUBLIC_ENDPOINT"),
            &s3_env("REGION"),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bucket: &str,
        endpoint: &str,
        use_ssl: &str,
        access: &str,
        secret: &str,
        public_endpoint: &str,
        region: &str,
    ) -> Result<Self, StoreError> {
        if bucket.is_empty() {
            return Err(StoreError::Config(
                "S3Store: RUSTFS_BUCKET não definido".to_string(),
            ));
        }
        let ep = parse_endpoint(endpoint, use_ssl);
        let region = if region.is_empty() {
            "us-east-1".to_string()
        } else {
            region.to_string()
        };
        let ttl = s3_env("PRESIGN_TTL").parse::<u64>().unwrap_or(300);

        let client = build_client(&ep.endpoint, &region, access, secret);
        // `RUSTFS_PUBLIC_ENDPOINT` sempre implica https (parseEndpoint(.., true) do Node)
        let public_client = if public_endpoint.is_empty() {
            client.clone()
        } else {
            build_client(
                &parse_endpoint(public_endpoint, "true").endpoint,
                &region,
                access,
                secret,
            )
        };

        Ok(Self {
            label: format!("s3://{bucket} ({})", ep.endpoint),
            bucket: bucket.to_string(),
            client,
            public_client,
            presign_ttl: Duration::from_secs(ttl),
        })
    }

    pub fn label(&self) -> String {
        self.label.clone()
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    /// lista todas as chaves (paginado)
    pub async fn list_keys(&self, prefix: &str) -> Result<Vec<KeyInfo>, StoreError> {
        let mut out: Vec<KeyInfo> = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);
            if let Some(next) = &token {
                request = request.continuation_token(next.clone());
            }
            let response = request.send().await.map_err(s3_err)?;
            for object in response.contents() {
                if let Some(key) = object.key() {
                    out.push(KeyInfo {
                        key: key.to_string(),
                        size: object.size().unwrap_or(0).max(0) as u64,
                    });
                }
            }
            if response.is_truncated().unwrap_or(false) {
                token = response
                    .next_continuation_token()
                    .map(|value| value.to_string());
                if token.is_none() {
                    break;
                }
            } else {
                break;
            }
        }
        Ok(out)
    }

    pub async fn list(&self) -> Result<Listing, StoreError> {
        let objects = self.list_keys("").await?;
        let mut files: Vec<FileEntry> = Vec::new();
        let mut folders: HashSet<String> = HashSet::new();
        let mut note_keys: Vec<String> = Vec::new();

        for object in objects {
            let key = object.key.clone();
            let parts: Vec<&str> = key.split('/').collect();
            let top = parts[0];
            if is_skipped(top) || top.starts_with('.') {
                continue;
            }
            for index in 1..parts.len() {
                folders.insert(parts[..index].join("/"));
            }
            let name = parts[parts.len() - 1];
            if is_note(name) {
                note_keys.push(key);
            } else if let Some(kind) = file_type(name) {
                files.push(FileEntry {
                    path: key,
                    size: object.size,
                    kind: kind.kind,
                });
            }
        }

        // leitura das notas em paralelo (buffer_unordered(16)); erro de leitura -> raw = ""
        let mut notes: Vec<NoteEntry> =
            futures_util::stream::iter(note_keys.into_iter().map(|key| async move {
                // erro de leitura -> nota vazia, igual ao Node
                let raw = self.read_text(&key).await.unwrap_or_default();
                NoteEntry { path: key, raw }
            }))
            .buffer_unordered(16)
            .collect()
            .await;

        let mut folders: Vec<String> = folders.into_iter().collect();
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
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(rel)
            .send()
            .await
            .map_err(s3_err)?;
        let mut body = Vec::new();
        output.body.into_async_read().read_to_end(&mut body).await?;
        Ok(String::from_utf8_lossy(&body).to_string())
    }

    pub async fn read(&self, rel: &str) -> Result<Vec<u8>, StoreError> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(rel)
            .send()
            .await
            .map_err(s3_err)?;
        let mut body = Vec::new();
        output.body.into_async_read().read_to_end(&mut body).await?;
        Ok(body)
    }

    pub async fn write_text(&self, rel: &str, text: &str) -> Result<(), StoreError> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(rel)
            .body(Bytes::from(text.to_string()).into())
            .content_type("text/markdown; charset=utf-8")
            .send()
            .await
            .map_err(s3_err)?;
        Ok(())
    }

    pub async fn write(&self, rel: &str, data: &[u8]) -> Result<(), StoreError> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(rel)
            .body(Bytes::from(data.to_vec()).into())
            .send()
            .await
            .map_err(s3_err)?;
        Ok(())
    }

    pub async fn remove(&self, rel: &str) -> Result<(), StoreError> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(rel)
            .send()
            .await
            .map_err(s3_err)?;
        Ok(())
    }

    pub async fn mkdir(&self, rel: &str) -> Result<(), StoreError> {
        self.write(&format!("{rel}/{FOLDER_MARKER}"), b"").await
    }

    async fn copy_object(&self, from: &str, to: &str) -> Result<(), StoreError> {
        let source = format!(
            "{}/{}",
            self.bucket,
            from.split('/')
                .map(|segment| utf8_percent_encode(segment, JS_ENCODE).to_string())
                .collect::<Vec<String>>()
                .join("/")
        );
        self.client
            .copy_object()
            .bucket(&self.bucket)
            .copy_source(source)
            .key(to)
            .send()
            .await
            .map_err(s3_err)?;
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), StoreError> {
        if self.exists(from).await? {
            self.copy_object(from, to).await?;
            return self.remove(from).await;
        }
        // pasta: move todos os objetos sob o prefixo
        let keys = self.list_keys(&format!("{from}/")).await?;
        for info in keys {
            let target = format!("{to}/{}", &info.key[from.len() + 1..]);
            self.copy_object(&info.key, &target).await?;
            self.remove(&info.key).await?;
        }
        Ok(())
    }

    pub async fn exists(&self, rel: &str) -> Result<bool, StoreError> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(rel)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(err) => {
                if is_not_found(&err) {
                    Ok(false)
                } else {
                    Err(s3_err(err))
                }
            }
        }
    }

    pub async fn dir_exists(&self, rel: &str) -> Result<bool, StoreError> {
        let response = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(format!("{rel}/"))
            .max_keys(1)
            .send()
            .await
            .map_err(s3_err)?;
        Ok(response.key_count().unwrap_or(0) > 0)
    }

    pub async fn is_empty_dir(&self, rel: &str) -> Result<bool, StoreError> {
        let response = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(format!("{rel}/"))
            .max_keys(2)
            .send()
            .await
            .map_err(s3_err)?;
        let marker = format!("{rel}/{FOLDER_MARKER}");
        Ok(!response
            .contents()
            .iter()
            .any(|object| object.key() != Some(marker.as_str())))
    }

    pub async fn remove_dir(&self, rel: &str) -> Result<(), StoreError> {
        let keys = self.list_keys(&format!("{rel}/")).await?;
        for info in keys {
            self.remove(&info.key).await?;
        }
        Ok(())
    }

    pub async fn stat(&self, rel: &str) -> Result<Stat, StoreError> {
        let output = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(rel)
            .send()
            .await
            .map_err(s3_err)?;
        let mtime_ms = match output.last_modified().cloned() {
            Some(date) => date.to_millis().unwrap_or_else(|_| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|dur| dur.as_millis() as i64)
                    .unwrap_or(0)
            }),
            None => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|dur| dur.as_millis() as i64)
                .unwrap_or(0),
        };
        Ok(Stat {
            size: output.content_length().unwrap_or(0).max(0) as u64,
            mtime_ms,
        })
    }

    pub async fn read_stream(
        &self,
        rel: &str,
        start: Option<u64>,
        end: Option<u64>,
    ) -> Result<ByteStream, StoreError> {
        let mut request = self.client.get_object().bucket(&self.bucket).key(rel);
        if start.is_some() || end.is_some() {
            let range = format!(
                "bytes={}-{}",
                start.unwrap_or(0),
                end.map_or(String::new(), |value| value.to_string())
            );
            request = request.range(range);
        }
        let output = request.send().await.map_err(s3_err)?;
        Ok(Box::pin(tokio_util::io::ReaderStream::new(
            output.body.into_async_read(),
        )))
    }

    pub async fn presign(&self, rel: &str, download: bool) -> Result<Option<String>, StoreError> {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let mut request = self
            .public_client
            .get_object()
            .bucket(&self.bucket)
            .key(rel);
        if download {
            request = request.response_content_disposition(format!(
                "attachment; filename*=UTF-8''{}",
                utf8_percent_encode(name, JS_ENCODE)
            ));
        }
        let config = PresigningConfig::expires_in(self.presign_ttl)
            .map_err(|err| StoreError::Config(err.to_string()))?;
        let signed = request.presigned(config).await.map_err(s3_err)?;
        Ok(Some(signed.uri().to_string()))
    }
}

// Display curto: o Debug do SdkError traz a resposta HTTP crua, que pode chegar ao cliente num 500
fn s3_err<E, R>(err: SdkError<E, R>) -> StoreError
where
    E: std::error::Error + 'static,
    R: std::fmt::Debug,
{
    StoreError::S3(aws_sdk_s3::error::DisplayErrorContext(&err).to_string())
}

/// 404 / NotFound / NoSuchKey -> "não existe" (igual ao `catch` do Node)
fn is_not_found(err: &SdkError<aws_sdk_s3::operation::head_object::HeadObjectError>) -> bool {
    match err.as_service_error() {
        Some(service) => service.is_not_found(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rustfs_tem_prioridade_e_minio_continua_valendo() {
        // nome exclusivo deste teste: env é global ao processo
        std::env::set_var("MINIO_ZZ_FALLBACK", "antigo");
        assert_eq!(s3_env("ZZ_FALLBACK"), "antigo");
        std::env::set_var("RUSTFS_ZZ_FALLBACK", "novo");
        assert_eq!(s3_env("ZZ_FALLBACK"), "novo");
        assert_eq!(s3_env("ZZ_NAO_EXISTE"), "");
    }

    #[test]
    fn parse_endpoint_porta_os_formatos_do_node() {
        assert_eq!(parse_endpoint("https://host/", "").endpoint, "https://host");
        assert_eq!(
            parse_endpoint("host:9000", "true").endpoint,
            "https://host:9000"
        );
        assert_eq!(
            parse_endpoint("host:9000", "1").endpoint,
            "https://host:9000"
        );
        assert_eq!(
            parse_endpoint("host:9000", "yes").endpoint,
            "https://host:9000"
        );
        assert_eq!(parse_endpoint("host:9000", "").endpoint, "http://host:9000");
        assert_eq!(
            parse_endpoint("http://host:9000/", "yes").endpoint,
            "http://host:9000"
        );
        assert!(!parse_endpoint("http://host", "yes").ssl);
    }

    #[test]
    fn folder_marker_e_copy_source() {
        assert_eq!(FOLDER_MARKER, ".keep");
        let encoded = "a b/c%20d.png"
            .split('/')
            .map(|s| utf8_percent_encode(s, JS_ENCODE).to_string())
            .collect::<Vec<_>>()
            .join("/");
        assert!(encoded.contains("%20"));
    }
}
