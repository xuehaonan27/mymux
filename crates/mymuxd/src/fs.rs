//! Filesystem endpoints for the code panel. Each request is rooted at the
//! focused pane's working directory (`#{pane_current_path}`) when a `pane` is
//! given, else `MYMUX_ROOT`/cwd. [`safe_path`] confines every access to that
//! root (rejecting `..`/symlink escapes); reads are text-only and size-capped.
//! A PRESENT-but-invalid pane/root fails (404/403) instead of falling back to
//! a plausible-but-wrong directory; writes reject symlink leaves and land
//! atomically (temp + rename).

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

/// A present pane's root, or 404 when the id is unknown/gone — a stale
/// request must FAIL, not silently act on a plausible-but-wrong directory.
/// An ABSENT pane param is explicit default-root intent (the path-jump
/// probes and root-only callers send no pane).
pub(crate) async fn root_for_strict(pane: Option<u32>) -> Result<PathBuf, StatusCode> {
    let Some(p) = pane else {
        return Ok(default_root());
    };
    // A pane in the ptyd mirror is native: its shell's cwd comes from /proc.
    if let Some(pid) = HUB.get().and_then(|h| h.persist.pid_of(p)) {
        return std::fs::read_link(format!("/proc/{pid}/cwd")).map_err(|_| StatusCode::NOT_FOUND);
    }
    pane_cwd(p).await.ok_or(StatusCode::NOT_FOUND)
}

/// The `root` override param, three ways. An explicit absolute root from the
/// client (the code panel's root switcher) is honored only when it resolves
/// to a real directory INSIDE the user's home. The origin guard is the
/// security layer; this just keeps casual path games out. A PRESENT-but-
/// invalid override is an error (403), never a silent fallback.
enum OverrideRoot {
    /// No `root` param (or blank): resolve from the pane/default.
    Absent,
    /// `root` given but not a real directory inside the user's home.
    Invalid,
    Valid(PathBuf),
}

fn override_root(param: &Option<String>) -> OverrideRoot {
    let Some(p) = param.as_deref().map(str::trim).filter(|p| !p.is_empty()) else {
        return OverrideRoot::Absent;
    };
    let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| h.canonicalize().ok())
    else {
        return OverrideRoot::Invalid;
    };
    match PathBuf::from(p).canonicalize() {
        Ok(abs) if abs.is_dir() && abs.starts_with(&home) => OverrideRoot::Valid(abs),
        _ => OverrideRoot::Invalid,
    }
}

/// Effective root for a request carrying an optional `root` override.
/// Errors: 404 for a present-but-unknown pane, 403 for a present-but-invalid
/// root override (audit C-26 — stale pane/root requests previously fell back
/// to the daemon cwd and read/wrote the wrong directory).
pub(crate) async fn root_for_req(
    pane: Option<u32>,
    root: &Option<String>,
) -> Result<PathBuf, StatusCode> {
    match override_root(root) {
        OverrideRoot::Valid(r) => Ok(r),
        OverrideRoot::Invalid => Err(StatusCode::FORBIDDEN),
        OverrideRoot::Absent => root_for_strict(pane).await,
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
pub async fn root(Query(q): Query<PathQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    Ok(Json(serde_json::json!({ "root": root.display().to_string() })))
}

/// `GET /fs/list?pane=<id>&path=<rel>` — directory entries (dirs first).
pub async fn list(Query(q): Query<PathQuery>) -> Result<Json<Vec<Entry>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
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
    let root = root_for_req(q.pane, &q.root).await?;
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

/// Read at most `cap` bytes of `file` — viewers ask for a prefix (hex = a few
/// KiB, the path-jump probe = 1 byte), so never slurp the whole file to serve
/// a few bytes.
fn read_capped(file: &Path, cap: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read as _;
    let f = std::fs::File::open(file)?;
    let mut bytes = Vec::new();
    f.take(cap).read_to_end(&mut bytes)?;
    Ok(bytes)
}

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
    let root = root_for_req(q.pane, &q.root).await?;
    let file = safe_path(&root, &q.path, true).ok_or(StatusCode::FORBIDDEN)?;
    let md = std::fs::metadata(&file).map_err(|_| StatusCode::NOT_FOUND)?;
    if md.is_dir() || md.len() > MAX_RAW {
        return Err(StatusCode::BAD_REQUEST);
    }
    let bytes = read_capped(&file, q.limit.unwrap_or(MAX_RAW).min(MAX_RAW))
        .map_err(|_| StatusCode::NOT_FOUND)?;
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
    let root = match root_for_req(req.pane, &req.root).await {
        Ok(r) => r,
        Err(code) => return code,
    };
    match safe_path(&root, &req.path, false) {
        Some(file) => match write_confined(&file, req.content.as_bytes()) {
            Ok(()) => StatusCode::NO_CONTENT,
            Err(code) => code,
        },
        None => StatusCode::FORBIDDEN,
    }
}

/// The /fs/write leaf discipline, split out for tests. A final-component
/// symlink (or any other non-regular existing file) is REJECTED, never
/// followed out of the confined root (P0-02); the content then lands via a
/// same-directory temp + atomic rename, so a mid-write failure can't leave a
/// truncated original (#8).
fn write_confined(file: &Path, content: &[u8]) -> Result<(), StatusCode> {
    match std::fs::symlink_metadata(file) {
        Ok(md) => {
            let ft = md.file_type();
            if ft.is_symlink() || !ft.is_file() {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
    atomic_write(file, content).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Monotonic suffix so concurrent saves of the SAME file don't collide on
/// one temp name (last rename wins, atomically).
static TMP_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Write `content` to `file` atomically: a same-directory temp file, then a
/// rename over the target. rename REPLACES whatever leaf is there — a symlink
/// raced in after the [`write_confined`] check is overwritten, never followed
/// (rename does not follow a destination symlink). A replacement keeps the
/// old file's permission bits; a new file gets fresh 0666&~umask semantics.
fn atomic_write(file: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let parent = file
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no parent dir"))?;
    let leaf = file.file_name().unwrap_or_default().to_string_lossy();
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = parent.join(format!(".{leaf}.mymux-tmp-{}-{seq}", std::process::id()));
    let result = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            opts.mode(0o666);
        }
        let mut f = opts.open(&tmp)?;
        if let Ok(md) = std::fs::metadata(file) {
            let _ = std::fs::set_permissions(&tmp, md.permissions());
        }
        f.write_all(content)?;
        drop(f);
        std::fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp); // never leave a temp behind
    }
    result
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
        .await?
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
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
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
            let Ok(bytes) = std::fs::read(e.path()) else { continue };
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

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mymux-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn search_matches_names_and_contents_skipping_forests() {
        let root = std::env::temp_dir().join(format!("mymux-fs-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        touch(&root, "src/main.rs", "fn main() { println!(\"needle\"); }\n");
        touch(&root, "src/needle_helper.rs", "// needle\n");
        touch(&root, "node_modules/dep/index.js", "needle\n");
        std::fs::write(root.join("bin.dat"), b"nee\0dle").unwrap(); // NUL byte → binary

        let names = walk_search(&root, "needle", false);
        assert!(
            names.iter().any(|h| h.path == "src/needle_helper.rs"),
            "{names:?}"
        );
        // The content of needle_helper.rs doesn't matter for name mode.
        assert!(!names.iter().any(|h| h.path.contains("node_modules")), "{names:?}");

        let contents = walk_search(&root, "needle", true);
        assert!(
            contents
                .iter()
                .any(|h| h.path == "src/main.rs" && h.line == Some(1)),
            "{contents:?}"
        );
        assert!(!contents.iter().any(|h| h.path.contains("node_modules")), "{contents:?}");
        assert!(!contents.iter().any(|h| h.path == "bin.dat"), "{contents:?}"); // binary-sniffed out

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn raw_read_is_bounded_by_the_limit() {
        let dir = test_dir("rawcap");
        let file = dir.join("big.bin");
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();
        let got = read_capped(&file, 4096).unwrap();
        assert_eq!(got.len(), 4096);
        assert_eq!(got, data[..4096]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_a_new_file() {
        let dir = test_dir("new");
        let file = dir.join("created.txt");
        write_confined(&file, b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello");
        assert_no_temps(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    fn nofollow_mode(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn write_replaces_existing_and_keeps_its_mode() {
        let dir = test_dir("replace");
        let file = dir.join("keep.txt");
        std::fs::write(&file, "old content").unwrap();
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        write_confined(&file, b"new content").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new content");
        assert_eq!(nofollow_mode(&file), 0o640, "replacement kept the old mode");
        assert_no_temps(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn assert_no_temps(dir: &Path) {
        let temps: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".mymux-tmp-"))
            .collect();
        assert!(temps.is_empty(), "leftover temp files: {temps:?}");
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_a_symlink_leaf() {
        let dir = test_dir("symlink");
        let outside = dir.join("outside.txt");
        std::fs::write(&outside, "precious").unwrap();
        let link = dir.join("escape.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(
            write_confined(&link, b"escaped-write"),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "precious");
        assert!(
            std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the symlink itself must survive the rejection"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rejects_a_non_regular_leaf() {
        let dir = test_dir("nonregular");
        let sub = dir.join("subdir");
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(write_confined(&sub, b"x"), Err(StatusCode::FORBIDDEN));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The swap race: an attacker flips the leaf between symlink and regular
    /// file while saves land. rename() replaces WHATEVER leaf exists — the
    /// outside target must never be written, on any interleaving.
    #[cfg(unix)]
    #[test]
    fn write_swap_race_never_follows_the_symlink() {
        let dir = test_dir("swaprace");
        let outside = dir.join("outside.txt");
        std::fs::write(&outside, "precious").unwrap();
        let link = dir.join("race.txt");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let swapper = {
            let outside = outside.clone();
            let link = link.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut regular = false;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&link);
                    if regular {
                        let _ = std::fs::write(&link, "decoy");
                    } else {
                        let _ = std::os::unix::fs::symlink(&outside, &link);
                    }
                    regular = !regular;
                }
            })
        };
        for i in 0..200 {
            let content = format!("payload-{i}");
            let _ = write_confined(&link, content.as_bytes()); // 403 or success — both fine
            assert_eq!(
                std::fs::read_to_string(&outside).unwrap(),
                "precious",
                "iteration {i}: the write followed a raced symlink out of confinement"
            );
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        swapper.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Atomicity (#8): a concurrent reader only ever observes the complete
    /// old content or the complete new content, never a partial write.
    #[test]
    fn write_is_atomic_under_a_concurrent_reader() {
        let dir = test_dir("atomic");
        let file = dir.join("data.txt");
        let old = "O".repeat(4096);
        std::fs::write(&file, &old).unwrap();
        let new = "N".repeat(4 * 1024 * 1024); // big enough to span many write() calls
        let writer = {
            let file = file.clone();
            let new = new.clone();
            std::thread::spawn(move || write_confined(&file, new.as_bytes()))
        };
        while !writer.is_finished() {
            let seen = std::fs::read(&file).unwrap();
            assert!(
                seen == old.as_bytes() || seen == new.as_bytes(),
                "observed a partial write ({} bytes)",
                seen.len()
            );
        }
        writer.join().unwrap().unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), new.as_bytes());
        assert_no_temps(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
