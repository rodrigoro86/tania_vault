//! Testes do repositório de configurações (`configuracoes`). Precisam de
//! `TEST_DATABASE_URL`; sem ela, são pulados.

use sqlx::PgPool;
use tania::db::{connect, migrate};
use tania::settings::repo;

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

/// Chave única por rodada: o banco compartilhado já tem linhas de outros testes.
fn unique_chave() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("TESTE_{id}")
}

#[tokio::test]
async fn gravar_listar_remover() {
    let Some(pool) = pool().await else {
        return;
    };

    let chave = unique_chave();

    let gravada = repo::gravar(&pool, &chave, "valor-1", false, "admin")
        .await
        .expect("gravar deveria funcionar");
    assert_eq!(gravada.chave, chave);
    assert_eq!(gravada.valor, "valor-1");
    assert!(!gravada.segredo);
    assert_eq!(gravada.atualizado_por.as_deref(), Some("admin"));

    let linhas = repo::listar(&pool).await.expect("listar falhou");
    assert!(
        linhas.iter().any(|l| l.chave == chave),
        "listar deveria conter a chave gravada"
    );
    // order by chave: as linhas vêm em ordem
    let ordenadas: Vec<String> = linhas.iter().map(|l| l.chave.clone()).collect();
    let mut esperado = ordenadas.clone();
    esperado.sort();
    assert_eq!(ordenadas, esperado, "listar deveria vir ordenado por chave");

    // segunda gravação na mesma chave atualiza o valor e marca segredo
    let atualizada = repo::gravar(&pool, &chave, "valor-2", true, "outro")
        .await
        .expect("segunda gravar deveria funcionar");
    assert_eq!(atualizada.chave, chave);
    assert_eq!(atualizada.valor, "valor-2");
    assert!(atualizada.segredo);
    assert_eq!(atualizada.atualizado_por.as_deref(), Some("outro"));
    assert!(
        atualizada.atualizado_em >= gravada.atualizado_em,
        "atualizado_em deveria ser posterior ao primeiro gravar"
    );

    let depois = repo::listar(&pool).await.expect("listar falhou");
    let encontrada = depois
        .iter()
        .find(|l| l.chave == chave)
        .expect("a chave deveria continuar na lista");
    assert_eq!(encontrada.valor, "valor-2");
    assert_eq!(
        encontrada.atualizado_em, atualizada.atualizado_em,
        "deve haver uma única linha por chave"
    );

    assert!(repo::remover(&pool, &chave).await.expect("remover falhou"));
    assert!(
        !repo::listar(&pool)
            .await
            .expect("listar falhou")
            .iter()
            .any(|l| l.chave == chave),
        "a linha removida não deveria aparecer mais"
    );
    assert!(
        !repo::remover(&pool, &chave)
            .await
            .expect("segundo remover falhou"),
        "remover uma chave inexistente deveria devolver false"
    );
}
