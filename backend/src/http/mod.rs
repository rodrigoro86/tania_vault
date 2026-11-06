use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use chrono::{DateTime, Utc};

use crate::config::Config;
use crate::http::auth::{gate, FailEntry};
use crate::http::csrf::csrf;
use crate::http::proxy::proxy;
use crate::http::rate_limit::{rate_limit, Window};
use crate::settings::crypto::Cifra;
use crate::storage::Store;
use crate::vault;

pub mod auth;
pub mod csrf;
pub mod proxy;
pub mod rate_limit;

#[derive(Debug, Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: reqwest::Client,
    /// vault: filesystem local ou MinIO/S3
    pub store: Arc<Store>,
    /// bloqueio por IP após falhas de login (em memória, como no Node)
    pub login_fails: Arc<Mutex<HashMap<IpAddr, FailEntry>>>,
    /// janela fixa de requisições por IP na `/api`
    pub api_hits: Arc<Mutex<HashMap<IpAddr, Window>>>,
    /// Postgres: `None` = sem banco, o portão só deixa loopback
    pub db: Option<crate::db::PgPool>,
    /// cifra dos segredos de `configuracoes`; `None` = sem `TANIA_CONFIG_KEY`
    pub cifra: Option<Arc<Cifra>>,
    /// instante da subida do processo: serve para saber se há config do banco
    /// gravada depois (a tela mostra "pendente" até reiniciar)
    pub boot: DateTime<Utc>,
}

impl AppState {
    pub fn new(cfg: Config, http: reqwest::Client, store: Store) -> Self {
        Self {
            cfg: Arc::new(cfg),
            http,
            store: Arc::new(store),
            login_fails: Arc::new(Mutex::new(HashMap::new())),
            api_hits: Arc::new(Mutex::new(HashMap::new())),
            db: None,
            cifra: None,
            boot: Utc::now(),
        }
    }

    /// Liga o pool do Postgres ao estado (chamado no boot, antes do `serve`).
    pub fn with_db(mut self, db: crate::db::PgPool) -> Self {
        self.db = Some(db);
        self
    }

    /// Liga a cifra dos segredos (`None` = sem `TANIA_CONFIG_KEY`: segredos não
    /// podem ser gravados e a API responde 503).
    pub fn with_cifra(mut self, c: Option<Cifra>) -> Self {
        self.cifra = c.map(Arc::new);
        self
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        // notas, pastas, rename e health: o Rust já atende direto no Store.
        // Um método não registrado nesses caminhos cai no proxy (fallback do
        // MethodRouter), igual a qualquer outro caminho.
        .merge(vault::routes())
        // auth JSON e gestão de usuários: atendido pelo Rust, direto no Postgres
        .merge(crate::users::routes::routes())
        // configuração das integrações guardada no banco
        .merge(crate::settings::routes::routes())
        // provedores do agente LLM, também guardados no banco
        .merge(crate::agents::routes())
        // lembretes: CRUD direto no Postgres; o scheduler de envio continua no Node
        .merge(crate::reminders::routes())
        // tools registradas (env + banco) e leitura do manifesto de cada uma
        .merge(crate::tools::routes::routes())
        // tokens de integração (MCP/Hook) e chaves gerais de integração
        .merge(crate::tokens::routes::routes())
        // canais de integração: /mcp e /api/agenda/registro (token próprio, no portão)
        .merge(crate::tokens::routes::routes_integracao())
        // Tudo o mais é repassado ao Node, em qualquer método/caminho.
        .fallback(proxy)
        // ordem: gate (por fora) -> rate limit -> csrf -> rotas/proxy.
        // A última layer adicionada é a mais de fora, então o csrf entra
        // primeiro por dentro: .layer(csrf) antes de rate_limit e gate.
        .layer(axum::middleware::from_fn(csrf))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(state.clone(), gate))
        .with_state(state)
}
