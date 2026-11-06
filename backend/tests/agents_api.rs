//! Testes de `/api/agents`: unitários de `validar` (uma regra por teste) e o
//! fluxo de integration com banco, sobre o `router` completo (portão + rate
//! limit + CSRF), como em `tests/settings_api.rs`.
//!
//! A linha de `agentes_config` é global (`id = 1`): toda escrita está num
//! único teste sequencial, que apaga a linha no fim.

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

use tania::agents::{modelo_inicial, validar, AgentConfig, Provedor, CHAVES_LLM};
use tania::config::Config;
use tania::db::{connect, migrate};
use tania::http::{router, AppState};
use tania::storage::local::LocalFs;
use tania::storage::Store;
use tania::users::repo;

// --- unitários de `validar` --------------------------------------------------

fn provedor(base_url: &str, model: &str) -> Provedor {
    Provedor {
        base_url: base_url.to_string(),
        model: model.to_string(),
        max_tokens: None,
        api_key_env: None,
    }
}

/// Config de teste: os provedores se chamam `p0`, `p1`... e `active` precisa
/// bater com um deles.
fn config(active: &str, provedores: &[Provedor]) -> AgentConfig {
    let mut providers = std::collections::BTreeMap::new();
    for (i, provedor) in provedores.iter().enumerate() {
        providers.insert(format!("p{i}"), provedor.clone());
    }
    AgentConfig {
        active: active.to_string(),
        providers,
    }
}

#[test]
fn modelo_inicial_e_valido() {
    let c = modelo_inicial();
    validar(&c).expect("o modelo inicial deveria ser válido");
    assert_eq!(c.active, "deepseek");
    assert_eq!(c.providers.len(), 6);
}

#[test]
fn exige_de_um_a_vinte_provedores() {
    let vazio = AgentConfig {
        active: "deepseek".to_string(),
        providers: std::collections::BTreeMap::new(),
    };
    assert_eq!(
        validar(&vazio).expect_err("zero provedores deveria ser rejeitado"),
        "cadastre de 1 a 20 provedores"
    );

    let mut muitos = std::collections::BTreeMap::new();
    for i in 0..21 {
        muitos.insert(format!("p{i}"), provedor("http://a/v1", "m"));
    }
    let muitos = AgentConfig {
        active: "p0".to_string(),
        providers: muitos,
    };
    assert_eq!(
        validar(&muitos).expect_err("21 provedores deveria ser rejeitado"),
        "cadastre de 1 a 20 provedores"
    );
}

#[test]
fn nome_do_provedor_só_letras_minusculas_numeros_e_traco() {
    let mut providers = std::collections::BTreeMap::new();
    providers.insert("Bad Name".to_string(), provedor("http://a/v1", "m"));
    let c = AgentConfig {
        active: "Bad Name".to_string(),
        providers,
    };
    assert_eq!(
        validar(&c).expect_err("nome com espaço e maiúscula deveria ser rejeitado"),
        "nome inválido: Bad Name (use a-z, 0-9, - e _)"
    );

    let longo = "a".repeat(33);
    let mut providers = std::collections::BTreeMap::new();
    providers.insert(longo.clone(), provedor("http://a/v1", "m"));
    let c = AgentConfig {
        active: longo.clone(),
        providers,
    };
    assert!(validar(&c).is_err(), "nome de 33 caracteres é inválido");
}

#[test]
fn base_url_precisa_ser_http_s_e_ter_até_trezentos_caracteres() {
    let c = config("p0", &[provedor("ftp://a/v1", "m")]);
    assert_eq!(
        validar(&c).expect_err("baseUrl sem http deveria ser rejeitada"),
        "p0: baseUrl deve começar com http:// ou https://"
    );

    let longa = format!("http://{}a/v1", "b".repeat(300));
    let c = config("p0", &[provedor(&longa, "m")]);
    assert!(
        validar(&c).is_err(),
        "baseUrl de mais de 300 caracteres é inválida"
    );
}

#[test]
fn model_de_um_a_duzentos_caracteres_sem_quebra() {
    let c = config("p0", &[provedor("http://a/v1", "")]);
    assert_eq!(
        validar(&c).expect_err("model vazio deveria ser rejeitado"),
        "p0: model deve ter de 1 a 200 caracteres"
    );

    let c = config("p0", &[provedor("http://a/v1", &"m".repeat(201))]);
    assert!(validar(&c).is_err(), "model de 201 caracteres é inválido");

    let c = config("p0", &[provedor("http://a/v1", "gpt-4\nmini")]);
    assert_eq!(
        validar(&c).expect_err("model com quebra de linha deveria ser rejeitado"),
        "p0: model não pode ter quebra de linha"
    );
}

#[test]
fn max_tokens_de_um_a_um_milhao() {
    let mut p = provedor("http://a/v1", "m");
    p.max_tokens = Some(0);
    let c = config("p0", &[p.clone()]);
    assert_eq!(
        validar(&c).expect_err("maxTokens 0 deveria ser rejeitado"),
        "p0: maxTokens deve ser de 1 a 1000000"
    );

    p.max_tokens = Some(1_000_001);
    let c = config("p0", &[p]);
    assert!(
        validar(&c).is_err(),
        "maxTokens acima de um milhão é inválido"
    );
}

#[test]
fn api_key_env_só_pode_ser_uma_das_chaves_llm() {
    let mut p = provedor("http://a/v1", "m");
    p.api_key_env = Some("PGPASSWORD".to_string());
    let c = config("p0", &[p]);
    assert_eq!(
        validar(&c).expect_err("chave fora da lista deveria ser rejeitada"),
        "p0: chave PGPASSWORD não permitida"
    );

    let mut p = provedor("http://a/v1", "m");
    p.api_key_env = Some("GROQ_API_KEY".to_string());
    let c = config("p0", &[p]);
    validar(&c).expect("uma chave da lista deveria ser aceita");
}

#[test]
fn active_precisa_ser_um_provedor_existente() {
    let c = config("fantasma", &[provedor("http://a/v1", "m")]);
    assert_eq!(
        validar(&c).expect_err("active inexistente deveria ser rejeitado"),
        "provedor ativo fantasma não existe"
    );
}

#[test]
fn serde_recusa_provedor_com_api_key_inline() {
    let corpo = json!({
        "active": "local",
        "providers": {
            "local": {
                "baseUrl": "http://127.0.0.1:8080/v1",
                "model": "qwen",
                "apiKey": "sk-secreta"
            }
        }
    });
    assert!(
        serde_json::from_value::<AgentConfig>(corpo).is_err(),
        "apiKey inline não pode ser aceita"
    );
}

// --- integration com banco ---------------------------------------------------

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

/// Vault local vazio em tempdir: `/api/agents` não toca o Store, mas o
/// `AppState` exige um.
async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let dir = TempDir::new().expect("tempdir");
    let state = AppState::new(
        Config::default(),
        reqwest::Client::new(),
        Store::Local(LocalFs::new(dir.path().to_str().expect("tempdir em utf-8"))),
    )
    .with_db(pool.clone());

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

/// IP remoto distinto (n = número do teste).
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

/// Usuário criado direto no repositório + uma sessão: token.
async fn new_user(fixture: &Fixture, password: &str, admin: bool) -> (String, repo::Usuario) {
    let user = repo::create(&fixture.pool, &unique_username(), password, admin)
        .await
        .expect("criar usuário de teste");
    let (token, _expira_em) = repo::create_session(&fixture.pool, user.id)
        .await
        .expect("criar sessão de teste");
    (token, user)
}

/// Linha global: deixa o banco sem nenhum config de agentes.
async fn limpar(pool: &PgPool) {
    sqlx::query("delete from agentes_config")
        .execute(pool)
        .await
        .expect("limpar agentes_config");
}

async fn quem_salvou(pool: &PgPool) -> Option<String> {
    sqlx::query_scalar::<_, String>("select atualizado_por from agentes_config where id = 1")
        .fetch_optional(pool)
        .await
        .expect("consultar atualizado_por")
}

// --- fluxo único e sequencial (toda a escrita é aqui) ------------------------

#[tokio::test]
async fn fluxo_completo_agents() {
    let Some(fixture) = fixture().await else {
        return;
    };
    let client = remote(1);

    // começa limpo: sem linha, a origem é o modelo inicial
    limpar(&fixture.pool).await;

    let (token, _user) = new_user(&fixture, "12345678", false).await;

    // não admin: 403 no GET e no PUT
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/agents",
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
        "/api/agents",
        Body::from(json!({ "config": modelo_inicial() }).to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let (token, admin) = new_user(&fixture, "12345678", true).await;

    // sem linha no banco: modelo inicial
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/agents",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["origem"].as_str().expect("origem"), "nenhum");
    assert_eq!(
        body["config"]["active"].as_str().expect("active"),
        "deepseek"
    );
    let chaves = body["chaves"].as_array().expect("chaves");
    assert_eq!(chaves.len(), CHAVES_LLM.len());
    assert!(chaves
        .iter()
        .any(|chave| chave.as_str() == Some("DEEPSEEK_API_KEY")));

    // apiKeyEnv fora da lista: 400 com a mensagem da regra
    let corpo = json!({
        "config": {
            "active": "local",
            "providers": {
                "local": {
                    "baseUrl": "http://127.0.0.1:8080/v1",
                    "model": "qwen",
                    "apiKeyEnv": "PGPASSWORD"
                }
            }
        }
    });
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/agents",
        Body::from(corpo.to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "local: chave PGPASSWORD não permitida"
    );

    // campo desconhecido (`apiKey` inline): 400 "corpo inválido"
    let corpo = json!({
        "config": {
            "active": "local",
            "providers": {
                "local": {
                    "baseUrl": "http://127.0.0.1:8080/v1",
                    "model": "qwen",
                    "apiKey": "sk-secreta"
                }
            }
        }
    });
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/agents",
        Body::from(corpo.to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(body["error"].as_str().expect("error"), "corpo inválido");

    // active que não é nenhum provedor: 400
    let corpo = json!({
        "config": {
            "active": "fantasma",
            "providers": {
                "local": {
                    "baseUrl": "http://127.0.0.1:8080/v1",
                    "model": "qwen"
                }
            }
        }
    });
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/agents",
        Body::from(corpo.to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = read_json(response).await;
    assert_eq!(
        body["error"].as_str().expect("error"),
        "provedor ativo fantasma não existe"
    );

    // PUT válido: 200 e origem banco
    let corpo = json!({
        "config": {
            "active": "local",
            "providers": {
                "local": {
                    "baseUrl": "http://127.0.0.1:8080/v1",
                    "model": "qwen"
                }
            }
        }
    });
    let response = call(
        fixture.state.clone(),
        Method::PUT,
        "/api/agents",
        Body::from(corpo.to_string()),
        client,
        json_bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["origem"].as_str().expect("origem"), "banco");
    assert_eq!(body["config"]["active"].as_str().expect("active"), "local");

    // GET: agora vem do banco, e quem salvou é o admin
    let response = call(
        fixture.state.clone(),
        Method::GET,
        "/api/agents",
        Body::empty(),
        client,
        bearer(&token),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["origem"].as_str().expect("origem"), "banco");
    assert_eq!(body["config"]["active"].as_str().expect("active"), "local");
    let local = body["config"]["providers"]["local"]
        .as_object()
        .expect("provedor local");
    assert_eq!(
        local["baseUrl"].as_str().expect("baseUrl"),
        "http://127.0.0.1:8080/v1"
    );
    assert_eq!(local["model"].as_str().expect("model"), "qwen");
    assert_eq!(
        quem_salvou(&fixture.pool).await,
        Some(admin.username.clone()),
        "a linha deveria registrar quem salvou"
    );

    // fecha limpo: a linha é global, outra rodada não pode herdar ela
    limpar(&fixture.pool).await;
}
