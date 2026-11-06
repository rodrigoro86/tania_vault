use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::http::auth::now_ms;
use crate::http::AppState;

/// Limitador em memória por IP (janela fixa), fiel a `app/server/rate-limit.mjs`.
/// Protege a `/api` contra abuso; o `/login` já tem o bloqueio próprio no portão.
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone)]
pub struct Window {
    pub count: u32,
    pub reset_ms: i64,
}

pub async fn rate_limit(
    State(state): State<AppState>,
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let pathname = request.uri().path().to_string();
    // só a API; o webhook já passou pelo portão e é autenticado pelo apikey
    if pathname.starts_with("/api")
        && !pathname.starts_with("/api/evolution/webhook")
        && !allow(
            &state.api_hits,
            client.ip(),
            state.cfg.rate_limit_max,
            state.cfg.rate_limit_window_ms,
            now_ms(),
        )
    {
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "ok": false,
                "error": "muitas requisições: aguarde um instante"
            })),
        )
            .into_response();
        // o Node escreve `application/json; charset=utf-8`
        response.headers_mut().insert(
            "Content-Type",
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        return response;
    }
    next.run(request).await
}

fn allow(
    hits: &Mutex<HashMap<IpAddr, Window>>,
    ip: IpAddr,
    max: u32,
    window_ms: i64,
    now: i64,
) -> bool {
    let mut hits = hits.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if hits.len() >= MAX_ENTRIES {
        sweep(&mut hits, now);
    }
    let window = hits.entry(ip).or_insert(Window {
        count: 0,
        reset_ms: now + window_ms,
    });
    if window.reset_ms <= now {
        window.count = 1;
        window.reset_ms = now + window_ms;
        return true;
    }
    window.count = window.count.saturating_add(1);
    window.count <= max
}

/// remove entradas vencidas (evita crescer sem limite)
fn sweep(hits: &mut HashMap<IpAddr, Window>, now: i64) {
    hits.retain(|_, window| window.reset_ms > now);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn cap_por_ip_e_janela_independente() {
        let hits = Mutex::new(HashMap::new());
        let now = 1_000_000;
        let ip_a: IpAddr = "1.1.1.1".parse().expect("ipv4");
        let ip_b: IpAddr = "2.2.2.2".parse().expect("ipv4");

        assert!(allow(&hits, ip_a, 2, 60_000, now));
        assert!(allow(&hits, ip_a, 2, 60_000, now + 10));
        assert!(
            !allow(&hits, ip_a, 2, 60_000, now + 20),
            "terceira estoura o cap"
        );
        assert!(
            allow(&hits, ip_b, 2, 60_000, now),
            "outro IP tem a própria janela"
        );
        // depois da janela, o mesmo IP volta a ser aceito
        assert!(allow(&hits, ip_a, 2, 60_000, now + 60_000));
    }

    #[test]
    fn varredura_de_vencidas() {
        let mut hits = HashMap::new();
        hits.insert(
            "1.1.1.1".parse().expect("ipv4"),
            Window {
                count: 3,
                reset_ms: 50,
            },
        );
        hits.insert(
            "2.2.2.2".parse().expect("ipv4"),
            Window {
                count: 1,
                reset_ms: 150,
            },
        );
        sweep(&mut hits, 100);
        assert_eq!(hits.len(), 1);
        assert!(hits.contains_key(&"2.2.2.2".parse().expect("ipv4")));
    }
}
