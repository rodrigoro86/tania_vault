//! rotas do vault (notas, pastas, rename, upload de anexos, health). Cada
//! módulo entra aqui.

pub mod files;
pub mod notes;
pub mod sanitize;

use axum::routing::{any, delete, get, post, put};
use axum::Router;

use crate::http::proxy::proxy;
use crate::http::AppState;
use crate::vault::notes::{
    create_folder, create_note, delete_folder, delete_note, health, list_notes, rename_path,
    update_note,
};

/// Rotas que o Rust serve. Cada `MethodRouter` tem `.fallback(proxy)`: um
/// método não registrado neste caminho (ex. `GET /api/folders`) vai ao Node,
/// que devolve o 404 dele — nunca um 405 do axum.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health).fallback(proxy))
        .route(
            "/api/notes",
            get(list_notes)
                .post(create_note)
                .put(update_note)
                .fallback(proxy),
        )
        .route("/api/notes/{*rel}", delete(delete_note).fallback(proxy))
        .route("/api/folders", post(create_folder).fallback(proxy))
        .route("/api/folders/{*rel}", delete(delete_folder).fallback(proxy))
        .route("/api/rename", post(rename_path).fallback(proxy))
        // upload de anexo: `DefaultBodyLimit::disable()` deixa passar os 50 MB
        // que o handler valida ele mesmo
        .route(
            "/api/files/{*rel}",
            put(files::upload_file)
                .fallback(proxy)
                .layer(axum::extract::DefaultBodyLimit::disable()),
        )
        // leitura do anexo (GET/HEAD); `any` deixa o handler decidir o 405,
        // então nenhum método escapa para o proxy neste caminho
        .route("/files/{*rel}", any(files::serve_file))
}
