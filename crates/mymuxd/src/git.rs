//! Git endpoints for the code panel: changed-file list and per-file unified
//! diff, run inside the focused pane's directory (or the default root).

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::fs::{root_for_req, safe_path};

#[derive(Serialize)]
pub struct GitFile {
    /// Two-char porcelain status, e.g. " M", "A ", "??", "R ".
    status: String,
    path: String,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pane: Option<u32>,
    /// Optional absolute root override (the panel's root switcher).
    root: Option<String>,
}

/// `GET /git/status?pane=<id>` — working-tree + staged changes.
pub async fn status(Query(q): Query<StatusQuery>) -> Json<Vec<GitFile>> {
    let root = root_for_req(q.pane, &q.root).await;
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["status", "--porcelain=v1"])
        .output()
        .await;
    let Ok(out) = out else { return Json(vec![]) };
    if !out.status.success() {
        return Json(vec![]);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let files = text
        .lines()
        .filter_map(|l| {
            if l.len() < 4 {
                return None;
            }
            Some(GitFile {
                status: l[..2].to_string(),
                path: l[3..].trim().to_string(),
            })
        })
        .collect();
    Json(files)
}

/// `GET /git/files?pane=<id>` — tracked + untracked (non-ignored) files, for
/// the code panel's quick-open. Empty outside a repo; capped.
pub async fn files(Query(q): Query<StatusQuery>) -> Json<Vec<String>> {
    const CAP: usize = 20_000;
    let root = root_for_req(q.pane, &q.root).await;
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await;
    let Ok(out) = out else { return Json(vec![]) };
    if !out.status.success() {
        return Json(vec![]);
    }
    let files = out
        .stdout
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .take(CAP)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    Json(files)
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
/// untracked files are shown as all-added.
pub async fn diff(Query(q): Query<DiffQuery>) -> Result<String, StatusCode> {
    let root = root_for_req(q.pane, &q.root).await;
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
    let out = cmd
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut diff = String::from_utf8_lossy(&out.stdout).into_owned();

    if diff.trim().is_empty() && !q.staged && abs.is_some() {
        // The all-added fallback is for UNTRACKED files only — an empty
        // tracked diff (nothing unstaged, or nothing staged) is just empty.
        let untracked = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain", "--", &q.path])
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).starts_with("??"))
            .unwrap_or(false);
        if untracked {
            // Untracked file: fake an all-added diff. Pass the RELATIVE path
            // (validated above) so the header doesn't leak the absolute one.
            if let Ok(out) = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &q.path])
                .output()
                .await
            {
                diff = String::from_utf8_lossy(&out.stdout).into_owned();
            }
        }
    }
    Ok(diff)
}

/// `GET /git/toplevel?pane=<id>&root=` — the repo root for the panel's root
/// switcher (null when the effective root isn't inside a work tree).
pub async fn toplevel(Query(q): Query<StatusQuery>) -> Json<serde_json::Value> {
    let root = root_for_req(q.pane, &q.root).await;
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .await;
    let top = out
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    Json(serde_json::json!({ "toplevel": top }))
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
    let root = root_for_req(q.pane, &q.root).await;
    safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
    let spec = if q.staged {
        format!(":{}", q.path)
    } else {
        format!("HEAD:{}", q.path)
    };
    let out = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", "--no-color", "--no-textconv", &spec])
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !out.status.success() {
        return Err(StatusCode::NOT_FOUND);
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
}

/// `GET /git/log?pane=&root=&limit=&skip=&all=` — commit topology for the
/// graph (HEAD + every ref by default), plus the current branch and its
/// upstream ahead/behind for the push/pull affordances.
pub async fn log(Query(q): Query<LogQuery>) -> Json<serde_json::Value> {
    let root = root_for_req(q.pane, &q.root).await;
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let skip = q.skip.unwrap_or(0);
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&root).arg("log");
    if q.all.unwrap_or(true) {
        cmd.arg("--all");
    }
    cmd.args([
        "--date-order",
        "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D",
        "-n",
        &limit.to_string(),
        "--skip",
        &skip.to_string(),
    ]);
    let commits = cmd
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_log(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    let branch = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["branch", "--show-current"])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // HEAD...@{upstream}: "ahead<TAB>behind" — fails when there's no upstream
    // (detached, never pushed) — both counts stay null then.
    let (upstream, ahead, behind) = {
        let name = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        let counts = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
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

    Json(serde_json::json!({
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "commits": commits,
    }))
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

/// Name-status rows of `git show --name-status --format=`: "M\tpath",
/// "R100\told\tnew" (take the new path on renames/copies).
fn parse_name_status(text: &str) -> Vec<ShowFile> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let st = parts.next()?;
            let p = parts.next()?;
            if st.is_empty() || p.is_empty() {
                return None;
            }
            Some(ShowFile {
                status: st.chars().next().unwrap_or('M').to_string(),
                path: parts.next().unwrap_or(p).to_string(),
            })
        })
        .collect()
}

/// `GET /git/show?pane=&root=&rev=` — one commit's meta, its name-status file
/// list, and the unified diff (capped at ~4 MiB) for the detail pane.
pub async fn show(Query(q): Query<ShowQuery>) -> Result<Json<serde_json::Value>, StatusCode> {
    if !valid_rev(&q.rev) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = root_for_req(q.pane, &q.root).await;

    // Meta and name-status are separate spawns on purpose: an empty --or
    // arbitrary—commit body makes a one-shot format unparseable.
    let meta = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", "-s", "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b", &q.rev])
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !meta.status.success() {
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

    let files = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", "--name-status", "--format=", &q.rev])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_name_status(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();

    const DIFF_CAP: usize = 4_000_000;
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&root)
        .args(["show", "--format=", "--no-color", &q.rev]);
    if !q.path.is_empty() {
        safe_path(&root, &q.path, false).ok_or(StatusCode::FORBIDDEN)?;
        cmd.arg("--").arg(&q.path);
    }
    let diff_out = cmd
        .output()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut diff = String::from_utf8_lossy(&diff_out.stdout).into_owned();
    if diff.len() > DIFF_CAP {
        diff.truncate(DIFF_CAP);
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

// ---- write operations (the graph panel's action buttons) ---------------------

#[derive(Deserialize, Clone)]
pub struct WriteReq {
    /// Only for add/unstage: the file to (un)stage. Absent/empty = everything.
    path: Option<String>,
    /// Only for commit: the message (argv-passed, no shell anywhere).
    message: Option<String>,
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
    let root = root_for_req(q.pane, &q.root).await;
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
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        cmd.output(),
    )
    .await;
    match out {
        Err(_) => WriteResp {
            ok: false,
            out: format!("timed out after {timeout_secs}s"),
        },
        Ok(Err(e)) => WriteResp {
            ok: false,
            out: format!("git failed to start: {e}"),
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
        let text = "M\tui/src/main.ts\nA\tui/ux/gitcheck.mjs\nD\tdocs/old.md\nR100\told/name.ts\tnew/name.ts\n";
        let files = parse_name_status(text);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0], ShowFile { status: "M".into(), path: "ui/src/main.ts".into() });
        assert_eq!(files[1].status, "A");
        assert_eq!(files[2].status, "D");
        assert_eq!(files[3].path, "new/name.ts");
        assert_eq!(files[3].status, "R");
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
}
