//! Testes de integração de `/api/config` (`GET`, `PUT`, `DELETE` e o estado
//! da cifra), sobre o `router` completo: portão + rate limit + CSRF.
//!
//! Precisam de `TEST_DATABASE_URL`; sem ela são pulados. O cliente é sempre um
//! IP remoto (`10.0.0.n:5000`) para passar pelo portão de verdade.
//!
//! **Nunca** chamamos `POST /api/config/restart` aqui: ele `exit(0)` no
//! processo, o que mataria a rodada de testes.
//!
//! As linhas de `configuracoes` são globais (não por usuário): tudo que grava
//! está num único teste sequencial, que apaga o que gravou no fim.

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::json;
use sqlx::PgPool;
use tempfile::TempDir;
use tower::ServiceExt;
use uuid::Uuid;

use tania::config::Config;
use tania::db::{connect, migrate};
use tania::http::{router, AppState};
use tania::settings::{crypto::Cifra, keys, repo as config_repo};
use tania::storage::local::LocalFs;
use tania::storage::Store;
use tania::users::repo;

/// Chave de cifra de teste (32 × 0x01), a mesma do vetor da spec.
const CIFRA_TESTE: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

/// Pool de teste migrado; `None` quando `TEST_DATABASE_URL` não existe.
async fn pool() -> Option<PgPool> {
    let url = match std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
    {
        Some(url) => url,
        None => {
            eprintln!("pulado: TEST_DATABASE_URL ausente");
            return None;
        }
    };
    let pool = match connect(&url).await {
        Ok(pool) => pool,
        Err(err) => panic!("TEST_DATABASE_URL definida mas nao conectou: {err}"),
    };
    if let Err(err) = migrate(&pool).await {
        panic!("migrate falhou: {err}");
    }
    Some(pool)
}

struct Fixture {
    state: AppState,
    pool: PgPool,
    _dir: TempDir,
}

/// Vault local vazio em tempdir: `/api/config` não toca o Store, mas o
/// `AppState` exige um. `cifra` = `None` para o teste dos 503.
async fn fixture(cifra: Option<Cifra>) -> Option<Fixture> {
    let pool = pool().await?;
    let dir = TempDir::new().expect("tempdir");
    let state = AppState::new(
        Config::default(),
        reqwest::Client::new(),
        Store::Local(LocalFs::new(dir.path().to_str().expect("tempdir em utf-8"))),
    )
    .with_db(pool.clone())
    .with_cifra(cifra);

    Some(Fixture {
        state,
        pool,
        _dir: dir,
    })
}

/// Username único: o banco compartilhado já tem linhas de outras rodadas.
fn unique_username() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("t{}", &id[..12])
}

/// IP remoto distinto por teste (n = número do teste).
fn remote(n: u8) -> SocketAddr {
    SocketAddr::from(([10, 0, 0, n], 5000))
}

async fn call(
    state: AppState,
    method: Method,
    uri: &str,
    body: Body,
    client: SocketAddr,
    headers: HeaderMap,
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .body(body)
        .expect("request");
    request.headers_mut().extend(headers);
    request.extensions_mut().insert(ConnectInfo(client));
    router(state).oneshot(request).await.expect("resposta")
}

async fn read_json(response: Response) -> serde_json::Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("corpo")
        .to_bytes();
    serde_json::from_slice::<serde_json::Value>(&bytes).expect("json")
}

fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("bearer header"),
    );
    headers
}

/// Bearer + content-type JSON: toda escrita precisa dos dois (CSRF exige JSON).
fn json_bearer(token: &str) -> HeaderMap {
    let mut headers = bearer(token);
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

/// Usuário criado direto no repositório + uma sessão: `(token, usuário)`.
async fn new_user(fixture: &Fixture, password: &str, admin: bool) -> (String, repo::Usuario) {
    let user = repo::create(&fixture.pool, &unique_username(), password, admin)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(&fixture.pool, user.id)
        .await
        .expect("criar sessão de teste");
    (token, user)
}

/// Deixa o banco limpo das chaves que o teste vai escrever (linhas globais).
async fn limpar(pool: &PgPool, chaves: &[&str]) {
    for chave in chaves {
        config_repo::remover(pool, chave)
            .await
            .expect("limpar a linha de config");
    }
}

async fn valor_bruto(pool: &PgPool, chave: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("select valor from configuracoes where chave = $1")
        .bind(chave)
        .fetch_optional(pool)
        .await
        .expect("consultar o valor bruto")
}

// --- 1) não admin não chega na config ----------------------------------------

#[tokio::test]
async fn nao_admin_recebe_403() {
    let Some(fixture) = fixture(Cifra::from_base64(CIFRA_TESTE)).await else {
        return;
    };
    let client = remote(1);
    let (token, _user) = new_user(&fixture, "12345678", false).await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/config",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["error"].as_str().expect("error"), "só admin");

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/CLICKUP_TOKEN",
        Body::from(json!({ "valor": "qualquer-coisa" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

// --- 2) fluxo completo do admin (toda a escrita é aqui, sequencial) ----------

#[tokio::test]
async fn fluxo_completo_admin() {
    let Some(fixture) = fixture(Cifra::from_base64(CIFRA_TESTE)).await else {
        return;
    };
    let client = remote(2);

    // linhas globais: começa e termina limpo
    limpar(&fixture.pool, &["CLICKUP_TOKEN", "RATE_LIMIT_MAX"]).await;

    let (token, _admin) = new_user(&fixture, "12345678", true).await;

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/config",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["cifra"], json!(true), "o estado tem cifra");
    let itens = body["itens"].as_array().expect("itens");
    assert_eq!(
        itens.len(),
        keys::CHAVES.len(),
        "GET /api/config deveria devolver todas as chaves da lista"
    );

    // chave fora da lista: 400
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/NAO_EXISTE",
        Body::from(json!({ "valor": "qualquer-coisa" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(body["error"].as_str().expect("error"), "chave desconhecida");

    // valor que a regra da chave rejeita: 400 com a mensagem da regra
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/EVOLUTION_DRY_RUN",
        Body::from(json!({ "valor": "2" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(body["error"].as_str().expect("error"), "use 0 ou 1");

    // segredo: grava cifrado e devolve só a máscara
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/CLICKUP_TOKEN",
        Body::from(json!({ "valor": "token-secreto-9876" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    let item = body["item"].as_object().expect("item");
    assert_eq!(item["origem"].as_str().expect("origem"), "banco");
    assert_eq!(item["valor"].as_str().expect("valor"), "••••9876");
    assert_eq!(item["segredo"], json!(true));

    // GET: máscara e nada em claro; `pendente` porque foi gravado nesta subida
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/config",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(
        body["pendente"],
        json!(true),
        "deveria haver mudança pendente"
    );

    let brapi = body["itens"]
        .as_array()
        .expect("itens")
        .iter()
        .find(|item| item["chave"].as_str() == Some("CLICKUP_TOKEN"))
        .expect("CLICKUP_TOKEN na lista");
    assert_eq!(brapi["origem"].as_str().expect("origem"), "banco");
    assert_eq!(brapi["valor"].as_str().expect("valor"), "••••9876");

    let corpo = body.to_string();
    assert!(
        !corpo.contains("token-secreto"),
        "o segredo não pode voltar em claro: {corpo}"
    );

    // no banco: cifrado `v1:` e sem o texto original
    let bruto = valor_bruto(&fixture.pool, "CLICKUP_TOKEN").await;
    let bruto = bruto.expect("a linha de CLICKUP_TOKEN deveria existir");
    assert!(
        bruto.starts_with("v1:"),
        "valor bruto {bruto} não é cifrado"
    );
    assert!(
        !bruto.contains("token"),
        "valor bruto não pode conter o segredo em claro"
    );

    // não segredo: volta em claro
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/RATE_LIMIT_MAX",
        Body::from(json!({ "valor": "500" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["item"]["valor"].as_str().expect("valor"), "500");
    assert_eq!(body["item"]["origem"].as_str().expect("origem"), "banco");

    // apagar: 200 e a origem deixa de ser o banco (volta a valer o env)
    for chave in ["CLICKUP_TOKEN", "RATE_LIMIT_MAX"] {
        let response = call(
            fixture.state.clone(),
            Method::DELETE,
            &format!("/api/config/{chave}"),
            Body::empty(),
            client,
            json_bearer(&token),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json(response).await;
        assert_eq!(body["ok"], json!(true));
        assert_eq!(
            valor_bruto(&fixture.pool, chave).await,
            None,
            "{chave} deveria estar apagada"
        );
    }

    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/config",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    let brapi = body["itens"]
        .as_array()
        .expect("itens")
        .iter()
        .find(|item| item["chave"].as_str() == Some("CLICKUP_TOKEN"))
        .expect("CLICKUP_TOKEN na lista");
    assert_ne!(brapi["origem"].as_str().expect("origem"), "banco");

    // chave desconhecida também no DELETE
    let response = call(
        fixture.state.clone(),
        Method::DELETE,
        "/api/config/NAO_EXISTE",
        Body::empty(),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

// --- 3) sem TANIA_CONFIG_KEY, segredo não pode ser gravado -------------------

#[tokio::test]
async fn sem_cifra_segredo_da_503() {
    // chave segredo que nenhum outro teste escreve: dá para conferir que nada
    // foi gravado
    let Some(fixture) = fixture(None).await else {
        return;
    };
    limpar(&fixture.pool, &["DEEPSEEK_API_KEY"]).await;

    let client = remote(3);
    let (token, _admin) = new_user(&fixture, "12345678", true).await;

    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/config/DEEPSEEK_API_KEY",
        Body::from(json!({ "valor": "sk-qualquer-coisa" }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "defina TANIA_CONFIG_KEY no servidor para salvar segredos"
    );

    // o handler responde antes de tocar o repositório: nada foi gravado
    assert_eq!(
        valor_bruto(&fixture.pool, "DEEPSEEK_API_KEY").await,
        None,
        "sem cifra não se grava segredo nenhum"
    );

    // GET continua funcionando e mostra que não há cifra
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/config",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["cifra"], json!(false));
}
