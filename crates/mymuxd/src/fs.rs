//! Filesystem endpoints for the code panel. Each request is rooted at the
//! focused pane's working directory (`#{pane_current_path}`) when a `pane` is
//! given, else `MYMUX_ROOT`/cwd. [`safe_path`] confines every access to that
//! root (rejecting `..`/symlink escapes); reads are text-only and size-capped.

use std::path::{Path, PathBuf};

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

const MAX_READ: u64 = 2 * 1024 * 1024; // 2 MiB

fn default_root() -> PathBuf {
    std::env::var_os("MYMUX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// A tmux pane's current working directory.
async fn pane_cwd(pane: u32) -> Option<PathBuf> {
    let out = Command::new("tmux")
        .args([
            "-L",
            crate::tmux::socket(),
            "display-message",
            "-p",
            "-t",
            &format!("%{pane}"),
            "#{pane_current_path}",
        ])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!p.is_empty()).then(|| PathBuf::from(p))
}

/// The root a request is relative to: the focused pane's cwd, else the default.
pub(crate) async fn root_for(pane: Option<u32>) -> PathBuf {
    match pane {
        Some(p) => pane_cwd(p).await.unwrap_or_else(default_root),
        None => default_root(),
    }
}

/// Resolve a client path within `root`, rejecting anything that escapes it.
/// `must_exist=false` (writes) allows a new file by checking its parent.
pub(crate) fn safe_path(root: &Path, rel: &str, must_exist: bool) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let joined = root.join(rel.trim_start_matches('/'));
    let resolved = if must_exist {
        joined.canonicalize().ok()?
    } else {
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
    pane: Option<u32>,
}

/// `GET /fs/list?pane=<id>&path=<rel>` — directory entries (dirs first).
pub async fn list(Query(q): Query<PathQuery>) -> Result<Json<Vec<Entry>>, StatusCode> {
    let root = root_for(q.pane).await;
    let dir = safe_path(&root, &q.path, true).ok_or(StatusCode::FORBIDDEN)?;
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

/// `GET /fs/read?pane=<id>&path=<rel>` — file contents (text, size-capped).
pub async fn read(Query(q): Query<PathQuery>) -> Result<String, StatusCode> {
    let root = root_for(q.pane).await;
    let file = safe_path(&root, &q.path, true).ok_or(StatusCode::FORBIDDEN)?;
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
    pane: Option<u32>,
}

/// `POST /fs/write` `{path, content, pane?}` — save a file.
pub async fn write(Json(req): Json<WriteReq>) -> StatusCode {
    let root = root_for(req.pane).await;
    match safe_path(&root, &req.path, false) {
        Some(file) => match std::fs::write(&file, req.content) {
            Ok(_) => StatusCode::NO_CONTENT,
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        None => StatusCode::FORBIDDEN,
    }
}
