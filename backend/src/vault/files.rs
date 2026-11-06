//! `PUT /api/files/{*rel}` — envio de anexo bruto (F2b-2b) e
//! `GET/HEAD /files/{*rel}` — leitura do anexo (F2b-2c), porte fiel de
//! `handleVaultFile` de `app/server/vault-api.mjs`.
//!
//! Ordem das checagens, igual ao Node: primeiro o `Content-Type` (anexo é
//! octet-stream por natureza), depois o caminho (sem ler o corpo: um path
//! inválido não pode custar o download de 50 MB), depois o tamanho, depois o
//! conflito. `DefaultBodyLimit::disable()` na rota é o que permite os 50 MB:
//! o limite padrão do axum é 2 MB.

use std::time::{Duration, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::json;

use crate::error::ApiError;
use crate::http::AppState;
use crate::vault::sanitize::{sanitize_file, sanitize_upload};

/// Limite de upload anunciado na mensagem de 413.
const MAX_UPLOAD: usize = 50 * 1024 * 1024;

fn ok(status: StatusCode, payload: serde_json::Value) -> impl IntoResponse {
    (status, Json(payload))
}

pub(crate) async fn upload_file(
    State(state): State<AppState>,
    Path(rel): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<impl IntoResponse, ApiError> {
    // (a) anexo chega como octet-stream; qualquer outra coisa é 415
    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .to_ascii_lowercase()
        .starts_with("application/octet-stream")
    {
        return Err(ApiError::Http(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type deve ser application/octet-stream".to_string(),
        ));
    }

    // (b) o caminho é validado antes de ler o corpo: `%20`, `..`, `.exe` e
    // pastas fora do vault são barrados sem gastar bandwidth
    let (rel, _tipo) = sanitize_upload(Some(&rel))?;

    // (c) tamanho: `to_bytes` corta no limite e devolve erro
    let bytes = match axum::body::to_bytes(body, MAX_UPLOAD).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Err(ApiError::Http(
                StatusCode::PAYLOAD_TOO_LARGE,
                "arquivo maior que 50 MB".to_string(),
            ));
        }
    };

    // (d) upload não sobrescreve: existente é conflito, como POST /api/notes
    if state.store.exists(&rel).await? {
        return Err(ApiError::Http(
            StatusCode::CONFLICT,
            format!("{rel} já existe"),
        ));
    }

    // (e) grava
    state.store.write(&rel, &bytes).await?;

    // (f) criado
    Ok(ok(
        StatusCode::CREATED,
        json!({ "ok": true, "path": rel, "created": true, "size": bytes.len() }),
    ))
}

/// equivalente de `encodeURIComponent` (deixa `- _ . ! ~ * ' ( )` intactos): o
/// mesmo `AsciiSet` de `backend/src/storage/s3.rs`, porque o nome do
/// `Content-Disposition` precisa sair byte a byte como no Node.
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

/// CSP dos anexos renderizáveis (html, svg, csv, txt), idêntica a
/// `SANDBOX_CSP` de `app/server/vault-api.mjs`.
const SANDBOX_CSP: &str = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-presentation allow-downloads";

/// `fail(status, message)` do Node: erro sempre em texto puro, nunca JSON.
fn fail(status: StatusCode, message: &str) -> Response {
    (
        status,
        [
            (
                "Content-Type",
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (
                "X-Content-Type-Options",
                HeaderValue::from_static("nosniff"),
            ),
        ],
        message.to_string(),
    )
        .into_response()
}

/// status e mensagem de um `ApiError::Http`, como o `catch` do handler
fn fail_from(error: ApiError) -> Response {
    match error {
        ApiError::Http(status, message) => fail(status, &message),
        other => fail(StatusCode::INTERNAL_SERVER_ERROR, &other.to_string()),
    }
}

/// `/^bytes=(\d*)-(\d*)$/` do Node. Devolve `(start, end)` resolvidos para um
/// arquivo de `size`, ou `None` quando o header não tem esse formato (ou o
/// arquivo está vazio, caso em que o Node também ignora o Range).
fn parse_range(raw: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let spec = raw.strip_prefix("bytes=")?;
    let (first, second) = spec.split_once('-')?;
    if !first.chars().all(|c| c.is_ascii_digit()) || !second.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // em JS `Number("")` é 0: `bytes-` → start = size (416) e `bytes=5-` →
    // end = size - 1. Um número gigante não cabe em u64: vale `MAX`, que já
    // cai na checagem de 416.
    let first_num = first.parse::<u64>().unwrap_or(u64::MAX);
    let second_num = second.parse::<u64>().unwrap_or(u64::MAX);
    let start = if first.is_empty() {
        size.saturating_sub(second_num)
    } else {
        first_num
    };
    let end = if first.is_empty() || second.is_empty() {
        size - 1
    } else {
        second_num.min(size - 1)
    };
    Some((start, end))
}

pub(crate) async fn serve_file(
    State(state): State<AppState>,
    Path(rel): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    // (a) leitura: POST/PUT/DELETE não são o upload (esse mora em /api/files)
    if method != Method::GET && method != Method::HEAD {
        return fail(StatusCode::METHOD_NOT_ALLOWED, "método não permitido");
    }

    // (b) path: traversal, pasta oculta/fora do vault, extensão desconhecida
    let (rel, tipo) = match sanitize_file(Some(&rel)) {
        Ok(clean) => clean,
        Err(error) => return fail_from(error),
    };

    // (c) MinIO/S3 não streama: redireciona para a URL assinada; Range e ETag
    // ficam por conta do MinIO
    if state.store.kind() == "s3" {
        match state.store.presign(&rel, tipo.kind == "office").await {
            Ok(Some(url)) => {
                let location = match HeaderValue::from_str(&url) {
                    Ok(value) => value,
                    Err(_) => {
                        return fail(StatusCode::INTERNAL_SERVER_ERROR, "URL assinada inválida")
                    }
                };
                return (
                    StatusCode::FOUND,
                    [
                        ("Location", location),
                        (
                            "Cache-Control",
                            HeaderValue::from_static("private, no-store"),
                        ),
                    ],
                    Body::empty(),
                )
                    .into_response();
            }
            Ok(None) => {} // store sem presign: segue streamando
            Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
        }
    }

    // (d) stat: qualquer falha (não existe, é diretório) é 404 como no Node
    let st = match state.store.stat(&rel).await {
        Ok(stat) => stat,
        Err(_) => return fail(StatusCode::NOT_FOUND, &format!("{rel} não existe")),
    };

    let name = rel.rsplit('/').next().unwrap_or(rel.as_str());
    let etag = format!("W/\"{}-{}\"", st.size, st.mtime_ms);

    let mut out = HeaderMap::new();
    out.insert(
        "Content-Type",
        HeaderValue::from_str(tipo.mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    out.insert(
        "Cache-Control",
        HeaderValue::from_static("private, no-cache"),
    );
    out.insert(
        "ETag",
        HeaderValue::from_str(&etag).expect("etag só tem dígitos, aspas e W/"),
    );
    out.insert(
        "Last-Modified",
        HeaderValue::from_str(&httpdate::fmt_http_date(
            UNIX_EPOCH + Duration::from_millis(st.mtime_ms.max(0) as u64),
        ))
        .expect("data HTTP cabe num header"),
    );
    out.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    out.insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    // office não abre no navegador: baixa; o resto abre na aba
    out.insert(
        "Content-Disposition",
        HeaderValue::from_str(&format!(
            "{}; filename*=UTF-8''{}",
            if tipo.kind == "office" {
                "attachment"
            } else {
                "inline"
            },
            utf8_percent_encode(name, JS_ENCODE)
        ))
        .expect("filename percent-encoded é ASCII"),
    );
    if tipo.sandbox {
        out.insert(
            "Content-Security-Policy",
            HeaderValue::from_static(SANDBOX_CSP),
        );
    }

    // (e) ETag batido: 304 com os mesmos headers, corpo vazio
    if let Some(if_none_match) = headers.get("if-none-match") {
        if if_none_match.to_str().unwrap_or_default() == etag {
            return (StatusCode::NOT_MODIFIED, out).into_response();
        }
    }

    // (f) Range: `bytes=A-B`, A e B só dígitos (cada um pode ser vazio),
    // parseado à mão; fora desse formato serve o arquivo inteiro
    let mut start = 0u64;
    let mut end = st.size.saturating_sub(1);
    let mut status = StatusCode::OK;

    let range = headers
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| parse_range(raw, st.size));
    if let Some((s, e)) = range {
        if s > e || s >= st.size {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(
                    "Content-Range",
                    HeaderValue::from_str(&format!("bytes */{}", st.size))
                        .expect("Content-Range de números é ASCII"),
                )],
                Body::empty(),
            )
                .into_response();
        }
        start = s;
        end = e;
        status = StatusCode::PARTIAL_CONTENT;
        out.insert(
            "Content-Range",
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}", size = st.size))
                .expect("Content-Range de números é ASCII"),
        );
    }

    let length = if st.size == 0 { 0 } else { end - start + 1 };
    out.insert(
        "Content-Length",
        HeaderValue::from_str(&format!("{length}")).expect("Content-Length numérico"),
    );

    // (g) HEAD e arquivo vazio: headers sim, corpo não
    let mut response = (status, out).into_response();
    if method == Method::HEAD || st.size == 0 {
        return response;
    }

    match state.store.read_stream(&rel, Some(start), Some(end)).await {
        Ok(stream) => {
            *response.body_mut() = Body::from_stream(stream);
            response
        }
        Err(error) => fail(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}
