//! Testes do `LocalFs` (porte de `app/server/storage/local.mjs`) sobre um
//! diretório temporário.

use futures_util::stream::StreamExt;
use tempfile::tempdir;

use tania::storage::constants::{file_type, is_note};
use tania::storage::local::LocalFs;
use tania::storage::{Store, StoreError};

/// stream -> String (chunks concatenados)
async fn drain(mut stream: tania::storage::ByteStream) -> String {
    let mut out = String::new();
    while let Some(chunk) = stream.next().await {
        out.push_str(&String::from_utf8_lossy(&chunk.expect("chunk do stream")));
    }
    out
}

fn local_store(root: &std::path::Path) -> Store {
    Store::Local(LocalFs::new(&root.to_string_lossy()))
}

// 1. list(): só notas e anexos conhecidos, pastas puladas, folders ordenados
#[tokio::test]
async fn lista_filtra_pastas_ocultas_skipped_e_extensoes_desconhecidas() {
    let dir = tempdir().expect("tempdir");
    let store = local_store(dir.path());

    store
        .write_text("a/n.md", "# nota\n")
        .await
        .expect("write nota");
    store
        .write("a/f.png", &[0u8, 1, 2, 3, 4, 5, 6])
        .await
        .expect("write png");
    store
        .write_text(".obsidian/x.md", "config")
        .await
        .expect("write obsidian");
    store
        .write_text("app/y.md", "código")
        .await
        .expect("write app");
    store
        .write_text(".oculto.md", "oculto")
        .await
        .expect("write oculto");
    store
        .write_text("a/z.xyz", "lixo")
        .await
        .expect("write xyz");

    let listing = store.list().await.expect("list");

    assert_eq!(listing.notes.len(), 1, "só a nota a/n.md deveria aparecer");
    assert_eq!(listing.notes[0].path, "a/n.md");
    assert_eq!(listing.notes[0].raw, "# nota\n");

    assert_eq!(
        listing.files.len(),
        1,
        "só o anexo a/f.png deveria aparecer"
    );
    assert_eq!(listing.files[0].path, "a/f.png");
    assert_eq!(listing.files[0].size, 7);
    assert_eq!(listing.files[0].kind, "image");

    assert_eq!(listing.folders, vec!["a".to_string()]);
    assert_eq!(store.kind(), "local");
    assert_eq!(store.label(), dir.path().to_string_lossy());
}

// 2. write_text cria as pastas-pai; read_text/exists/remove
#[tokio::test]
async fn write_text_cria_pastas_e_read_exists_remove_funcionam() {
    let dir = tempdir().expect("tempdir");
    let store = local_store(dir.path());

    let key = "deep/sub/note.md";
    store
        .write_text(key, "olá vault")
        .await
        .expect("write_text");

    assert_eq!(store.read_text(key).await.expect("read_text"), "olá vault");
    assert_eq!(store.read(key).await.expect("read"), "olá vault".as_bytes());

    // exists vale para arquivo E para pasta (igual a existsSync)
    assert!(store.exists(key).await.expect("exists arquivo"));
    assert!(store.exists("deep").await.expect("exists pasta"));
    assert!(store.exists("deep/sub").await.expect("exists subpasta"));

    store.remove(key).await.expect("remove");
    assert!(!store.exists(key).await.expect("exists pós-remove"));

    // local não precisa de URL assinada
    assert!(store.presign(key, true).await.expect("presign").is_none());
}

// 3. rename de nota para pasta nova e rename de pasta
#[tokio::test]
async fn rename_move_nota_para_pasta_nova_e_move_pasta_inteira() {
    let dir = tempdir().expect("tempdir");
    let store = local_store(dir.path());

    store
        .write_text("a/x.md", "conteúdo")
        .await
        .expect("write nota");
    store
        .rename("a/x.md", "b/c/x.md")
        .await
        .expect("rename nota");
    assert!(!store.exists("a/x.md").await.expect("origem sumiu"));
    assert_eq!(
        store.read_text("b/c/x.md").await.expect("nota movida"),
        "conteúdo"
    );
    assert!(store
        .dir_exists("b/c")
        .await
        .expect("pasta criada no rename"));

    // rename de pasta (com conteúdo)
    store.write_text("p/um.md", "um").await.expect("write um");
    store
        .write_text("p/dos.md", "dos")
        .await
        .expect("write dos");
    store.rename("p", "q").await.expect("rename pasta");
    assert!(store.dir_exists("q").await.expect("q existe"));
    assert_eq!(store.read_text("q/um.md").await.expect("um"), "um");
    assert_eq!(store.read_text("q/dos.md").await.expect("dos"), "dos");
    assert!(!store.dir_exists("p").await.expect("p não existe mais"));
}

// 4. mkdir + dir_exists + is_empty_dir + remove_dir
#[tokio::test]
async fn mkdir_dir_exists_is_empty_dir_remove_dir() {
    let dir = tempdir().expect("tempdir");
    let store = local_store(dir.path());

    store.mkdir("00-Inbox/nova").await.expect("mkdir");
    assert!(store.dir_exists("00-Inbox/nova").await.expect("dir_exists"));
    assert!(store
        .is_empty_dir("00-Inbox/nova")
        .await
        .expect("is_empty_dir"));

    store
        .write_text("00-Inbox/nova/foto.png", "x")
        .await
        .expect("write arquivo");
    assert!(!store
        .is_empty_dir("00-Inbox/nova")
        .await
        .expect("deixou de estar vazia"));

    store.remove_dir("00-Inbox").await.expect("remove_dir");
    assert!(!store
        .dir_exists("00-Inbox/nova")
        .await
        .expect("pasta apagada"));
    // remove_dir de algo inexistente não erro (remove_dir_all + NotFound ignorado)
    store
        .remove_dir("nao-existe")
        .await
        .expect("remove_dir NotFound");
}

// 5. read_stream com range (end inclusivo) + stat
#[tokio::test]
async fn read_stream_com_range_e_stat_size() {
    let dir = tempdir().expect("tempdir");
    let store = local_store(dir.path());

    store
        .write_text("n.txt", "0123456789")
        .await
        .expect("write");

    let stream = store
        .read_stream("n.txt", Some(2), Some(4))
        .await
        .expect("read_stream");
    assert_eq!(drain(stream).await, "234");

    let sem_range = store
        .read_stream("n.txt", None, None)
        .await
        .expect("stream");
    assert_eq!(drain(sem_range).await, "0123456789");

    let stat = store.stat("n.txt").await.expect("stat");
    assert_eq!(stat.size, 10);
    assert!(stat.mtime_ms > 0);

    let erro = store.stat("inexistente.txt").await;
    assert!(
        matches!(erro, Err(StoreError::Io(_))),
        "stat de ausente: {erro:?}"
    );
}

// 6. NOTE_EXT e file_type
#[tokio::test]
async fn note_ext_e_file_type() {
    assert!(is_note("a.MD"));
    assert!(is_note("a.md"));
    assert!(is_note("x.base"));
    assert!(!is_note("a.md.bak"));
    assert!(!is_note("md"));

    assert_eq!(file_type("X.PNG").expect("png").kind, "image");
    assert_eq!(file_type("a.txt").expect("txt").kind, "text");
    assert!(file_type("a.exe").is_none());
    assert!(file_type("a").is_none());
}

#[tokio::test]
async fn backend_nao_faz_parte_do_vault() {
    // o vault local é a raiz do repo: o código Rust (e o target/ do cargo) não pode vazar na listagem
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(dir.path().join("backend/src")).expect("mkdir");
    std::fs::write(dir.path().join("backend/src/login.html"), "x").expect("write");
    std::fs::write(dir.path().join("Home.md"), "# Home").expect("write");
    let store = tania::storage::Store::Local(tania::storage::local::LocalFs::new(
        dir.path().to_str().expect("utf8"),
    ));
    let listing = store.list().await.expect("list");
    assert!(listing.files.is_empty());
    assert!(!listing.folders.iter().any(|f| f.starts_with("backend")));
    assert_eq!(listing.notes.len(), 1);
}
