//! CSRF por Content-Type, fiel ao trecho de `handleVaultApi` do Node.
//!
//! Uma "simple request" (text/plain, form, beacon) disparada por qualquer
//! página aberta no mesmo navegador chega sem preflight de CORS e escreveria
//! no vault. Exigir JSON fecha esse vetor. Roda depois do portão e do rate
//! limit, antes das rotas e do proxy.

use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;

pub async fn csrf(request: Request, next: Next) -> Response {
    let pathname = request.uri().path();
    // fora da API não há escrita no vault: o proxy decide
    if !pathname.starts_with("/api") {
        return next.run(request).await;
    }

    let method = request.method();
    if method == Method::GET || method == Method::HEAD {
        return next.run(request).await;
    }

    // envio de anexo (`PUT /api/files/...`) é octet-stream por natureza: a
    // regra própria dele vem na próxima tarefa
    if method == Method::PUT && pathname.starts_with("/api/files/") {
        return next.run(request).await;
    }

    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .to_ascii_lowercase()
        .starts_with("application/json")
    {
        return ApiError::Http(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type deve ser application/json".to_string(),
        )
        .into_response();
    }

    next.run(request).await
}
