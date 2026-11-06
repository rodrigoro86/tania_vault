//! Testes do repositório de usuários e sessões. Precisam de `TEST_DATABASE_URL`;
//! sem ela, são pulados.

use chrono::Utc;
use sqlx::PgPool;
use tania::db::{connect, migrate};
use tania::users::password::verify;
use tania::users::repo;

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

/// Username único por teste: o banco compartilhado já tem linhas de outras
/// rodadas e suites.
fn unique_username() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("t{}", &id[..12])
}

#[tokio::test]
async fn create_get_find_login_e_list() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", true)
        .await
        .expect("create deveria funcionar");
    assert!(criado.admin, "admin=true deveria vir no retorno");
    assert!(criado.ativo);

    let fetched = repo::get(&pool, criado.id).await.expect("get falhou");
    assert_eq!(
        fetched,
        Some(criado.clone()),
        "get deveria devolver o criado"
    );

    // find_login compara case-insensitive e devolve o hash
    let (usuario, senha_hash) = repo::find_login(&pool, &username.to_uppercase())
        .await
        .expect("find_login falhou")
        .expect("find_login deveria ter achado o usuário");
    assert_eq!(usuario.id, criado.id);
    assert!(
        verify("12345678", &senha_hash),
        "senha cadastrada deve conferir"
    );
    assert!(!verify("senha-errada", &senha_hash));

    let todos = repo::list(&pool).await.expect("list falhou");
    assert!(
        todos.iter().any(|u| u.id == criado.id),
        "list deveria conter o usuário criado"
    );

    let admins = repo::count_active_admins(&pool)
        .await
        .expect("count_active_admins falhou");
    assert!(admins >= 1, "deveria haver ao menos um admin ativo");
    let total = repo::count_users(&pool).await.expect("count_users falhou");
    assert!(total >= 1);
}

#[tokio::test]
async fn create_duplicado_com_caixas_diferentes_da_duplicate() {
    let Some(pool) = pool().await else {
        return;
    };

    let base = unique_username();
    let primeiro = repo::create(&pool, &base, "12345678", false)
        .await
        .expect("primeiro create falhou");

    let segundo = repo::create(&pool, &base.to_uppercase(), "87654321", false).await;
    assert!(
        matches!(segundo, Err(repo::RepoError::Duplicate)),
        "username case-insensitive duplicado deveria dar Duplicate, veio {segundo:?}"
    );

    let (usuario, _) = repo::find_login(&pool, &base.to_uppercase())
        .await
        .expect("find_login falhou")
        .expect("find_login deveria ter achado o usuário");
    assert_eq!(usuario.id, primeiro.id, "só um usuário deveria existir");
}

#[tokio::test]
async fn update_senha_muda_o_hash() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", false)
        .await
        .expect("create falhou");

    let (_, hash_antigo) = repo::find_login(&pool, &username)
        .await
        .expect("find_login falhou")
        .expect("find_login deveria ter achado o usuário");

    let atualizado = repo::update(&pool, criado.id, None, None, Some("nova-senha-de-10"))
        .await
        .expect("update falhou")
        .expect("usuário deveria existir");
    assert_eq!(atualizado.id, criado.id);
    assert!(!atualizado.admin, "admin não informado não muda");
    assert!(atualizado.ativo, "ativo não informado não muda");

    let (_, hash_novo) = repo::find_login(&pool, &username)
        .await
        .expect("find_login falhou")
        .expect("find_login deveria ter achado o usuário");
    assert_ne!(hash_antigo, hash_novo, "hash deveria mudar");
    assert!(verify("nova-senha-de-10", &hash_novo));
    assert!(
        !verify("12345678", &hash_novo),
        "a senha antiga não deve mais conferir"
    );
}

#[tokio::test]
async fn sessao_vale_e_some_apos_desativar_usuario() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", false)
        .await
        .expect("create falhou");

    let (token, expira_em) = repo::create_session(&pool, criado.id)
        .await
        .expect("create_session falhou");
    assert!(expira_em > Utc::now(), "sessão deveria expirar no futuro");
    assert!(
        repo::session_user(&pool, &token)
            .await
            .expect("session_user falhou")
            .is_some(),
        "sessão recém-criada deveria ser válida"
    );

    repo::update(&pool, criado.id, None, Some(false), None)
        .await
        .expect("update falhou")
        .expect("usuário deveria existir");

    assert!(
        repo::session_user(&pool, &token)
            .await
            .expect("session_user falhou")
            .is_none(),
        "sessão de usuário inativo não deveria ser válida"
    );
}

#[tokio::test]
async fn create_session_session_user_delete_session() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", false)
        .await
        .expect("create falhou");

    let (token, _) = repo::create_session(&pool, criado.id)
        .await
        .expect("create_session falhou");
    assert!(repo::session_user(&pool, &token)
        .await
        .expect("session_user falhou")
        .is_some());

    repo::delete_session(&pool, &token)
        .await
        .expect("delete_session falhou");
    assert!(
        repo::session_user(&pool, &token)
            .await
            .expect("session_user falhou")
            .is_none(),
        "sessão deletada não deveria ser encontrada"
    );
}

#[tokio::test]
async fn delete_sessions_except_mantem_apenas_a_keep() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", true)
        .await
        .expect("create falhou");

    let (keep, _) = repo::create_session(&pool, criado.id)
        .await
        .expect("create_session falhou");
    let (outra, _) = repo::create_session(&pool, criado.id)
        .await
        .expect("create_session falhou");

    repo::delete_sessions_except(&pool, criado.id, Some(&keep))
        .await
        .expect("delete_sessions_except falhou");

    assert!(
        repo::session_user(&pool, &keep)
            .await
            .expect("session_user falhou")
            .is_some(),
        "a sessão keep deveria continuar existindo"
    );
    assert!(
        repo::session_user(&pool, &outra)
            .await
            .expect("session_user falhou")
            .is_none(),
        "as outras sessões deveriam ter sido apagadas"
    );

    // sem keep: apaga todas
    repo::delete_sessions_except(&pool, criado.id, None)
        .await
        .expect("delete_sessions_except falhou");
    assert!(repo::session_user(&pool, &keep)
        .await
        .expect("session_user falhou")
        .is_none());
}

#[tokio::test]
async fn delete_remove_o_usuario() {
    let Some(pool) = pool().await else {
        return;
    };

    let username = unique_username();
    let criado = repo::create(&pool, &username, "12345678", false)
        .await
        .expect("create falhou");

    assert!(repo::delete(&pool, criado.id).await.expect("delete falhou"));
    assert!(
        repo::get(&pool, criado.id)
            .await
            .expect("get falhou")
            .is_none(),
        "usuário deletado não deveria ser encontrado"
    );
    assert!(
        !repo::delete(&pool, criado.id)
            .await
            .expect("segunda delete falhou"),
        "segunda delete não deveria apagar nada"
    );
}
