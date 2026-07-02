//! Filesystem endpoints for the code panel, confined to a single root
//! (`MYMUX_ROOT` or the daemon's cwd). Every client path goes through
//! [`safe_path`], which canonicalizes and rejects anything escaping the root
//! (via `..` or a symlink). Reads are text-only and size-capped.

use std::path::PathBuf;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

const MAX_READ: u64 = 2 * 1024 * 1024; // 2 MiB

pub(crate) fn root() -> PathBuf {
    std::env::var_os("MYMUX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Resolve a client-relative path to an absolute path confined to the root.
/// `must_exist=false` (writes) allows a new file by checking its parent instead.
pub(crate) fn safe_path(rel: &str, must_exist: bool) -> Option<PathBuf> {
    let root = root().canonicalize().ok()?;
    let joined = root.join(rel.trim_start_matches('/'));
    let resolved = if must_exist {
        joined.canonicalize().ok()?
    } else {
        // The file may not exist yet: canonicalize the (existing) parent, then
        // re-attach a plain file name (`..` has no file_name, so it's rejected).
        let parent = joined.parent()?.canonicalize().ok()?;
        parent.join(joined.file_name()?)
    };
    resolved.starts_with(&root).then_some(resolved)
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    size: u64,
}

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

/// `GET /fs/list?path=<rel>` — directory entries (dirs first, then by name).
pub async fn list(Query(q): Query<PathQuery>) -> Result<Json<Vec<Entry>>, StatusCode> {
    let dir = safe_path(&q.path, true).ok_or(StatusCode::FORBIDDEN)?;
    let rd = std::fs::read_dir(&dir).map_err(|_| StatusCode::NOT_FOUND)?;
    let mut entries: Vec<Entry> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            Some(Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                dir: ft.is_dir(),
                size: e.metadata().map(|m| m.len()).unwrap_or(0),
            })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    Ok(Json(entries))
}

/// `GET /fs/read?path=<rel>` — file contents (text, size-capped).
pub async fn read(Query(q): Query<PathQuery>) -> Result<String, StatusCode> {
    let file = safe_path(&q.path, true).ok_or(StatusCode::FORBIDDEN)?;
    let md = std::fs::metadata(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if md.is_dir() || md.len() > MAX_READ {
        return Err(StatusCode::BAD_REQUEST);
    }
    let bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    String::from_utf8(bytes).map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)
}

#[derive(Deserialize)]
pub struct WriteReq {
    path: String,
    content: String,
}

/// `POST /fs/write` `{path, content}` — save a file.
pub async fn write(Json(req): Json<WriteReq>) -> StatusCode {
    match safe_path(&req.path, false) {
        Some(file) => match std::fs::write(&file, req.content) {
            Ok(_) => StatusCode::NO_CONTENT,
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        None => StatusCode::FORBIDDEN,
    }
}
