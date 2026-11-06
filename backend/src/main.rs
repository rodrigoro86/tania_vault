use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;

use tania::config::Config;
use tania::db;
use tania::http::{router, AppState};
use tania::settings;
use tania::storage::Store;
use tania::users;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // dotenvy não sobrescreve variáveis já definidas: env do processo tem prioridade.
    if let Err(err) = dotenvy::from_path("../app/.env") {
        tracing::debug!("sem .env ({err}); usando env do processo");
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // TANIA_BOOTSTRAP_ADMIN mal formatado (ex. "usuario" sem senha): não sobe um
    // servidor com portão mal configurado — erro claro e saída.
    let mut cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("configuração inválida: {err}");
            return Err(err.into());
        }
    };

    // `tania user add <nome> [--admin]`: cria usuário pela linha de comando (senha pela entrada padrão)
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("user") {
        return user_cli(&cfg, &args[1..]).await;
    }

    // O vault pode estar no disco (dev) ou no MinIO/S3. Falha de configuração
    // (ex. VAULT_STORAGE=s3 sem bucket) não pode virar um 500 silencioso.
    let store = match Store::from_env() {
        Ok(store) => store,
        Err(err) => {
            eprintln!(
                "não foi possível abrir o armazenamento do vault (VAULT_STORAGE={}): {err}",
                std::env::var("VAULT_STORAGE").unwrap_or_else(|_| "local".to_string())
            );
            std::process::exit(1);
        }
    };
    tracing::info!("storage: {} ({})", store.kind(), store.label());

    // Postgres: sem DATABASE_URL não há usuários nem sessões — o portão só deixa
    // loopback. Com banco, migra e garante o admin inicial antes de atender.
    let pool = match cfg.database_url.as_deref() {
        Some(url) => {
            let pool = match db::connect(url).await {
                Ok(pool) => pool,
                Err(err) => {
                    eprintln!("não foi possível conectar ao banco (DATABASE_URL): {err}");
                    std::process::exit(1);
                }
            };
            if let Err(err) = db::migrate(&pool).await {
                eprintln!("migração do banco falhou: {err}");
                std::process::exit(1);
            }
            if let Some(creds) = cfg.bootstrap_admin.clone() {
                if let Err(err) = users::bootstrap_admin(&pool, &creds).await {
                    eprintln!(
                        "não foi possível criar o admin inicial (TANIA_BOOTSTRAP_ADMIN): {err}"
                    );
                    std::process::exit(1);
                }
            }
            Some(pool)
        }
        None => None,
    };

    // O que está gravado no banco vence o env do processo. Em caso de erro o
    // servidor segue com o env: config do banco é conveniência, não requisito.
    if let Some(pool) = &pool {
        if let Err(err) = settings::aplicar_no_config(pool, &mut cfg).await {
            tracing::warn!("configuração do banco não aplicada: {err}");
        }
    }

    // A chave que cifra os segredos só vem do env do processo: um segredo nunca
    // pode ser salvo como segredo de si mesmo.
    let cifra = settings::crypto::from_env();
    tracing::info!(
        "TANIA_CONFIG_KEY {}",
        if cifra.is_some() {
            "configurada"
        } else {
            "ausente: segredos não podem ser gravados"
        }
    );

    // Não seguir redirects: o Node responde 302 para /login e o proxy precisa
    // devolver esse 302 ao cliente, não consumá-lo.
    let http = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            eprintln!("não foi possível criar o cliente HTTP do upstream: {err}");
            std::process::exit(1);
        }
    };

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!(
        "tania ouvindo em {addr} (upstream {}); banco {}",
        cfg.legacy_upstream,
        if cfg.database_url.is_some() {
            "configurado"
        } else {
            "ausente: só loopback"
        }
    );

    let mut state = AppState::new(cfg, http, store).with_cifra(cifra);
    if let Some(pool) = pool {
        state = state.with_db(pool);
    }

    // ConnectInfo é o que permite aplicar a regra de IP real do cliente.
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

async fn user_cli(cfg: &Config, args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let (Some("add"), Some(username)) = (args.first().map(String::as_str), args.get(1)) else {
        return Err(
            "uso: tania user add <nome> [--admin]   (a senha vem da entrada padrão)".into(),
        );
    };
    let admin = args[2..].iter().any(|arg| arg == "--admin");
    let url = cfg
        .database_url
        .as_deref()
        .ok_or("DATABASE_URL não definida")?;
    if !users::password::valid_username(username) {
        return Err("usuário inválido: 3 a 32 caracteres, letras, números, . _ -".into());
    }
    eprint!("senha para {username}: ");
    let mut senha = String::new();
    std::io::stdin().read_line(&mut senha)?;
    let senha = senha.trim_end_matches(['\r', '\n']);
    if !users::password::valid_password(senha) {
        return Err("a senha precisa de 8 a 128 caracteres".into());
    }
    let pool = db::connect(url).await?;
    db::migrate(&pool).await?;
    let user = users::repo::create(&pool, username, senha, admin).await?;
    println!("usuário '{}' criado (admin: {})", user.username, user.admin);
    Ok(())
}
