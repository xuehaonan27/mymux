//! Git endpoints for the code panel: changed-file list and per-file unified
//! diff, run inside the focused pane's directory (or the default root).

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::fs::{root_for_req, safe_path};

/// Hard deadline for every git READ (mutations get their own, longer ones).
const READ_TIMEOUT: u64 = 30;
/// Collection caps for the shared read runner (`read_capped`): listings vs.
/// small one-value probes vs. blob bodies.
const LIST_CAP: usize = 8 * 1024 * 1024;
const META_CAP: usize = 1024 * 1024;
const BLOB_CAP: usize = 8 * 1024 * 1024;
/// Unified-diff cap for show/compare/diff (~4 MiB, as displayed).
const DIFF_CAP: usize = 4_000_000;

#[derive(Serialize)]
pub struct GitFile {
    /// Two-char porcelain status, e.g. " M", "A ", "??", "R ".
    status: String,
    path: String,
    /// True for gitlinks (submodule boundaries) — the UI navigates INTO them
    /// instead of diffing them like a plain file.
    submodule: bool,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
    /// `ignored=1`: include `!!` entries (gitignore-matched files/dirs) — the
    /// file tree dims them; the changes list never asks and stays clean.
    ignored: Option<String>,
}

/// `GET /git/status?pane=<id>` — working-tree + staged changes.
pub async fn status(Query(q): Query<StatusQuery>) -> Result<Json<Vec<GitFile>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let mut args = vec!["status", "--porcelain=v1", "-z"];
    if q.ignored.as_deref() == Some("1") {
        // "matching" collapses ignored dirs to one row (node_modules/ itself,
        // not its whole forest) — exactly what a tree needs to dim.
        args.push("--ignored=matching");
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args(&args);
    let Some(out) = read_capped(cmd, LIST_CAP, READ_TIMEOUT).await else {
        return Ok(Json(vec![]));
    };
    if !out.ok {
        return Ok(Json(vec![]));
    }
    let mut files = parse_status_z(&out.stdout);
    // Mark gitlinks. .gitmodules lives at the toplevel while status paths are
    // prefix-relative, so re-root the submodule paths at the current prefix.
    if let Some(subs) = submodule_paths(&root).await {
        if !subs.is_empty() {
            for f in &mut files {
                f.submodule = subs.contains(&f.path);
            }
        }
    }
    Ok(Json(files))
}

/// Parse `status --porcelain=v1 -z`: NUL-terminated `XY <path>` records with
/// RAW filenames (no C-quoting — Chinese, newline, tab and quote characters
/// all survive). Rename/copy records are `XY <new>\0<old>\0`: git reverses
/// the human "old -> new" order under -z, and the tree colors the NEW path.
fn parse_status_z(bytes: &[u8]) -> Vec<GitFile> {
    let mut files = Vec::new();
    let mut it = bytes.split(|&b| b == 0);
    while let Some(rec) = it.next() {
        if rec.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&rec[..2]).into_owned();
        let path = String::from_utf8_lossy(&rec[3..]).into_owned();
        if status.contains('R') || status.contains('C') {
            it.next(); // the original path — the panel tracks the new one
        }
        files.push(GitFile {
            status,
            path,
            submodule: false,
        });
    }
    files
}

/// Submodule paths relative to the CURRENT root (status/diff path style):
/// .gitmodules values are toplevel-relative, so strip the pane's prefix (""
/// at the toplevel; a subdir prefix keeps out-of-view subs from matching).
/// None outside a work tree; Some(vec![]) when there's no .gitmodules.
async fn submodule_paths(root: &std::path::Path) -> Option<Vec<String>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel", "--show-prefix"]);
    let out = read_capped(cmd, META_CAP, READ_TIMEOUT).await?;
    if !out.ok {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let top = lines.next()?.trim().to_string();
    let prefix = lines.next().unwrap_or("").trim().to_string();
    let mut cfg = Command::new("git");
    cfg.arg("-C")
        .arg(&top)
        .args(["config", "-f", ".gitmodules", "--get-regexp", "\\.path$"]);
    let cfgs = read_capped(cfg, META_CAP, READ_TIMEOUT).await?;
    if !cfgs.ok {
        return Some(vec![]); // no .gitmodules
    }
    let subs = String::from_utf8_lossy(&cfgs.stdout)
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        .filter_map(|p| p.strip_prefix(prefix.as_str()).map(str::to_string))
        .collect();
    Some(subs)
}

#[derive(Serialize)]
pub struct SubmoduleInfo {
    path: String,
    /// False = registered in .gitmodules but never initialized (empty dir) —
    /// the tree offers a one-click `submodule update --init` then.
    initialized: bool,
}

/// `GET /git/submodules?pane=&root=` — .gitmodules entries + init state.
pub async fn submodules(
    Query(q): Query<StatusQuery>,
) -> Result<Json<Vec<SubmoduleInfo>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let Some(paths) = submodule_paths(&root).await else {
        return Ok(Json(vec![]));
    };
    let infos = paths
        .into_iter()
        .map(|path| {
            // An initialized submodule anchors via a .git FILE (or dir).
            let anchored = root.join(&path).join(".git").exists();
            SubmoduleInfo {
                path,
                initialized: anchored,
            }
        })
        .collect();
    Ok(Json(infos))
}

/// `GET /git/files?pane=<id>` — tracked + untracked (non-ignored) files, for
/// the code panel's quick-open. Empty outside a repo; capped.
pub async fn files(Query(q): Query<StatusQuery>) -> Result<Json<Vec<String>>, StatusCode> {
    const CAP: usize = 20_000;
    let root = root_for_req(q.pane, &q.root).await?;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args([
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
    ]);
    let Some(out) = read_capped(cmd, LIST_CAP, READ_TIMEOUT).await else {
        return Ok(Json(vec![]));
    };
    if !out.ok {
        return Ok(Json(vec![]));
    }
    let files = out
        .stdout
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .take(CAP)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    Ok(Json(files))
}

#[derive(Deserialize)]
pub struct DiffQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// `GET /git/diff?pane=<id>&path=<rel>&staged=<bool>` — unified diff. New /
/// untracked files are shown as all-added. Capped at ~4 MiB like show/compare.
pub async fn diff(Query(q): Query<DiffQuery>) -> Result<String, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let abs = if q.path.is_empty() {
        None
    } else {
        Some(safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?)
    };

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args(["diff", "--no-color"]);
    if q.staged {
        cmd.arg("--staged");
    }
    if !q.path.is_empty() {
        cmd.arg("--").arg(&q.path);
    }
    let out = read_capped(cmd, DIFF_CAP, READ_TIMEOUT)
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut diff = lossy_capped(&out.stdout, DIFF_CAP);
    if out.truncated {
        diff.push_str("\n… (diff truncated at 4 MiB)\n");
    }

    if diff.trim().is_empty() && !q.staged && abs.is_some() {
        // The all-added fallback is for UNTRACKED files only — an empty
        // tracked diff (nothing unstaged, or nothing staged) is just empty.
        // (-z: an exotic filename would be C-quoted in human porcelain and
        // the `??` prefix check could still pass, but stay consistent.)
        let mut probe = Command::new("git");
        probe
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain", "-z", "--", &q.path]);
        let untracked = read_capped(probe, META_CAP, READ_TIMEOUT)
            .await
            .map(|o| o.stdout.starts_with(b"??"))
            .unwrap_or(false);
        if untracked {
            // Untracked file: fake an all-added diff. Pass the RELATIVE path
            // (validated above) so the header doesn't leak the absolute one.
            // --no-index exits 1 when files differ — the diff is still there.
            let mut cmd = Command::new("git");
            cmd.arg("-C")
                .arg(&root)
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &q.path]);
            if let Some(out) = read_capped(cmd, DIFF_CAP, READ_TIMEOUT).await {
                diff = lossy_capped(&out.stdout, DIFF_CAP);
                if out.truncated {
                    diff.push_str("\n… (diff truncated at 4 MiB)\n");
                }
            }
        }
    }
    Ok(diff)
}

/// `GET /git/toplevel?pane=<id>&root=` — the repo root for the panel's root
/// switcher (null when the effective root isn't inside a work tree).
pub async fn toplevel(Query(q): Query<StatusQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args(["rev-parse", "--show-toplevel"]);
    let top = read_capped(cmd, META_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(Json(serde_json::json!({ "toplevel": top })))
}

#[derive(Deserialize)]
pub struct BlobQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// `GET /git/blob?pane=&path=&staged=` — the file's HEAD blob (or its INDEX
/// blob when staged) for the split diff's left side. 404 when absent
/// (untracked file, or no staged copy).
pub async fn blob(Query(q): Query<BlobQuery>) -> Result<String, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
    let spec = if q.staged {
        format!(":{}", q.path)
    } else {
        format!("HEAD:{}", q.path)
    };
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["show", "--no-color", "--no-textconv", &spec]);
    let out = read_capped(cmd, BLOB_CAP, READ_TIMEOUT)
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if !out.ok {
        return Err(StatusCode::NOT_FOUND);
    }
    if out.truncated {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    String::from_utf8(out.stdout).map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)
}

// ---- history (the graph panel) ------------------------------------------------

/// A revision used as a query target. No shell is involved, but a leading '-'
/// would still read as an option to git — reject it.
fn valid_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= 128
        && !rev.starts_with('-')
        && rev
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/^@~+-{}".contains(c))
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LogCommit {
    hash: String,
    parents: Vec<String>,
    author: String,
    /// ISO-8601 commit author date.
    date: String,
    subject: String,
    /// Ref decorations as one string ("HEAD -> main, origin/main, tag: v1").
    refs: String,
}

/// Parse `--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D` rows.
fn parse_log(text: &str) -> Vec<LogCommit> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            Some(LogCommit {
                hash: f[0].to_string(),
                parents: f[1].split(' ').filter(|p| !p.is_empty()).map(str::to_string).collect(),
                author: f[2].to_string(),
                date: f[3].to_string(),
                subject: f[4].to_string(),
                refs: f.get(5).unwrap_or(&"").to_string(),
            })
        })
        .collect()
}

#[derive(Deserialize)]
pub struct LogQuery {
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
    limit: Option<usize>,
    skip: Option<usize>,
    /// 1 = --all (every ref), 0/absent = HEAD's history only.
    all: Option<bool>,
    /// Optional explicit revision (a branch name); wins over --all/HEAD.
    rev: Option<String>,
    /// Optional path: history of one file, renames followed (--follow).
    path: Option<String>,
}

/// `GET /git/log?pane=&root=&limit=&skip=&all=` — commit topology for the
/// graph (HEAD + every ref by default), plus the current branch and its
/// upstream ahead/behind for the push/pull affordances.
pub async fn log(Query(q): Query<LogQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let skip = q.skip.unwrap_or(0);
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).arg("log");
    // An explicit branch filter wins ("the branch's own history"); otherwise
    // --all (default) or HEAD only. A bad rev just yields an empty page.
    let rev = q.rev.filter(|r| valid_rev(r));
    if let Some(rev) = &rev {
        cmd.arg(rev);
    } else if q.all.unwrap_or(true) {
        cmd.arg("--all");
    }
    // File-history mode: one path, renames followed. safe_path gates escape.
    let path = q.path.clone().filter(|p| !p.is_empty());
    let path = match &path {
        Some(p) => match safe_path(&root, p, false) {
            Some(_) => Some(p.clone()),
            None => return Ok(Json(serde_json::json!({ "error": "path outside the root" }))),
        },
        None => None,
    };
    if path.is_some() {
        cmd.arg("--follow");
    }
    cmd.args([
        "--date-order",
        "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D",
        "-n",
        &limit.to_string(),
        "--skip",
        &skip.to_string(),
    ]);
    if let Some(p) = &path {
        cmd.arg("--").arg(p);
    }
    let commits = read_capped(cmd, LIST_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| parse_log(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    let mut branch_cmd = Command::new("git");
    branch_cmd
        .arg("-C")
        .arg(&root)
        .args(["branch", "--show-current"]);
    let branch = read_capped(branch_cmd, META_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // HEAD...@{upstream}: "ahead<TAB>behind" — fails when there's no upstream
    // (detached, never pushed) — both counts stay null then.
    let (upstream, ahead, behind) = {
        let mut name_cmd = Command::new("git");
        name_cmd
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
        let name = read_capped(name_cmd, META_CAP, READ_TIMEOUT)
            .await
            .filter(|o| o.ok)
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        let mut count_cmd = Command::new("git");
        count_cmd
            .arg("-C")
            .arg(&root)
            .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
        let counts = read_capped(count_cmd, META_CAP, READ_TIMEOUT)
            .await
            .filter(|o| o.ok)
            .and_then(|o| {
                let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let mut it = t.split_whitespace();
                Some((it.next()?.parse::<u64>().ok()?, it.next()?.parse::<u64>().ok()?))
            });
        match (name, counts) {
            (Some(u), Some((a, b))) => (Some(u), Some(a), Some(b)),
            _ => (None, None, None),
        }
    };

    // Local branch names for the filter dropdown (bounded, silent on error).
    let mut ref_cmd = Command::new("git");
    ref_cmd
        .arg("-C")
        .arg(&root)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    let branches: Vec<String> = read_capped(ref_cmd, META_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::to_string)
                .filter(|s| !s.is_empty())
                .take(500)
                .collect()
        })
        .unwrap_or_default();

    Ok(Json(serde_json::json!({
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "commits": commits,
        "branches": branches,
    })))
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct ShowFile {
    /// Porcelain-ish letter: M, A, D, R…
    status: String,
    path: String,
}

#[derive(Deserialize)]
pub struct ShowQuery {
    #[serde(default)]
    rev: String,
    /// Only this file's diff in the detail pane (validated like /git/diff).
    #[serde(default)]
    path: String,
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// Name-status rows of `git show/diff --name-status --format= -z`: NUL-
/// terminated fields with RAW filenames — `M\0path\0`, and rename/copy
/// `R100\0old\0new\0` (diff order is source-first; the panel lists the
/// destination).
fn parse_name_status_z(bytes: &[u8]) -> Vec<ShowFile> {
    let mut files = Vec::new();
    let mut it = bytes.split(|&b| b == 0);
    while let Some(st) = it.next() {
        if st.is_empty() {
            continue;
        }
        let letter = String::from_utf8_lossy(st).chars().next().unwrap_or('M');
        let Some(first) = it.next().filter(|p| !p.is_empty()) else {
            continue;
        };
        let path = if letter == 'R' || letter == 'C' {
            let Some(new) = it.next().filter(|p| !p.is_empty()) else {
                continue;
            };
            new
        } else {
            first
        };
        files.push(ShowFile {
            status: letter.to_string(),
            path: String::from_utf8_lossy(path).into_owned(),
        });
    }
    files
}

/// `GET /git/show?pane=&root=&rev=` — one commit's meta, its name-status file
/// list, and the unified diff (capped at ~4 MiB) for the detail pane.
pub async fn show(Query(q): Query<ShowQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    if !valid_rev(&q.rev) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = root_for_req(q.pane, &q.root).await?;

    // Meta and name-status are separate spawns on purpose: an empty --or
    // arbitrary—commit body makes a one-shot format unparseable.
    let mut meta_cmd = Command::new("git");
    meta_cmd
        .arg("-C")
        .arg(&root)
        .args(["show", "-s", "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b", &q.rev]);
    let meta = read_capped(meta_cmd, META_CAP, READ_TIMEOUT)
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if !meta.ok {
        return Err(StatusCode::NOT_FOUND);
    }
    let (hash, author, date, subject, body) = {
        let text = String::from_utf8_lossy(&meta.stdout);
        let mut f = text.splitn(6, '\x1f');
        let hash = f.next().ok_or(StatusCode::NOT_FOUND)?.to_string();
        let author = f.next().unwrap_or("").to_string();
        let date = f.next().unwrap_or("").to_string();
        let subject = f.next().unwrap_or("").to_string();
        let body = f.next().unwrap_or("").trim_end().to_string();
        (hash, author, date, subject, body)
    };

    let mut files_cmd = Command::new("git");
    files_cmd
        .arg("-C")
        .arg(&root)
        .args(["show", "--name-status", "--format=", "-z", &q.rev]);
    let files = read_capped(files_cmd, LIST_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| parse_name_status_z(&o.stdout))
        .unwrap_or_default();

    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["show", "--format=", "--no-color", &q.rev]);
    if !q.path.is_empty() {
        safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
        cmd.arg("--").arg(&q.path);
    }
    let diff_out = read_capped(cmd, DIFF_CAP, READ_TIMEOUT)
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut diff = lossy_capped(&diff_out.stdout, DIFF_CAP);
    if diff_out.truncated {
        diff.push_str("\n… (diff truncated at 4 MiB)\n");
    }

    Ok(Json(serde_json::json!({
        "hash": hash,
        "author": author,
        "date": date,
        "subject": subject,
        "body": body,
        "files": files,
        "diff": diff,
    })))
}

#[derive(Deserialize)]
pub struct CompareQuery {
    #[serde(default)]
    rev: String,
    #[serde(default)]
    rev2: String,
    #[serde(default)]
    path: String,
    pane: Option<u32>,
    root: Option<String>,
}

/// `GET /git/compare?pane=&root=&rev=A&rev2=B` — the A..B cumulative diff
/// (name-status files + unified diff, same 4 MiB cap as /git/show).
pub async fn compare(Query(q): Query<CompareQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    if !valid_rev(&q.rev) || !valid_rev(&q.rev2) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = root_for_req(q.pane, &q.root).await?;
    let mut files_cmd = Command::new("git");
    files_cmd
        .arg("-C")
        .arg(&root)
        .args(["diff", "--name-status", "--format=", "-z", &q.rev, &q.rev2]);
    let files = read_capped(files_cmd, LIST_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| parse_name_status_z(&o.stdout))
        .unwrap_or_default();
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["diff", "--no-color", &q.rev, &q.rev2]);
    if !q.path.is_empty() {
        safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
        cmd.arg("--").arg(&q.path);
    }
    let diff_out = read_capped(cmd, DIFF_CAP, READ_TIMEOUT)
        .await
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if !diff_out.ok {
        return Err(StatusCode::NOT_FOUND);
    }
    let mut diff = lossy_capped(&diff_out.stdout, DIFF_CAP);
    if diff_out.truncated {
        diff.push_str("\n… (diff truncated at 4 MiB)\n");
    }
    Ok(Json(serde_json::json!({ "files": files, "diff": diff })))
}

// ---- write operations (the graph panel's action buttons) ---------------------

#[derive(Deserialize, Clone)]
pub struct WriteReq {
    /// Only for add/unstage: the file to (un)stage. Absent/empty = everything.
    path: Option<String>,
    /// Only for commit: the message (argv-passed, no shell anywhere).
    message: Option<String>,
    /// Only for the rev ops (cherry-pick/revert/reset/checkout).
    rev: Option<String>,
    /// Only for reset: soft|mixed|hard (validated, no silent default).
    mode: Option<String>,
    /// Only for /git/op: continue|abort.
    action: Option<String>,
    /// Only for branch/tag create: the commit to point at (absent = HEAD).
    at: Option<String>,
    /// Only for /git/apply: the reduced unified diff to apply --cached.
    patch: Option<String>,
    /// Only for /git/apply: true = unstage (--reverse).
    reverse: Option<bool>,
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

#[derive(Serialize)]
pub struct WriteResp {
    ok: bool,
    /// stdout+stderr tail — git narrates failures well (no upstream, hooks,
    /// rebase conflicts); the UI toasts it verbatim.
    out: String,
}

/// Run one user-initiated git mutation. Network verbs get 120s, the rest 60s.
async fn run_op(q: &WriteReq, args: &[&str], timeout_secs: u64) -> WriteResp {
    let root = match root_for_req(q.pane, &q.root).await {
        Ok(r) => r,
        Err(code) => return root_err_resp(code),
    };
    if let Some(p) = &q.path {
        if !p.is_empty() && safe_path(&root, p, false).is_none() {
            return WriteResp {
                ok: false,
                out: "path outside the root".into(),
            };
        }
    }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args(args);
    run_git(cmd, timeout_secs, None).await
}

/// A mutation rejected before git even ran because the pane/root failed
/// resolution (audit C-26: never silently act on the default root).
fn root_err_resp(code: StatusCode) -> WriteResp {
    let what = match code {
        StatusCode::NOT_FOUND => "unknown (or gone) pane",
        StatusCode::FORBIDDEN => "root override outside the home directory",
        _ => "bad pane/root",
    };
    WriteResp {
        ok: false,
        out: what.into(),
    }
}

/// SIGKILL a timed-out child's whole process group (hooks and helpers spawn
/// their own children), then reap the leader. The child leads its own group
/// (`process_group(0)`), so its pid IS the pgid; `kill` takes the negative
/// form for a group target.
async fn kill_process_group(child: &mut tokio::process::Child) {
    kill_process_group_by_pid(child.id()).await;
    let _ = child.kill().await; // belt: the leader, if the group signal missed it
    let _ = child.wait().await; // reap — no zombie left behind
}

/// The pid-only half of [`kill_process_group`], for a timeout that dropped
/// the child future with it: kill_on_drop already SIGKILLed the leader
/// (tokio's orphan reaper collects it) — the GROUP still needs its signal.
/// (`--` before the negative pid is load-bearing: without it procps kill
/// misreads the number as an option and signals the CALLER'S group instead.)
async fn kill_process_group_by_pid(pid: Option<u32>) {
    let _ = pid;
    #[cfg(unix)]
    if let Some(pid) = pid {
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg("--")
            .arg(format!("-{pid}"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
    }
}

/// Spawn + timeout + tail-collect, shared by run_op, the apply lane, and the
/// sequencer driver. The timeout must actually STOP the mutation (P1-15):
/// tokio children survive a dropped future by default, so a timed-out
/// pull/rebase/checkout/hook would keep rewriting the repo after the UI
/// reported failure. kill_on_drop covers abandon paths (the pkgs.rs pattern);
/// on deadline we SIGKILL the process GROUP and reap. Stdin (the apply lane's
/// patch) is written INSIDE the deadline — a child that never reads its pipe
/// must time out too, not park forever.
async fn run_git(mut cmd: Command, timeout_secs: u64, stdin_data: Option<&[u8]>) -> WriteResp {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    if stdin_data.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return WriteResp {
                ok: false,
                out: format!("git failed to start: {e}"),
            }
        }
    };
    let pid = child.id(); // wait_with_output consumes the handle; keep the pgid key
    let work = async move {
        if let (Some(data), Some(mut stdin)) = (stdin_data, child.stdin.take()) {
            use tokio::io::AsyncWriteExt as _;
            let _ = stdin.write_all(data).await;
            let _ = stdin.shutdown().await;
        }
        child.wait_with_output().await
    };
    let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), work).await;
    match out {
        Err(_) => {
            // Dropping the future fired kill_on_drop (SIGKILL to the leader);
            // the GROUP (hooks, helpers) gets its own signal now.
            kill_process_group_by_pid(pid).await;
            WriteResp {
                ok: false,
                out: format!("timed out after {timeout_secs}s"),
            }
        }
        Ok(Err(e)) => WriteResp {
            ok: false,
            out: format!("git failed: {e}"),
        },
        Ok(Ok(o)) => {
            let tail: String = String::from_utf8_lossy(&o.stderr)
                .lines()
                .chain(String::from_utf8_lossy(&o.stdout).lines())
                .filter(|l| !l.trim().is_empty())
                .take(8)
                .collect::<Vec<_>>()
                .join("\n");
            WriteResp {
                ok: o.status.success(),
                out: tail,
            }
        }
    }
}

/// One git READ, collected. Same kill discipline as [`run_git`] (a wedged
/// read dies with its group), plus stdout capped DURING collection so a huge
/// diff can't allocate past the cap (audit C-33 — a full streaming byte-tail
/// ring is deliberately deferred; callers get a `truncated` flag instead).
struct ReadOut {
    ok: bool,
    stdout: Vec<u8>,
    /// The cap cut output short (the child saw SIGPIPE once we stopped reading).
    truncated: bool,
}

async fn read_capped(mut cmd: Command, cap: usize, timeout_secs: u64) -> Option<ReadOut> {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let work = async {
        let mut out = Vec::new();
        let mut truncated = false;
        {
            use tokio::io::AsyncReadExt as _;
            let stdout = child.stdout.take().expect("piped stdout");
            // cap+1: the extra byte tells "truncated" from "exactly full".
            let mut take = stdout.take(cap as u64 + 1);
            if take.read_to_end(&mut out).await.is_ok() {
                truncated = out.len() > cap;
                out.truncate(cap);
            }
        } // stdout dropped here: a still-writing git dies by SIGPIPE
        let status = child.wait().await;
        (out, truncated, status)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), work).await {
        Ok((stdout, truncated, status)) => Some(ReadOut {
            ok: status.map(|s| s.success()).unwrap_or(false),
            stdout,
            truncated,
        }),
        Err(_) => {
            kill_process_group(&mut child).await;
            None
        }
    }
}

/// Lossy-convert at most `cap` bytes, ending on a char boundary: a raw
/// `String::truncate` at a byte cap PANICS off-boundary (audit #32 — near-
/// certain for CJK/emoji diffs), and `from_utf8_lossy` alone would splice
/// U+FFFD into the middle of a cut multi-byte sequence.
fn lossy_capped(bytes: &[u8], cap: usize) -> String {
    let mut end = bytes.len().min(cap);
    // Walk back off any UTF-8 continuation bytes (10xx_xxxx) — the same rule
    // str::is_char_boundary uses (a method [u8] doesn't have).
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// `POST /git/add {path?}` — stage one file, or everything when absent.
pub async fn add(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    match &q.path {
        Some(p) if !p.is_empty() => Json(run_op(&q, &["add", "--", p], 60).await),
        _ => Json(run_op(&q, &["add", "-A"], 60).await),
    }
}

/// `POST /git/unstage {path?}` — unstage one file (or everything).
pub async fn unstage(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    match &q.path {
        Some(p) if !p.is_empty() => Json(run_op(&q, &["reset", "-q", "HEAD", "--", p], 60).await),
        _ => Json(run_op(&q, &["reset", "-q", "HEAD"], 60).await),
    }
}

/// `POST /git/commit {message}` — commit the staged set.
pub async fn commit(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(message) = q
        .message
        .clone()
        .filter(|m| !m.trim().is_empty() && m.len() <= 10_000)
    else {
        return Json(WriteResp {
            ok: false,
            out: "empty (or oversized) commit message".into(),
        });
    };
    Json(run_op(&q, &["commit", "-m", &message], 60).await)
}

/// `POST /git/amend` — fold the staged set into HEAD (--no-edit: message
/// editing stays out of scope). The panel two-click-confirms this — it
/// rewrites the tip commit.
pub async fn amend(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    Json(run_op(&q, &["commit", "--amend", "--no-edit"], 60).await)
}

/// `POST /git/submodule/update {path}` — `submodule update --init -- <path>`
/// (120s: clones can dawdle).
pub async fn submodule_update(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(p) = q.path.clone().filter(|p| !p.is_empty()) else {
        return Json(WriteResp {
            ok: false,
            out: "path required".into(),
        });
    };
    Json(run_op(&q, &["submodule", "update", "--init", "--", &p], 120).await)
}

/// `POST /git/discard {path}` — drop ALL of a file's worktree+index changes
/// back to HEAD, or delete an untracked file (clean). The panel two-clicks
/// this per row; untracked detection is a porcelain probe first.
pub async fn discard(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let root = match root_for_req(q.pane, &q.root).await {
        Ok(r) => r,
        Err(code) => return Json(root_err_resp(code)),
    };
    let Some(path) = q.path.clone().filter(|p| !p.is_empty()) else {
        return Json(WriteResp {
            ok: false,
            out: "path required".into(),
        });
    };
    if safe_path(&root, &path, false).is_none() {
        return Json(WriteResp {
            ok: false,
            out: "path outside the root".into(),
        });
    }
    // -z: the raw (unquoted) filename comes back, so an exotic name still
    // matches the `??` prefix instead of failing the probe mis-quoted.
    let mut probe = Command::new("git");
    probe
        .arg("-C")
        .arg(&root)
        .args(["status", "--porcelain", "-z", "--", &path]);
    let untracked = read_capped(probe, META_CAP, READ_TIMEOUT)
        .await
        .map(|o| o.stdout.starts_with(b"??"))
        .unwrap_or(false);
    if untracked {
        Json(run_op(&q, &["clean", "-f", "--", &path], 60).await)
    } else {
        Json(
            run_op(
                &q,
                &["restore", "--source=HEAD", "--staged", "--worktree", "--", &path],
                60,
            )
            .await,
        )
    }
}

/// `POST /git/apply {patch, reverse?}` — hunk/line-level (un)staging: the
/// panel rebuilds a reduced unified diff and we `git apply --cached` it
/// (reverse = unstaging). Stdin-fed, no shell, 120s.
pub async fn apply_patch(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let root = match root_for_req(q.pane, &q.root).await {
        Ok(r) => r,
        Err(code) => return Json(root_err_resp(code)),
    };
    let Some(patch) = q.patch.clone().filter(|p| !p.trim().is_empty() && p.len() <= 8_000_000)
    else {
        return Json(WriteResp {
            ok: false,
            out: "empty (or oversized) patch".into(),
        });
    };
    let reverse = q.reverse.unwrap_or(false);
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).arg("apply");
    cmd.arg("--cached").arg("--whitespace=nowarn");
    if reverse {
        cmd.arg("--reverse");
    }
    cmd.arg("-");
    Json(run_git(cmd, 120, Some(patch.as_bytes())).await)
}

/// `POST /git/fetch` — fetch all remotes (prune).
pub async fn fetch(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    Json(run_op(&q, &["fetch", "--all", "--prune"], 120).await)
}

/// `POST /git/pull` — pull with autostash (plain merge pull, the least
/// surprising default — interactive rebase stays out of scope).
pub async fn pull(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    Json(run_op(&q, &["pull", "--autostash"], 120).await)
}

/// `POST /git/push` — push HEAD to its upstream (git's own error explains a
/// missing upstream with the exact -u suggestion).
pub async fn push(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    Json(run_op(&q, &["push"], 120).await)
}

/// `POST /git/rebase` — rebase onto @{upstream} (the common "sync my work"
/// action). Conflicts are reported via git's output; the user resolves in
/// the terminal.
pub async fn rebase(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    Json(run_op(&q, &["rebase", "--autostash", "@{upstream}"], 120).await)
}

// ---- rev-targeted operations (the graph panel's commit context menu) ---------

/// The request's rev, run through the same charset check as the read side.
fn req_rev(q: &WriteReq) -> Option<String> {
    q.rev.clone().filter(|r| valid_rev(r))
}

fn bad_rev() -> Json<WriteResp> {
    Json(WriteResp {
        ok: false,
        out: "bad (or missing) rev".into(),
    })
}

/// `POST /git/cherry-pick {rev}` — apply one commit onto HEAD; conflicts come
/// back as git's own output.
pub async fn cherry_pick(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(rev) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["cherry-pick", &rev], 60).await)
}

/// `POST /git/revert {rev}` — revert one commit with the default message
/// (--no-edit: the panel can't host an editor).
pub async fn revert(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(rev) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["revert", "--no-edit", &rev], 60).await)
}

/// `POST /git/checkout {rev}` — switch branches (or detach at a commit);
/// dirty-tree refusals are git's own message. Long timeout: checkouts of big
/// trees with hooks can lag.
pub async fn checkout(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(rev) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["checkout", &rev], 120).await)
}

/// `POST /git/reset {rev, mode}` — reset HEAD to rev. mode ∈ soft|mixed|hard;
/// a destructive verb with no silent default — anything else is rejected.
pub async fn reset(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(rev) = req_rev(&q) else { return bad_rev() };
    let flag = match q.mode.as_deref() {
        Some("soft") => "--soft",
        Some("mixed") => "--mixed",
        Some("hard") => "--hard",
        _ => {
            return Json(WriteResp {
                ok: false,
                out: "mode must be soft|mixed|hard".into(),
            })
        }
    };
    Json(run_op(&q, &["reset", flag, &rev], 60).await)
}

/// The optional `at` field (create-here targets) through the same check.
fn req_at(q: &WriteReq) -> Option<String> {
    q.at.clone().filter(|r| valid_rev(r))
}

/// `POST /git/branch {rev: name, at?}` — create a branch (at HEAD or the
/// right-clicked commit). Invalid names are git's own error message.
pub async fn branch(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(name) = req_rev(&q) else { return bad_rev() };
    match req_at(&q) {
        Some(at) => Json(run_op(&q, &["branch", &name, &at], 60).await),
        None => Json(run_op(&q, &["branch", &name], 60).await),
    }
}

/// `POST /git/branch/delete {rev: name}` — safe delete (-d): git refuses an
/// unmerged branch and its message says why.
pub async fn branch_delete(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(name) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["branch", "-d", &name], 60).await)
}

/// `POST /git/tag {rev: name, at?}` — create a lightweight tag.
pub async fn tag(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(name) = req_rev(&q) else { return bad_rev() };
    match req_at(&q) {
        Some(at) => Json(run_op(&q, &["tag", &name, &at], 60).await),
        None => Json(run_op(&q, &["tag", &name], 60).await),
    }
}

/// `POST /git/tag/delete {rev: name}` — delete a tag.
pub async fn tag_delete(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(name) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["tag", "-d", &name], 60).await)
}

/// `POST /git/merge {rev}` — merge into HEAD (120s: big trees + hooks). A
/// conflict surfaces through the graph panel's own banner (batch A).
pub async fn merge(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(rev) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["merge", &rev], 120).await)
}

// ---- stash (the graph panel's stash section) ---------------------------------

#[derive(Serialize)]
pub struct StashEntry {
    #[allow(dead_code)] // kept for a future "show stash commit" deep-link
    hash: String,
    /// The selector apply/pop/drop take ("stash@{0}").
    sel: String,
    /// %gs — "WIP on master: abc1234 subject" or the user's -m text.
    msg: String,
}

/// `GET /git/stash/list?pane=&root=` — the stash stack, top first (capped).
pub async fn stash_list(Query(q): Query<StatusQuery>) -> Result<Json<Vec<StashEntry>>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["stash", "list", "--format=%H%x1f%gd%x1f%gs"]);
    let Some(out) = read_capped(cmd, META_CAP, READ_TIMEOUT).await else {
        return Ok(Json(vec![]));
    };
    if !out.ok {
        return Ok(Json(vec![]));
    }
    let entries = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() < 3 {
                return None;
            }
            Some(StashEntry {
                hash: f[0].to_string(),
                sel: f[1].to_string(),
                msg: f[2..].join("\x1f"),
            })
        })
        .take(50)
        .collect();
    Ok(Json(entries))
}

/// `POST /git/stash {message?}` — stash the tracked working tree (untracked
/// files stay put, git's default); auto message unless one is given.
pub async fn stash_push(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    match &q.message {
        Some(m) if !m.trim().is_empty() && m.len() <= 10_000 => {
            Json(run_op(&q, &["stash", "push", "-m", m], 60).await)
        }
        _ => Json(run_op(&q, &["stash", "push"], 60).await),
    }
}

/// `POST /git/stash/pop {rev=stash@{n}}` — apply and drop; conflicts come
/// back as git's own output (the entry is kept on conflict).
pub async fn stash_pop(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(sel) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["stash", "pop", &sel], 60).await)
}

/// `POST /git/stash/apply {rev=stash@{n}}` — apply, keep the entry.
pub async fn stash_apply(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(sel) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["stash", "apply", &sel], 60).await)
}

/// `POST /git/stash/drop {rev=stash@{n}}` — delete the entry (the panel
/// two-click-confirms this one before calling).
pub async fn stash_drop(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let Some(sel) = req_rev(&q) else { return bad_rev() };
    Json(run_op(&q, &["stash", "drop", &sel], 60).await)
}

// ---- merge state (the conflict banner + continue/abort) ----------------------

const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/// Resolve a git dir entry (rebase-merge …) to an absolute path via
/// --git-path; None when git itself fails.
async fn git_path_abs(root: &std::path::Path, name: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(["rev-parse", "--path-format=absolute", "--git-path", name]);
    read_capped(cmd, META_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// The in-progress sequencer, if any. Rebase first — its dirs coexist with
/// nothing else; the *_HEAD probes come after.
async fn op_state(root: &std::path::Path) -> Option<&'static str> {
    for name in ["rebase-merge", "rebase-apply"] {
        if let Some(p) = git_path_abs(root, name).await {
            if std::path::Path::new(&p).is_dir() {
                return Some("rebase");
            }
        }
    }
    for (head, label) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        let mut cmd = Command::new("git");
        cmd.arg("-C")
            .arg(root)
            .args(["rev-parse", "-q", "--verify", head]);
        let ok = read_capped(cmd, META_CAP, READ_TIMEOUT)
            .await
            .map(|o| o.ok)
            .unwrap_or(false);
        if ok {
            return Some(label);
        }
    }
    None
}

/// `GET /git/state?pane=&root=` — sequencer state + conflicted paths for the
/// graph panel's conflict banner.
pub async fn state(Query(q): Query<StatusQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await?;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).args(["status", "--porcelain=v1", "-z"]);
    let conflicts: Vec<String> = read_capped(cmd, LIST_CAP, READ_TIMEOUT)
        .await
        .filter(|o| o.ok)
        .map(|o| {
            parse_status_z(&o.stdout)
                .into_iter()
                .filter(|f| CONFLICT_CODES.contains(&f.status.as_str()))
                .map(|f| f.path)
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(serde_json::json!({
        "state": op_state(&root).await,
        "conflicts": conflicts,
    })))
}

/// `POST /git/op {action: "continue"|"abort"}` — drive the in-progress
/// sequencer (rebase/merge/cherry-pick/revert, whichever actually exists).
/// Continue runs with GIT_EDITOR=true so git never blocks on an editor.
pub async fn sequencer_op(Json(q): Json<WriteReq>) -> Json<WriteResp> {
    let root = match root_for_req(q.pane, &q.root).await {
        Ok(r) => r,
        Err(code) => return Json(root_err_resp(code)),
    };
    let verb = q.action.as_deref().unwrap_or("");
    if verb != "continue" && verb != "abort" {
        return Json(WriteResp {
            ok: false,
            out: "action must be continue|abort".into(),
        });
    }
    let Some(state) = op_state(&root).await else {
        return Json(WriteResp {
            ok: false,
            out: "nothing in progress".into(),
        });
    };
    let sub = match state {
        "rebase" => "rebase",
        "merge" => "merge",
        "cherry-pick" => "cherry-pick",
        _ => "revert",
    };
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .arg(sub)
        .arg(format!("--{verb}"))
        .env("GIT_EDITOR", "true");
    Json(run_git(cmd, 120, None).await)
}

// ---- blame (the code panel's gutter) -------------------------------------------

#[derive(Deserialize)]
pub struct BlameQuery {
    #[serde(default)]
    path: String,
    pane: Option<u32>,
    root: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct BlameGroup {
    /// 1-based first covered line.
    line: u32,
    count: u32,
    hash: String,
    author: String,
    /// author-time epoch seconds.
    time: u64,
    summary: String,
}

/// Parse `--line-porcelain` rows: every blamed line comes as a header
/// (`sha orig final`), full metadata, then one TAB-prefixed content line.
/// Consecutive lines from the same commit merge into one group.
fn parse_blame(text: &str) -> Vec<BlameGroup> {
    let mut groups: Vec<BlameGroup> = Vec::new();
    let mut final_no = 0u32;
    let mut hash = String::new();
    let mut author = String::new();
    let mut time = 0u64;
    let mut summary = String::new();
    for l in text.lines() {
        if l.starts_with('\t') {
            // Content line: emit under the current header's metadata.
            if let Some(g) = groups.last_mut() {
                if g.hash == hash && g.line + g.count == final_no {
                    g.count += 1;
                    continue;
                }
            }
            groups.push(BlameGroup {
                line: final_no,
                count: 1,
                hash: hash.clone(),
                author: author.clone(),
                time,
                summary: summary.clone(),
            });
            continue;
        }
        let mut it = l.split_whitespace();
        if let (Some(sha), Some(_orig), Some(fin)) = (it.next(), it.next(), it.next()) {
            if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                if let Ok(n) = fin.parse::<u32>() {
                    hash = sha.to_string();
                    final_no = n;
                    author.clear();
                    time = 0;
                    summary.clear();
                    continue;
                }
            }
        }
        if let Some(a) = l.strip_prefix("author ") {
            author = a.to_string();
        } else if let Some(t) = l.strip_prefix("author-time ") {
            time = t.trim().parse().unwrap_or(0);
        } else if let Some(s) = l.strip_prefix("summary ") {
            summary = s.to_string();
        }
    }
    groups
}

/// `GET /git/blame?pane=&root=&path=` — per-line author groups for the code
/// panel's blame gutter. 404 when the file is untracked (or outside a repo).
pub async fn blame(Query(q): Query<BlameQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    if q.path.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = root_for_req(q.pane, &q.root).await?;
    safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["blame", "--line-porcelain", "--", &q.path]);
    let Some(out) = read_capped(cmd, BLOB_CAP, READ_TIMEOUT).await else {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    };
    if !out.ok {
        return Err(StatusCode::NOT_FOUND);
    }
    if out.truncated {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(Json(serde_json::json!({
        "groups": parse_blame(&String::from_utf8_lossy(&out.stdout)),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_rows_parse() {
        let text = "a1b2c3\x1fd4e5f6 a7b8c9\x1fXue Haonan\x1f2026-07-16T02:04:00+08:00\x1ffeat: graph endpoints\x1fHEAD -> main, origin/main\n\
                    d4e5f6\x1f\x1fXue Haonan\x1f2026-07-15T01:00:00+08:00\x1ffix: root commit, no refs\x1f\n";
        let rows = parse_log(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].hash, "a1b2c3");
        assert_eq!(rows[0].parents, vec!["d4e5f6", "a7b8c9"]); // merge: two parents
        assert_eq!(rows[0].refs, "HEAD -> main, origin/main");
        assert_eq!(rows[1].parents.len(), 0); // root commit
        assert_eq!(rows[1].refs, "");
    }

    #[test]
    fn name_status_rows_parse() {
        // -z fixtures (fields NUL-terminated, names RAW): M/A/D, a rename
        // (old then new), and the audit C-32 gallery — Chinese, newline, tab,
        // quote — which human porcelain would have C-quoted into literals.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"M\0ui/src/main.ts\0");
        bytes.extend_from_slice(b"A\0ui/ux/gitcheck.mjs\0");
        bytes.extend_from_slice(b"D\0docs/old.md\0");
        bytes.extend_from_slice(b"R100\0old/name.ts\0new/name.ts\0");
        bytes.extend_from_slice("M\0sub/中文 文件.txt\0".as_bytes());
        bytes.extend_from_slice(b"A\0new\nline.txt\0");
        bytes.extend_from_slice(b"M\0tab\tname.txt\0");
        bytes.extend_from_slice(b"M\0quote\"name.txt\0");
        let files = parse_name_status_z(&bytes);
        assert_eq!(files.len(), 8);
        assert_eq!(files[0], ShowFile { status: "M".into(), path: "ui/src/main.ts".into() });
        assert_eq!(files[1].status, "A");
        assert_eq!(files[2].status, "D");
        assert_eq!(files[3], ShowFile { status: "R".into(), path: "new/name.ts".into() });
        assert_eq!(files[4].path, "sub/中文 文件.txt");
        assert_eq!(files[5].path, "new\nline.txt");
        assert_eq!(files[6].path, "tab\tname.txt");
        assert_eq!(files[7].path, "quote\"name.txt");
    }

    #[test]
    fn status_z_rows_parse() {
        // -z porcelain: `XY <path>\0`, renames `XY <new>\0<old>\0` (NEW first
        // — git reverses the human order under -z).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b" M src/touched.rs\0");
        bytes.extend_from_slice(b"A  src/added.rs\0");
        bytes.extend_from_slice(b"RM sub/renamed file.txt\0ordinary.txt\0");
        bytes.extend_from_slice("?? 未跟踪 文件.txt\0".as_bytes());
        bytes.extend_from_slice(b"?? new\nline.txt\0");
        bytes.extend_from_slice(b"UU tab\tand \"quote\".rs\0");
        bytes.extend_from_slice(b"!! node_modules/\0");
        let files = parse_status_z(&bytes);
        assert_eq!(files.len(), 7);
        assert_eq!(files[0].status, " M");
        assert_eq!(files[0].path, "src/touched.rs");
        assert_eq!(files[1].status, "A ");
        assert_eq!(files[2].status, "RM");
        assert_eq!(files[2].path, "sub/renamed file.txt", "rename keeps the NEW path");
        assert_eq!(files[3].status, "??");
        assert_eq!(files[3].path, "未跟踪 文件.txt");
        assert_eq!(files[4].path, "new\nline.txt");
        assert_eq!(files[5].status, "UU");
        assert_eq!(files[5].path, "tab\tand \"quote\".rs");
        assert_eq!(files[6].status, "!!");
    }

    #[test]
    fn lossy_capped_ends_on_a_char_boundary() {
        // "中" is 3 bytes: a byte cap landing inside it must walk back, never
        // panic (String::truncate would) and never splice U+FFFD mid-sequence.
        let text = "aaaaaaaaa中rest"; // 9 ascii + 中(3) + 4 ascii
        let bytes = text.as_bytes();
        assert_eq!(lossy_capped(bytes, 9), "aaaaaaaaa");
        assert_eq!(lossy_capped(bytes, 10), "aaaaaaaaa");
        assert_eq!(lossy_capped(bytes, 11), "aaaaaaaaa");
        assert_eq!(lossy_capped(bytes, 12), "aaaaaaaaa中");
        assert_eq!(lossy_capped(bytes, 1000), text, "cap beyond len keeps everything");
        // Same for a 4-byte emoji.
        let emoji = "ab🎉cd".as_bytes(); // 🎉 = 4 bytes at index 2..6
        assert_eq!(lossy_capped(emoji, 4), "ab");
        assert_eq!(lossy_capped(emoji, 6), "ab🎉");
        assert_eq!(lossy_capped(b"", 10), "");
    }

    #[test]
    fn rev_validation() {
        assert!(valid_rev("HEAD"));
        assert!(valid_rev("a1b2c3d4"));
        assert!(valid_rev("origin/main~2"));
        assert!(valid_rev("v1.0^{}"));
        assert!(!valid_rev("--help"));
        assert!(!valid_rev(""));
        assert!(!valid_rev("-n 1"));
    }

    #[test]
    fn blame_rows_parse() {
        // Two commits, three lines; the second commit's lines are contiguous
        // and must merge into one group. --line-porcelain repeats full
        // metadata per line.
        let h1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let h2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let text = format!(
            "{h1} 1 1\nauthor A One\nauthor-time 1700000000\nsummary init\n\tline one\n\
             {h2} 1 2\nauthor B Two\nauthor-time 1700000100\nsummary feat x\n\tline two\n\
             {h2} 2 3\nauthor B Two\nauthor-time 1700000100\nsummary feat x\n\tline three\n"
        );
        let groups = parse_blame(&text);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].line, 1);
        assert_eq!(groups[0].count, 1);
        assert_eq!(groups[0].author, "A One");
        assert_eq!(groups[1].line, 2);
        assert_eq!(groups[1].count, 2);
        assert_eq!(groups[1].summary, "feat x");
        assert_eq!(groups[1].time, 1700000100);
    }

    /// /proc liveness with a small grace window: a SIGKILLed group member is
    /// reaped by init, which is prompt but not synchronous.
    #[cfg(unix)]
    fn proc_gone_soon(pid: u32) -> bool {
        for _ in 0..50 {
            if std::fs::metadata(format!("/proc/{pid}")).is_err() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        false
    }

    /// P1-15: a timed-out mutation must DIE — the process AND the children it
    /// spawned (a hook's helpers share its process group), not linger and keep
    /// mutating after the UI heard "failed".
    #[cfg(unix)]
    #[tokio::test]
    async fn run_git_timeout_kills_the_whole_process_group() {
        let dir = std::env::temp_dir().join(format!("mymux-git-kill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let leader = dir.join("leader.pid");
        let kid = dir.join("child.pid");
        // A blocking "git": records its own pid, spawns a child that would
        // outlive a leader-only kill, then blocks forever.
        let script = format!(
            "echo $$ > '{}'; sleep 300 & echo $! > '{}'; sleep 300",
            leader.display(),
            kid.display()
        );
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(&script);
        let resp = run_git(cmd, 1, None).await;
        assert!(!resp.ok, "a blocking git must fail: {}", resp.out);
        assert!(resp.out.contains("timed out"), "{:?}", resp.out);
        let leader_pid: u32 = std::fs::read_to_string(&leader).unwrap().trim().parse().unwrap();
        let kid_pid: u32 = std::fs::read_to_string(&kid).unwrap().trim().parse().unwrap();
        assert!(proc_gone_soon(leader_pid), "leader {leader_pid} survived the timeout");
        assert!(proc_gone_soon(kid_pid), "spawned child {kid_pid} was orphaned, not group-killed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P1-15 (stdin lane): the patch write is INSIDE the deadline — a child
    /// that never reads its stdin pipe must still time out (and die).
    #[cfg(unix)]
    #[tokio::test]
    async fn run_git_stdin_write_is_inside_the_timeout() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("sleep 300");
        let patch = vec![b'x'; 4 * 1024 * 1024]; // far beyond the 64 KiB pipe buffer
        let started = std::time::Instant::now();
        let resp = run_git(cmd, 1, Some(&patch)).await;
        assert!(!resp.ok);
        assert!(resp.out.contains("timed out"), "{:?}", resp.out);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the blocked stdin write escaped the deadline"
        );
    }
}
