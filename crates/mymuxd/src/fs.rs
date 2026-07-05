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

/// Set once at startup so `root_for` can resolve NATIVE panes' cwds (their
/// shell pids live in the Hub's ptyd mirror; tmux panes are asked via tmux).
static HUB: std::sync::OnceLock<std::sync::Arc<crate::tmux::Hub>> = std::sync::OnceLock::new();
pub(crate) fn init_hub(hub: std::sync::Arc<crate::tmux::Hub>) {
    let _ = HUB.set(hub);
}

/// The root a request is relative to: the focused pane's cwd, else the default.
pub(crate) async fn root_for(pane: Option<u32>) -> PathBuf {
    let Some(p) = pane else {
        return default_root();
    };
    // A pane in the ptyd mirror is native: its shell's cwd comes from /proc.
    if let Some(pid) = HUB.get().and_then(|h| h.persist.pid_of(p)) {
        return std::fs::read_link(format!("/proc/{pid}/cwd")).unwrap_or_else(|_| default_root());
    }
    pane_cwd(p).await.unwrap_or_else(default_root)
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

/// `GET /fs/root?pane=` — the absolute directory this pane's /fs and /lsp
/// requests are rooted at (the code panel needs it to map LSP `file://` URIs
/// back to panel-relative paths for cross-file goto).
pub async fn root(Query(q): Query<PathQuery>) -> Json<serde_json::Value> {
    let root = root_for(q.pane).await;
    Json(serde_json::json!({ "root": root.display().to_string() }))
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
pub struct RawQuery {
    #[serde(default)]
    path: String,
    pane: Option<u32>,
    /// Serve at most this many bytes (hex viewers only need a prefix).
    limit: Option<u64>,
}

/// Cap for raw serves — generous enough for photos, still bounded.
const MAX_RAW: u64 = 50 * 1024 * 1024;

fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `GET /fs/raw?pane=&path=&limit=` — raw bytes with a best-effort MIME type,
/// for the code panel's viewers (images, hex). `X-File-Size` carries the full
/// size so a truncated hex view can say "first 4 KiB of N".
pub async fn raw(
    Query(q): Query<RawQuery>,
) -> Result<([(axum::http::HeaderName, String); 2], Vec<u8>), StatusCode> {
    let root = root_for(q.pane).await;
    let file = safe_path(&root, &q.path, true).ok_or(StatusCode::FORBIDDEN)?;
    let md = std::fs::metadata(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if md.is_dir() || md.len() > MAX_RAW {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut bytes = std::fs::read(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if let Some(limit) = q.limit {
        bytes.truncate(limit.min(MAX_RAW) as usize);
    }
    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                mime_for(&q.path).to_string(),
            ),
            (
                axum::http::HeaderName::from_static("x-file-size"),
                md.len().to_string(),
            ),
        ],
        bytes,
    ))
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
