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
