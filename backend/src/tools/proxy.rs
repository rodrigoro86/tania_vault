//! Proxy das tools: `/tools/{id}/ui/...` e `/tools/{id}/api/...`.
//!
//! O caminho é validado **antes** de chamar a ferramenta: depois de decodificar
//! os percent-escapes, só passam `ui`, `ui/...` e `api/...`, sem `\` e sem
//! segmento `..` ou `.`. O que chega à tool é o caminho original (não
//! decodificado) mais a query — um `%2e%2e` jamais escapa do prefixo.
//!
//! A sessão da Tania não segue adiante: todo `x-tania-*`, `cookie` e
//! `authorization` do cliente são cortados e só depois entram o segredo da tool,
//! o usuário da sessão e o IP real. Resposta em streaming, como o proxy do
//! Node; ferramenta fora do ar é 502.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use percent_encoding::percent_decode_str;
use tracing::debug;

use crate::error::ApiError;
use crate::http::proxy::without_hop_by_hop;
use crate::http::AppState;
use crate::tools::registro;
use crate::users::Usuario;

fn nao_encontrado() -> ApiError {
    ApiError::Http(StatusCode::NOT_FOUND, "não encontrado".to_string())
}

fn ferramenta_indisponivel() -> ApiError {
    ApiError::Http(StatusCode::BAD_GATEWAY, "tool indisponível".to_string())
}

/// Caminho da tool, já decodificado: `ui`, `ui/...` ou `api/...`, sem barra
/// invertida e sem segmento `..` ou `.`.
fn caminho_autorizado(rest: &str) -> bool {
    let decoded = percent_decode_str(rest).decode_utf8_lossy();
    let caminho = decoded.as_ref();

    if caminho != "ui" && !caminho.starts_with("ui/") && !caminho.starts_with("api/") {
        return false;
    }
    if caminho.contains('\\') {
        return false;
    }
    !caminho
        .split('/')
        .any(|segmento| segmento == ".." || segmento == ".")
}

/// Insert só quando o valor cabe num header; segredo ou nome de usuário com
/// byte fora do permitido simplesmente não é mandado.
fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    match HeaderValue::from_str(value) {
        Ok(header) => {
            headers.insert(name, header);
        }
        Err(_) => tracing::warn!("proxy: header {name} não pode ser enviado"),
    }
}

pub async fn tool_proxy(
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    Path((id, _)): Path<(String, String)>,
    request: Request,
) -> Result<Response, ApiError> {
    // o `Path` do axum já vem decodificado: o caminho cru sai da URI
    let prefixo = format!("/tools/{id}/");
    let rest = request
        .uri()
        .path()
        .strip_prefix(&prefixo)
        .unwrap_or_default()
        .to_string();
    // primeiro a porta: um caminho que não é `ui/`/`api/` nunca chega à tool
    if !caminho_autorizado(&rest) {
        return Err(nao_encontrado());
    }
    let Some(registrada) = registro(&state, &id).await else {
        return Err(nao_encontrado());
    };

    // o caminho original (com os escapes que o cliente mandou) + a query
    let mut path_and_query = String::with_capacity(rest.len() + 1);
    path_and_query.push('/');
    path_and_query.push_str(&rest);
    if let Some(query) = request.uri().query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    let url = format!("{}{}", registrada.url.trim_end_matches('/'), path_and_query);

    // quem fala com a tool é a Tania: o cliente não pode forjar os headers da
    // sessão, e a sessão da Tania (cookie/bearer) não vai junto.
    let mut headers = HeaderMap::new();
    for (name, value) in without_hop_by_hop(request.headers()).iter() {
        let n = name.as_str();
        if !n.starts_with("x-tania-") && n != "cookie" && n != "authorization" {
            headers.append(name.clone(), value.clone());
        }
    }

    insert(&mut headers, "x-tania-tool-secret", &registrada.segredo);
    if let Some(user) = request.extensions().get::<Usuario>() {
        insert(&mut headers, "x-tania-user", &user.username);
        insert(
            &mut headers,
            "x-tania-admin",
            if user.admin { "1" } else { "0" },
        );
    }
    let forwarded_for = HeaderValue::from_str(&client.ip().to_string())
        .unwrap_or_else(|_| HeaderValue::from_static("unknown"));
    headers.insert("x-forwarded-for", forwarded_for);

    let method = request.method().clone();
    // corpo em streaming: um upload grande não é bufferizado aqui
    let body = reqwest::Body::wrap_stream(request.into_body().into_data_stream());

    debug!("tool '{id}': {method} {url}");

    let upstream = state
        .http
        .request(method, &url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|err| {
            tracing::warn!("tool '{id}' indisponível: {err}");
            ferramenta_indisponivel()
        })?;

    let status = upstream.status();
    // a tool não emite cookie de sessão: o `set-cookie` dela não passa
    let mut headers = without_hop_by_hop(upstream.headers());
    headers.remove("set-cookie");

    Ok((status, headers, Body::from_stream(upstream.bytes_stream())).into_response())
}

#[cfg(test)]
mod tests {
    use super::caminho_autorizado;

    #[test]
    fn aceita_só_o_que_está_dentro_de_ui_ou_api() {
        assert!(caminho_autorizado("ui"));
        assert!(caminho_autorizado("ui/tarefas"));
        assert!(caminho_autorizado("api/status?x=1"));
        assert!(caminho_autorizado("ui/pagina/123"));

        assert!(!caminho_autorizado(""));
        assert!(!caminho_autorizado("manifest.json"));
        assert!(!caminho_autorizado("mcp"));
        assert!(!caminho_autorizado("UI/x"));
        assert!(!caminho_autorizado("apix/y"));
        assert!(!caminho_autorizado("ui-x"));
    }

    #[test]
    fn barra_invertida_nao_escapa_do_prefixo() {
        assert!(!caminho_autorizado("ui\\mcp"));
        assert!(!caminho_autorizado("ui%5cmcp"));
    }

    #[test]
    fn ponto_ponto_e_ponto_simples_sao_rejeitados() {
        assert!(!caminho_autorizado("ui/../mcp"));
        assert!(!caminho_autorizado("ui/%2e%2e/mcp"));
        assert!(!caminho_autorizado("ui/./x"));
        assert!(!caminho_autorizado("ui/%2e/x"));
        assert!(!caminho_autorizado("ui/x/.."));
        assert!(!caminho_autorizado(".."));
    }
}
