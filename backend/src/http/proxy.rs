use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use tracing::debug;

use crate::error::ApiError;
use crate::http::AppState;
use crate::users::Usuario;

// Headers de transporte hop-by-hop: descrevem ESTA conexão, não a próxima.
// Repassá-los quebraria o streaming (e o Host/Upgrade do upstream).
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "host",
];

fn without_hop_by_hop(headers: &HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

pub async fn proxy(
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    request: Request,
) -> Result<Response, ApiError> {
    // O portão de login (gate) já decidiu quem entra: aqui só repassamos,
    // preservando o IP real do cliente para o Node.

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or_else(|| request.uri().path());
    let url = format!("{}{}", state.cfg.legacy_upstream, path_and_query);

    let mut headers = without_hop_by_hop(request.headers());
    // o cliente não pode forjar os headers que dizem ao Node "essa requisição já
    // passou pelo portão do Rust": quem entra pelo proxy só os recebe depois.
    headers.remove("x-tania-proxy");
    headers.remove("x-tania-user");

    // O Node aceita a requisição autenticada pelo Rust por esse segredo compartilhado:
    // `x-tania-proxy` é a chave, `x-tania-user` diz quem é o usuário.
    let secret = state.cfg.legacy_proxy_secret.as_deref();
    let user = request.extensions().get::<Usuario>();
    if let (Some(secret), Some(user)) = (secret, user) {
        if let Ok(value) = HeaderValue::from_str(secret) {
            headers.insert("x-tania-proxy", value);
        }
        if let Ok(value) = HeaderValue::from_str(&user.username) {
            headers.insert("x-tania-user", value);
        }
    }

    let forwarded_for = HeaderValue::from_str(&client.ip().to_string())
        .unwrap_or_else(|_| HeaderValue::from_static("unknown"));
    headers.insert("x-forwarded-for", forwarded_for);
    // atrás do Traefik (https) o proto já vem; o Node usa ele para pôr `Secure` no cookie
    if !headers.contains_key("x-forwarded-proto") {
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    }

    let method = request.method().clone();
    // Corpo em streaming: um upload de 50 MB não pode ser bufferizado aqui.
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());

    debug!("{method} {url}");

    let upstream = state
        .http
        .request(method, &url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|_| ApiError::UpstreamUnavailable)?;

    let status = upstream.status();
    let headers = without_hop_by_hop(upstream.headers());

    // status + headers (incluindo múltiplos set-cookie) + corpo em streaming
    Ok((status, headers, Body::from_stream(upstream.bytes_stream())).into_response())
}
