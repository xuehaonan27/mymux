//! Git endpoints for the code panel: the list of changed files and a per-file
//! unified diff. All git commands run inside the confined root ([`crate::fs`]).

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::fs::{root, safe_path};

#[derive(Serialize)]
pub struct GitFile {
    /// Two-char porcelain status, e.g. " M", "A ", "??", "R ".
    status: String,
    path: String,
}

/// `GET /git/status` — working-tree + staged changes (empty if not a repo).
pub async fn status() -> Json<Vec<GitFile>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root())
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

#[derive(Deserialize)]
pub struct DiffQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
}

/// `GET /git/diff?path=<rel>&staged=<bool>` — unified diff. New/untracked files
/// are shown as all-added.
pub async fn diff(Query(q): Query<DiffQuery>) -> Result<String, StatusCode> {
    let abs = if q.path.is_empty() {
        None
    } else {
        Some(safe_path(&q.path, false).ok_or(StatusCode::FORBIDDEN)?)
    };
    let root = root();

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

    // Untracked / brand-new file: `git diff` shows nothing, so diff it against
    // /dev/null to render the whole thing as added.
    if diff.trim().is_empty() {
        if let Some(abs) = abs {
            if let Ok(out) = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null"])
                .arg(&abs)
                .output()
                .await
            {
                diff = String::from_utf8_lossy(&out.stdout).into_owned();
            }
        }
    }
    Ok(diff)
}
