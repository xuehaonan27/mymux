//! Git endpoints for the code panel: changed-file list and per-file unified
//! diff, run inside the focused pane's directory (or the default root).

use axum::extract::Query;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::fs::{root_for, safe_path};

#[derive(Serialize)]
pub struct GitFile {
    /// Two-char porcelain status, e.g. " M", "A ", "??", "R ".
    status: String,
    path: String,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pane: Option<u32>,
}

/// `GET /git/status?pane=<id>` — working-tree + staged changes.
pub async fn status(Query(q): Query<StatusQuery>) -> Json<Vec<GitFile>> {
    let root = root_for(q.pane).await;
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

#[derive(Deserialize)]
pub struct DiffQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    staged: bool,
    pane: Option<u32>,
}

/// `GET /git/diff?pane=<id>&path=<rel>&staged=<bool>` — unified diff. New /
/// untracked files are shown as all-added.
pub async fn diff(Query(q): Query<DiffQuery>) -> Result<String, StatusCode> {
    let root = root_for(q.pane).await;
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
