//! API de configuração das integrações (`/api/config`), guardada na tabela
//! `configuracoes` e só acessível por admin.
//!
//! Regras da tela (design `2026-11-05-config-no-banco-design.md`):
//! - o valor do banco vence o env; sem linha, vale o env, e sem env "vazio";
//! - segredo nunca sai em claro: sai `"••••" + últimos 4`, ou `"••••"` se não dá
//!   para decifrar;
//! - gravar segredo sem `TANIA_CONFIG_KEY` é 503;
//! - o valor só vale depois de reiniciar (`POST /api/config/restart`).

use std::time::Duration;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Extension, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::error::ApiError;
use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::settings::{crypto::Cifra, keys, repo};
use crate::users::routes::{admin, db, db_error, json_body, me};
use crate::users::Usuario;

/// Máscara de um segredo: só os últimos 4 caracteres são legíveis.
fn mascara(valor: &str) -> String {
    let total = valor.chars().count();
    if total <= 4 {
        return "••••".to_string();
    }
    let ultimo: String = valor.chars().skip(total - 4).collect();
    format!("••••{ultimo}")
}

/// Um item da lista: `{chave, grupo, descricao, segredo, origem, valor}`.
/// `linha` é o que está no banco (`None` = não tem linha, então vale o env).
fn item(c: &keys::Chave, linha: Option<&repo::Linha>, cifra: Option<&Cifra>) -> serde_json::Value {
    let (origem, valor) = match linha {
        Some(linha) => {
            let valor = if linha.segredo {
                cifra
                    .and_then(|cifra| cifra.decifrar(&linha.valor))
                    .map(|texto| mascara(&texto))
                    .unwrap_or_else(|| "••••".to_string())
            } else {
                linha.valor.clone()
            };
            ("banco", valor)
        }
        None => match std::env::var(c.nome) {
            Ok(valor) if !valor.is_empty() => {
                let valor = if c.segredo { mascara(&valor) } else { valor };
                ("env", valor)
            }
            _ => ("vazio", String::new()),
        },
    };

    json!({
        "chave": c.nome,
        "grupo": c.grupo,
        "descricao": c.descricao,
        "segredo": c.segredo,
        "origem": origem,
        "valor": valor,
    })
}

fn chave_desconhecida(chave: &str) -> ApiError {
    tracing::debug!("chave de config fora da lista: {chave}");
    ApiError::Http(StatusCode::BAD_REQUEST, "chave desconhecida".to_string())
}

// --- GET /api/config -----------------------------------------------------------

async fn listar_config(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    admin(&me(user)?)?;
    let pool = db(&state)?;

    let linhas = repo::listar(&pool).await.map_err(db_error)?;
    let itens: Vec<serde_json::Value> = keys::CHAVES
        .iter()
        .map(|c| {
            let linha = linhas.iter().find(|l| l.chave == c.nome);
            item(c, linha, state.cifra.as_deref())
        })
        .collect();

    // algo gravado depois da subida deste processo: ainda não tem efeito
    let pendente = linhas.iter().any(|l| l.atualizado_em > state.boot);

    Ok(Json(json!({
        "ok": true,
        "pendente": pendente,
        "cifra": state.cifra.is_some(),
        "itens": itens,
    })))
}

// --- PUT /api/config/{chave} -------------------------------------------------

#[derive(Debug, Deserialize)]
struct ValorBody {
    valor: String,
}

async fn gravar_config(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(chave): Path<String>,
    body: Result<Json<ValorBody>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    let Some(c) = keys::chave(&chave) else {
        return Err(chave_desconhecida(&chave));
    };
    let input = json_body(body)?;
    let valor = input.valor.trim();

    if let Err(mensagem) = keys::validar(c, valor) {
        return Err(ApiError::Http(StatusCode::BAD_REQUEST, mensagem));
    }

    let gravada = if c.segredo {
        let Some(cifra) = state.cifra.as_ref() else {
            return Err(ApiError::Http(
                StatusCode::SERVICE_UNAVAILABLE,
                "defina TANIA_CONFIG_KEY no servidor para salvar segredos".to_string(),
            ));
        };
        repo::gravar(&pool, c.nome, &cifra.cifrar(valor), true, &who.username)
            .await
            .map_err(db_error)?
    } else {
        repo::gravar(&pool, c.nome, valor, false, &who.username)
            .await
            .map_err(db_error)?
    };

    // o valor não vai ao log: pode ser um segredo
    tracing::info!("'{}' gravou {} (origem banco)", who.username, c.nome);

    Ok(Json(json!({
        "ok": true,
        "item": item(c, Some(&gravada), state.cifra.as_deref()),
    })))
}

// --- DELETE /api/config/{chave} ----------------------------------------------

async fn apagar_config(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
    Path(chave): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;
    let pool = db(&state)?;

    let Some(c) = keys::chave(&chave) else {
        return Err(chave_desconhecida(&chave));
    };

    repo::remover(&pool, c.nome).await.map_err(db_error)?;
    tracing::info!("'{}' apagou {} (volta a valer o env)", who.username, c.nome);

    Ok(Json(json!({ "ok": true })))
}

// --- POST /api/config/restart ------------------------------------------------

async fn reiniciar(
    State(state): State<AppState>,
    user: Option<Extension<Usuario>>,
) -> Result<impl IntoResponse, ApiError> {
    let who = admin(&me(user)?)?;

    // O processo se mata logo depois de responder: Docker com
    // `restart: unless-stopped` (ou o Swarm) sobe de novo, e na subida o
    // `aplicar_no_config` lê o banco — é assim que as mudanças valem.
    let cfg = state.cfg.clone();
    let http = state.http.clone();
    tokio::spawn(async move {
        // avisa o Node legado para sair também
        if let Some(secret) = cfg.legacy_proxy_secret.as_deref() {
            if let Err(err) = http
                .post(format!("{}/api/internal/restart", cfg.legacy_upstream))
                .header("x-tania-proxy", secret)
                .send()
                .await
            {
                tracing::warn!("restart do legado não confirmou: {err}");
            }
        }
        // dá tempo de a resposta 202 chegar ao cliente
        tokio::time::sleep(Duration::from_millis(300)).await;
        tracing::warn!("reiniciando a pedido de '{}'", who.username);
        std::process::exit(0);
    });

    Ok((StatusCode::ACCEPTED, Json(json!({ "ok": true }))))
}

/// Rotas de configuração. Métodos não registrados no caminho caem no proxy.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/config", get(listar_config).fallback(proxy))
        .route(
            "/api/config/{chave}",
            put(gravar_config).delete(apagar_config).fallback(proxy),
        )
        .route("/api/config/restart", post(reiniciar).fallback(proxy))
}
