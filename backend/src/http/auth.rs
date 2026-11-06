use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::db::PgPool;
use crate::http::AppState;
use crate::users::{password, repo, Usuario};

/// Portão de login: roda antes do proxy (e antes do front), porque o bundle do
/// front contém o texto de todas as notas.
///
/// A credencial não vem mais de uma env: quem entra é quem tem uma sessão
/// guardada no Postgres (`sessoes`). Sem `DATABASE_URL` não há como autenticar —
/// atrás do proxy o Node veria tudo como `127.0.0.1`, então só loopback entra.
pub const COOKIE: &str = "vault_session";
pub const MAX_AGE_S: i64 = 30 * 24 * 3600; // 30 dias = 2_592_000 s
const MAX_FAILS: u32 = 5;
const LOCK_MS: i64 = 15 * 60 * 1000;
const MAX_FORM_BYTES: usize = 4096;

const LOGIN_HTML: &str = include_str!("login.html");

/// Momento atual em milissegundos unix (equivalente a `Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

/// PWA/marca: manifest, ícones e logos. Equivalente a
/// `pathname === '/manifest.webmanifest' || /^\/(icons|brand)\/[\w.-]+\.(png|svg)$/.test(pathname)`.
pub fn is_public_asset(pathname: &str) -> bool {
    if pathname == "/manifest.webmanifest" {
        return true;
    }
    let body = match pathname
        .strip_prefix("/icons/")
        .or_else(|| pathname.strip_prefix("/brand/"))
    {
        Some(body) => body,
        None => return false,
    };
    // o último "." separa o nome do nome do arquivo da extensão (png|svg)
    let dot = match body.rfind('.') {
        Some(dot) => dot,
        None => return false,
    };
    if dot == 0 {
        return false;
    }
    body[..dot]
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
        && matches!(&body[dot + 1..], "png" | "svg")
}

/// `readCookie` do JS: split `;`, trim, nome antes do primeiro `=`.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> String {
    for value in headers.get_all("cookie") {
        for part in String::from_utf8_lossy(value.as_bytes()).split(';') {
            let part = part.trim();
            let (key, value) = match part.split_once('=') {
                Some(pair) => pair,
                None => (part, ""),
            };
            if key == name {
                return value.to_string();
            }
        }
    }
    String::new()
}

pub fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => {
            // tokio/hyper podem entregar ::1 ou o IPv4-mapped ::ffff:127.0.0.1
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ipv4| ipv4.is_loopback())
        }
    }
}

pub fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .is_some_and(|value| value.as_bytes() == b"https")
}

/// Escape igual ao JS: `& < > " '` viram `&#código;`.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&#38;"),
            '<' => out.push_str("&#60;"),
            '>' => out.push_str("&#62;"),
            '"' => out.push_str("&#34;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

pub fn login_page(error: &str) -> String {
    if error.is_empty() {
        return LOGIN_HTML.replace("{{ERROR}}", "");
    }
    LOGIN_HTML.replace(
        "{{ERROR}}",
        &format!(
            "<p class=\"error\" role=\"alert\">{}</p>",
            escape_html(error)
        ),
    )
}

fn header_value(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static("invalid"))
}

fn html_page(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Cache-Control", "no-store"),
        ],
        body,
    )
        .into_response()
}

fn redirect(to: &str, set_cookie: Option<&str>) -> Response {
    let mut response = (
        StatusCode::SEE_OTHER,
        [("Location", to), ("Cache-Control", "no-store")],
    )
        .into_response();
    if let Some(cookie) = set_cookie {
        response
            .headers_mut()
            .insert("Set-Cookie", header_value(cookie));
    }
    response
}

/// Token de sessão: string opaca gerada pelo banco (`sessoes.token_hash`), que o
/// portão resolve e repassa às rotas internas via `request.extensions()`.
#[derive(Debug, Clone)]
pub struct SessionToken(pub String);

/// Token da sessão vindo do request: `Authorization: Bearer <t>` (prefixo exato)
/// tem prioridade sobre o cookie `vault_session`. Vazio -> `None`.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("authorization") {
        let text = String::from_utf8_lossy(value.as_bytes());
        if let Some(bearer) = text.strip_prefix("Bearer ") {
            let bearer = bearer.trim();
            if !bearer.is_empty() {
                return Some(bearer.to_string());
            }
        }
    }
    let cookie = read_cookie(headers, COOKIE);
    (!cookie.is_empty()).then_some(cookie)
}

pub fn session_cookie(value: &str, max_age: i64, secure: bool) -> String {
    format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

#[derive(Debug, Clone)]
pub struct FailEntry {
    pub count: u32,
    pub until_ms: i64,
}

/// Motivo pelo qual um login não passou.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginError {
    /// IP bloqueado pelo lockout de 15 minutos
    Locked,
    /// usuário inexistente, inativo ou senha errada
    Invalid,
    /// o banco não respondeu
    Db,
}

/// Login contra o Postgres: lockout por IP, hash argon2 e criação da sessão.
///
/// Devolve `(usuário, token, expira_em)` no sucesso. O usuário inexistente ainda
/// paga um `verify_dummy` (argon2) para que o tempo de resposta não revele se o
/// nome existe, como no Node.
pub async fn check_login(
    state: &AppState,
    db: &PgPool,
    ip: IpAddr,
    username: &str,
    password: &str,
) -> Result<(Usuario, String, chrono::DateTime<chrono::Utc>), LoginError> {
    let now = now_ms();
    if lock(&state.login_fails)
        .get(&ip)
        .is_some_and(|fail| fail.until_ms > now)
    {
        return Err(LoginError::Locked);
    }

    let found = match repo::find_login(db, username).await {
        Ok(found) => found,
        Err(err) => {
            tracing::error!("check_login: não foi possível consultar usuarios: {err}");
            return Err(LoginError::Db);
        }
    };

    let autenticado = match &found {
        Some((user, hash)) => user.ativo && password::verify(password, hash),
        // só gasta o tempo do argon2: usuário inexistente nunca autentica
        None => {
            password::verify_dummy(password);
            false
        }
    };

    if !autenticado {
        let count = {
            let mut fails = lock(&state.login_fails);
            let count = fails.get(&ip).map_or(0, |fail| fail.count) + 1;
            fails.insert(
                ip,
                FailEntry {
                    count,
                    until_ms: if count >= MAX_FAILS { now + LOCK_MS } else { 0 },
                },
            );
            count
        };
        tracing::debug!("login falhou {count}x para {ip}");
        return Err(LoginError::Invalid);
    }

    let Some(user) = found.map(|(user, _hash)| user) else {
        tracing::error!("check_login: verificação passou sem usuário no banco");
        return Err(LoginError::Invalid);
    };

    lock(&state.login_fails).remove(&ip);

    match repo::create_session(db, user.id).await {
        Ok((token, expira_em)) => Ok((user, token, expira_em)),
        Err(err) => {
            tracing::error!("check_login: não foi possível criar a sessão: {err}");
            Err(LoginError::Db)
        }
    }
}

fn parse_form(body: &[u8]) -> Vec<(String, String)> {
    form_urlencoded::parse(body)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn field<'a>(form: &'a [(String, String)], name: &str) -> &'a str {
    form.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

/// Ordem exata do portão: webhook, assets públicos, health, banco, login/logout,
/// sessão. Quando autenticado, insere o `Usuario` (e o `SessionToken`) nas
/// extensions do request e segue para o rate limit e o proxy.
pub async fn gate(
    State(state): State<AppState>,
    ConnectInfo(client): ConnectInfo<SocketAddr>,
    mut request: Request,
    next: Next,
) -> Response {
    let pathname = request.uri().path().to_string();
    let is_get = request.method() == Method::GET;

    // 1) webhook do WhatsApp: autenticado pelo apikey da Evolution, sem cookie
    //    e fora do rate limit.
    if pathname.starts_with("/api/evolution/webhook") {
        return next.run(request).await;
    }
    // 2) assets públicos (manifest, ícones, marca)
    if is_get && is_public_asset(&pathname) {
        return next.run(request).await;
    }
    // 3) healthcheck, público e sem dados sensíveis
    if is_get && pathname == "/api/health" {
        return next.run(request).await;
    }

    // 4) sem Postgres não existe sessão possível: só loopback entra.
    let Some(db) = state.db.clone() else {
        // Sem banco o Node não tem como autenticar ninguém: atrás do proxy ele
        // veria tudo como 127.0.0.1. Só loopback entra; remoto fica bloqueado.
        if is_loopback(client.ip()) {
            return next.run(request).await;
        }
        tracing::debug!("acesso remoto bloqueado: cliente {client}");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [("Content-Type", "text/plain; charset=utf-8")],
            "Acesso remoto bloqueado: defina DATABASE_URL no servidor.",
        )
            .into_response();
    };

    let secure = is_https(request.headers());

    // 5) login por formulário
    if pathname == "/login" && request.method() == Method::POST {
        let ip = client.ip();
        let body = match axum::body::to_bytes(request.into_body(), MAX_FORM_BYTES).await {
            Ok(bytes) => bytes,
            Err(_) => {
                return html_page(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    login_page("Requisição inválida."),
                )
            }
        };
        let form = parse_form(&body);

        match check_login(
            &state,
            &db,
            ip,
            field(&form, "user"),
            field(&form, "password"),
        )
        .await
        {
            Ok((user, token, _expira_em)) => {
                tracing::debug!("login: usuário '{}' ({ip})", user.username);
                return redirect("/", Some(&session_cookie(&token, MAX_AGE_S, secure)));
            }
            Err(LoginError::Locked) => {
                return html_page(
                    StatusCode::TOO_MANY_REQUESTS,
                    login_page("Muitas tentativas. Espere 15 minutos."),
                );
            }
            Err(LoginError::Invalid) => {
                return html_page(
                    StatusCode::UNAUTHORIZED,
                    login_page("Usuário ou senha incorretos."),
                );
            }
            Err(LoginError::Db) => {
                return html_page(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    login_page("Erro no servidor. Tente de novo."),
                );
            }
        }
    }

    // 6) logout: apaga a sessão do banco (falha só loga) e limpa o cookie
    if pathname == "/logout" {
        if let Some(token) = session_token(request.headers()) {
            if let Err(err) = repo::delete_session(&db, &token).await {
                tracing::warn!("logout: não foi possível apagar a sessão: {err}");
            }
        }
        return redirect("/login", Some(&session_cookie("", 0, secure)));
    }

    // 7) login JSON: rota pública; a implementação vem na T4
    if pathname == "/api/auth/login" && request.method() == Method::POST {
        return next.run(request).await;
    }

    // 8) sessão: `Authorization: Bearer` ou cookie `vault_session`
    let session = session_token(request.headers());
    let user = match session.as_deref() {
        Some(token) => match repo::session_user(&db, token).await {
            Ok(user) => user,
            Err(err) => {
                tracing::error!("gate: não foi possível verificar a sessão: {err}");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "ok": false, "error": "erro no banco" })),
                )
                    .into_response();
            }
        },
        None => None,
    };

    // 9) página de login: quem já tem sessão vai direto para o app
    if pathname == "/login" {
        return if user.is_some() {
            redirect("/", None)
        } else {
            html_page(StatusCode::OK, login_page(""))
        };
    }

    // 10) autenticado: repassa usuário e token às rotas de dentro
    let Some(user) = user else {
        if pathname.starts_with("/api") {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "ok": false, "error": "não autenticado" })),
            )
                .into_response();
        }
        return redirect("/login", None);
    };

    request.extensions_mut().insert(user);
    if let Some(token) = session {
        request.extensions_mut().insert(SessionToken(token));
    }
    next.run(request).await
}

fn lock<T>(map: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    map.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_tem_prioridade_sobre_o_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer abc123"));
        headers.insert(
            "cookie",
            HeaderValue::from_static("vault_session=token-do-cookie"),
        );
        assert_eq!(session_token(&headers).as_deref(), Some("abc123"));
    }

    #[test]
    fn session_token_cai_no_cookie_e_vazio_e_none() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_static("other=1; vault_session=a=b.c ; third=2"),
        );
        assert_eq!(session_token(&headers).as_deref(), Some("a=b.c"));

        // "Bearer " sem nada não é sessão; sem cookie também, nada
        let mut sem_token = HeaderMap::new();
        sem_token.insert("authorization", HeaderValue::from_static("Bearer "));
        assert_eq!(session_token(&sem_token), None);

        // outro esquema de auth não é entendido como sessão
        let mut basic = HeaderMap::new();
        basic.insert("authorization", HeaderValue::from_static("Basic xyz"));
        assert_eq!(session_token(&basic), None);

        let mut cookie_vazio = HeaderMap::new();
        cookie_vazio.insert("cookie", HeaderValue::from_static("vault_session="));
        assert_eq!(session_token(&cookie_vazio), None);
        assert_eq!(session_token(&HeaderMap::new()), None);
    }

    #[test]
    fn assets_publicos() {
        for path in [
            "/manifest.webmanifest",
            "/icons/icon-192.png",
            "/icons/icon-maskable-512.png",
            "/icons/icon.svg",
            "/brand/logo.png",
        ] {
            assert!(is_public_asset(path), "{path} deveria ser público");
        }
        for path in [
            "/",
            "/index.html",
            "/sw.js",
            "/assets/index-abc.js",
            "/icons/x.js",
            "/icons/a/b.png",
            "/icons/",
            "/api/notes",
            "/manifest.webmanifest/x",
            "/brand/../index.html",
            "/brand/x.html",
            "/files/99-Meta/attachments/x.png",
        ] {
            assert!(!is_public_asset(path), "{path} não é público");
        }
    }

    #[test]
    fn loopback_inclui_ipv4_mapped() {
        assert!(is_loopback("127.0.0.1".parse().expect("ipv4")));
        assert!(is_loopback("::1".parse().expect("ipv6")));
        assert!(is_loopback("::ffff:127.0.0.1".parse().expect("mapped")));
        assert!(!is_loopback("10.0.0.5".parse().expect("ipv4")));
        assert!(!is_loopback("::ffff:10.0.0.5".parse().expect("mapped")));
    }

    #[test]
    fn cookie_lido_igual_ao_js() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            HeaderValue::from_static("other=1; vault_session=a=b.c ; third=2"),
        );
        assert_eq!(read_cookie(&headers, COOKIE), "a=b.c");
        let mut empty = HeaderMap::new();
        empty.insert("cookie", HeaderValue::from_static("vault_session"));
        assert_eq!(read_cookie(&empty, COOKIE), "");
        assert_eq!(read_cookie(&headers, "inexistente"), "");
    }

    #[test]
    fn cookie_de_sessao_formatado_como_o_node() {
        assert_eq!(
            session_cookie("abc", 2592000, false),
            "vault_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000"
        );
        assert_eq!(
            session_cookie("", 0, true),
            "vault_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure"
        );
    }

    #[test]
    fn pagina_de_login_escape_error() {
        let page = login_page("a&b<c>\"'");
        assert!(page.contains("<p class=\"error\" role=\"alert\">a&#38;b&#60;c&#62;&#34;&#39;</p>"));
        assert!(!login_page("").contains("<p class=\"error\""));
        assert!(login_page("").contains("type=\"password\""));
    }
}
