use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("backend legado indisponível")]
    UpstreamUnavailable,
    /// erro de API com status e mensagem escolhidos pelo handler (fiel ao
    /// `ApiError(status, message)` do Node)
    #[error("{1}")]
    Http(StatusCode, String),
}

impl From<crate::storage::StoreError> for ApiError {
    fn from(err: crate::storage::StoreError) -> Self {
        ApiError::Http(StatusCode::INTERNAL_SERVER_ERROR, err.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            ApiError::UpstreamUnavailable => StatusCode::BAD_GATEWAY,
            ApiError::Http(status, _) => status,
        };
        let mut response = (
            status,
            axum::Json(serde_json::json!({ "ok": false, "error": self.to_string() })),
        )
            .into_response();
        // o Node escreve `application/json; charset=utf-8`
        response.headers_mut().insert(
            "Content-Type",
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        response
    }
}
