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

/// An explicit absolute root from the client (the code panel's root switcher)
/// — honored only when it resolves to a real directory INSIDE the user's home.
/// The origin guard is the security layer; this just keeps casual path games
/// out. Anything else falls back to the pane root.
fn override_root(param: &Option<String>) -> Option<PathBuf> {
    let p = param.as_deref()?.trim();
    if p.is_empty() {
        return None;
    }
    let home = PathBuf::from(std::env::var_os("HOME")?)
        .canonicalize()
        .ok()?;
    let abs = PathBuf::from(p).canonicalize().ok()?;
    (abs.is_dir() && abs.starts_with(&home)).then_some(abs)
}

/// Effective root for a request carrying an optional `root` override.
pub(crate) async fn root_for_req(pane: Option<u32>, root: &Option<String>) -> PathBuf {
    match override_root(root) {
        Some(r) => r,
        None => root_for(pane).await,
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
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// `GET /fs/root?pane=&root=` — the EFFECTIVE absolute directory this pane's
/// /fs and /lsp requests are rooted at (the code panel needs it to map LSP
/// `file://` URIs back to panel-relative paths, and the root switcher to show
/// what it actually got after server-side validation).
pub async fn root(Query(q): Query<PathQuery>) -> Json<serde_json::Value> {
    let root = root_for_req(q.pane, &q.root).await;
    Json(serde_json::json!({ "root": root.display().to_string() }))
}

/// `GET /fs/list?pane=<id>&path=<rel>` — directory entries (dirs first).
pub async fn list(Query(q): Query<PathQuery>) -> Result<Json<Vec<Entry>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await;
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
    let root = root_for_req(q.pane, &q.root).await;
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
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
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
    let root = root_for_req(q.pane, &q.root).await;
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
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// `POST /fs/write` `{path, content, pane?, root?}` — save a file.
pub async fn write(Json(req): Json<WriteReq>) -> StatusCode {
    let root = root_for_req(req.pane, &req.root).await;
    match safe_path(&root, &req.path, false) {
        Some(file) => match std::fs::write(&file, req.content) {
            Ok(_) => StatusCode::NO_CONTENT,
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
        },
        None => StatusCode::FORBIDDEN,
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
    /// "name" (default): case-insensitive substring over the relative path;
    /// "content": grep-style line matches with line numbers.
    #[serde(default)]
    mode: String,
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct SearchHit {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

/// Directories the walker never enters — dependency/build forests and VCS
/// internals are huge and searching them is never the intent.
const SKIP_DIRS: [&str; 9] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
];
const MAX_HITS: usize = 200;
const MAX_DEPTH: usize = 12;
const MAX_SEARCH_FILE: u64 = 1024 * 1024; // 1 MiB

/// `GET /fs/search?pane=&root=&q=<needle>&mode=name|content` — bounded walk of
/// the effective root. Never follows symlinks (the root is canonicalized, so
/// the walk can't escape it), skips [`SKIP_DIRS`], stops at [`MAX_HITS`].
pub async fn search(Query(q): Query<SearchQuery>) -> Result<Json<Vec<SearchHit>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root)
        .await
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let needle = q.q.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Json(vec![])); // one-char queries flood the walker for nothing
    }
    let content = q.mode == "content";
    // The walk is blocking std::fs; keep it off the async workers.
    tokio::task::spawn_blocking(move || walk_search(&root, &needle, content))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn walk_search(root: &Path, needle: &str, content: bool) -> Vec<SearchHit> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > MAX_DEPTH || hits.len() >= MAX_HITS {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue; // stay inside the canonicalized root
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((e.path(), child_rel, depth + 1));
                }
                continue;
            }
            if !content {
                if child_rel.to_lowercase().contains(needle) {
                    hits.push(SearchHit {
                        path: child_rel,
                        line: None,
                        text: None,
                    });
                }
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.len() > MAX_SEARCH_FILE {
                continue;
            }
            let Ok(bytes) = std::fs::read(e.path()) else {
                continue;
            };
            if bytes.iter().take(8192).any(|&b| b == 0) {
                continue; // binary sniff (same trick as the editor)
            }
            let text = String::from_utf8_lossy(&bytes);
            for (i, line) in text.lines().enumerate() {
                if hits.len() >= MAX_HITS {
                    break;
                }
                if line.to_lowercase().contains(needle) {
                    hits.push(SearchHit {
                        path: child_rel.clone(),
                        line: Some(i as u32 + 1),
                        text: Some(line.trim().chars().take(160).collect()),
                    });
                }
            }
        }
    }
    // DFS pop order is arbitrary across dirs; give the UI something stable:
    // name mode ranks short paths first, content mode groups by file.
    hits.sort_by(|a, b| match (a.line, b.line) {
        (None, None) => a.path.len().cmp(&b.path.len()).then(a.path.cmp(&b.path)),
        _ => a.path.cmp(&b.path).then(a.line.cmp(&b.line)),
    });
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn search_matches_names_and_contents_skipping_forests() {
        let root = std::env::temp_dir().join(format!("mymux-fs-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        touch(
            &root,
            "src/main.rs",
            "fn main() { println!(\"needle\"); }\n",
        );
        touch(&root, "src/needle_helper.rs", "// needle\n");
        touch(&root, "node_modules/dep/index.js", "needle\n");
        std::fs::write(root.join("bin.dat"), b"nee\0dle").unwrap(); // NUL byte → binary

        let names = walk_search(&root, "needle", false);
        assert!(
            names.iter().any(|h| h.path == "src/needle_helper.rs"),
            "{names:?}"
        );
        // The content of needle_helper.rs doesn't matter for name mode.
        assert!(
            !names.iter().any(|h| h.path.contains("node_modules")),
            "{names:?}"
        );

        let contents = walk_search(&root, "needle", true);
        assert!(
            contents
                .iter()
                .any(|h| h.path == "src/main.rs" && h.line == Some(1)),
            "{contents:?}"
        );
        assert!(
            !contents.iter().any(|h| h.path.contains("node_modules")),
            "{contents:?}"
        );
        assert!(
            !contents.iter().any(|h| h.path == "bin.dat"),
            "{contents:?}"
        ); // binary-sniffed out

        let _ = std::fs::remove_dir_all(&root);
    }
}
