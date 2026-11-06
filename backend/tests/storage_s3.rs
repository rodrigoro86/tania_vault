//! Testes do `S3Store` (porte de `app/server/storage/s3.mjs`) contra MinIO real.
//!
//! Só rodam quando `TEST_RUSTFS_ENDPOINT` está definido; senão cada teste imprime
//! e retorna cedo. Cada teste usa um prefixo único `t-{nanos}-N/` (nanos +
//! contador, porque os testes rodam em paralelo) e apaga tudo o que criou no
//! bucket `TEST_RUSTFS_BUCKET`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::stream::StreamExt;

use tania::storage::s3::S3Store;

/// None quando não há MinIO de teste configurado.
fn test_store() -> Option<S3Store> {
    let endpoint = std::env::var("TEST_RUSTFS_ENDPOINT").ok()?;
    if endpoint.trim().is_empty() {
        return None;
    }
    let bucket = std::env::var("TEST_RUSTFS_BUCKET").unwrap_or_else(|_| "tania-test".to_string());
    let access = std::env::var("TEST_RUSTFS_ACCESS_KEY").unwrap_or_default();
    let secret = std::env::var("TEST_RUSTFS_SECRET_KEY").unwrap_or_default();
    let ssl = std::env::var("TEST_RUSTFS_USE_SSL").unwrap_or_default();
    let region = std::env::var("TEST_RUSTFS_REGION").unwrap_or_default();

    Some(
        S3Store::new(&bucket, &endpoint, &ssl, &access, &secret, "", &region)
            .expect("S3Store de teste"),
    )
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// prefixo único por teste (nanos + contador, porque os testes rodam em paralelo)
fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("relogio")
        .as_nanos();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("t-{nanos}-{seq}")
}

async fn cleanup(store: &S3Store, prefix: &str) {
    if let Err(err) = store.remove_dir(prefix).await {
        eprintln!("limpeza de {prefix} falhou: {err}");
    }
}

async fn drain(mut stream: tania::storage::ByteStream) -> String {
    let mut out = String::new();
    while let Some(chunk) = stream.next().await {
        out.push_str(&String::from_utf8_lossy(&chunk.expect("chunk do stream")));
    }
    out
}

// os 2 testes de `app/server/tests/s3.test.mjs`, agora contra MinIO real
#[tokio::test]
async fn mkdir_cria_pasta_vazia_que_aparece_na_listagem_sem_virar_arquivo() {
    let Some(store) = test_store() else {
        eprintln!("pulando: sem TEST_RUSTFS_ENDPOINT");
        return;
    };
    let p = prefix();

    store
        .mkdir(&format!("{p}/00-Inbox/nova"))
        .await
        .expect("mkdir");

    let nova = format!("{p}/00-Inbox/nova");
    assert!(store.dir_exists(&nova).await.expect("dir_exists"));
    assert!(store.is_empty_dir(&nova).await.expect("isEmptyDir"));

    let listing = store.list().await.expect("list");
    let folders: Vec<String> = listing
        .folders
        .into_iter()
        .filter(|folder| folder.starts_with(&p))
        .collect();
    let notes: Vec<String> = listing
        .notes
        .into_iter()
        .filter(|note| note.path.starts_with(&p))
        .map(|note| note.path)
        .collect();
    let files: Vec<String> = listing
        .files
        .into_iter()
        .filter(|file| file.path.starts_with(&p))
        .map(|file| file.path)
        .collect();

    assert_eq!(
        folders,
        vec![
            p.clone(),
            format!("{p}/00-Inbox"),
            format!("{p}/00-Inbox/nova")
        ]
    );
    assert!(notes.is_empty(), "o marcador .keep não vira nota");
    assert!(files.is_empty(), "o marcador .keep não vira anexo");

    cleanup(&store, &p).await;
}

#[tokio::test]
async fn pasta_com_arquivo_nao_e_vazia_e_remove_dir_apaga_o_marcador() {
    let Some(store) = test_store() else {
        eprintln!("pulando: sem TEST_RUSTFS_ENDPOINT");
        return;
    };
    let p = prefix();
    let dir = format!("{p}/a/b");

    store.mkdir(&dir).await.expect("mkdir");
    store
        .write(&format!("{dir}/foto.png"), b"x")
        .await
        .expect("write foto");

    assert!(!store.is_empty_dir(&dir).await.expect("não vazia"));

    store.remove_dir(&dir).await.expect("remove_dir");

    let sobrou = store.list_keys(&format!("{p}/")).await.expect("list_keys");
    assert!(
        sobrou.is_empty(),
        "removeDir apaga até o marcador: {sobrou:?}"
    );
    assert!(!store.dir_exists(&dir).await.expect("pasta sumiu"));

    cleanup(&store, &p).await;
}

#[tokio::test]
async fn write_read_e_rename_de_nota_no_s3() {
    let Some(store) = test_store() else {
        eprintln!("pulando: sem TEST_RUSTFS_ENDPOINT");
        return;
    };
    let p = prefix();

    let original = format!("{p}/01-Diario/2026-01-01.md");
    store
        .write_text(&original, "# dia 1\n")
        .await
        .expect("write_text");

    assert_eq!(
        store.read_text(&original).await.expect("read_text"),
        "# dia 1\n"
    );
    assert_eq!(store.read(&original).await.expect("read"), b"# dia 1\n");
    assert!(store.exists(&original).await.expect("exists"));
    let stat = store.stat(&original).await.expect("stat");
    assert_eq!(stat.size, 8);

    // rename de nota (copy + delete)
    let destino = format!("{p}/02-Renomeada/dia.md");
    store
        .rename(&original, &destino)
        .await
        .expect("rename nota");
    assert!(!store.exists(&original).await.expect("origem apagada"));
    assert_eq!(
        store.read_text(&destino).await.expect("nota movida"),
        "# dia 1\n"
    );

    // rename de pasta: move todos os objetos sob o prefixo
    store
        .mkdir(&format!("{p}/pasta"))
        .await
        .expect("mkdir pasta");
    store
        .write_text(&format!("{p}/pasta/inside.md"), "dentro")
        .await
        .expect("write inside");
    store
        .rename(&format!("{p}/pasta"), &format!("{p}/outra"))
        .await
        .expect("rename pasta");
    assert_eq!(
        store
            .read_text(&format!("{p}/outra/inside.md"))
            .await
            .expect("inside movido"),
        "dentro"
    );
    // outra/ recebeu o .keep e o inside.md: não está vazia
    assert!(!store
        .is_empty_dir(&format!("{p}/outra"))
        .await
        .expect("is_empty_dir outra"));
    assert!(!store
        .dir_exists(&format!("{p}/pasta"))
        .await
        .expect("pasta sumiu"));

    cleanup(&store, &p).await;
}

#[tokio::test]
async fn presign_devolve_url_assinada() {
    let Some(store) = test_store() else {
        eprintln!("pulando: sem TEST_RUSTFS_ENDPOINT");
        return;
    };
    let p = prefix();
    let key = format!("{p}/a/foto.png");

    store.write(&key, b"png-bytes").await.expect("write");

    let url = store
        .presign(&key, true)
        .await
        .expect("presign")
        .expect("s3 tem presigned URL");
    assert!(url.contains("X-Amz-Signature"), "url: {url}");
    assert!(url.contains(&key), "url: {url}");

    cleanup(&store, &p).await;
}

#[tokio::test]
async fn read_stream_com_range_no_s3() {
    let Some(store) = test_store() else {
        eprintln!("pulando: sem TEST_RUSTFS_ENDPOINT");
        return;
    };
    let p = prefix();
    let key = format!("{p}/n.txt");

    store.write_text(&key, "0123456789").await.expect("write");

    let stream = store
        .read_stream(&key, Some(2), Some(4))
        .await
        .expect("read_stream");
    assert_eq!(drain(stream).await, "234");

    let inteiro = store
        .read_stream(&key, None, None)
        .await
        .expect("read_stream sem range");
    assert_eq!(drain(inteiro).await, "0123456789");

    cleanup(&store, &p).await;
}
