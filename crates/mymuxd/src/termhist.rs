//! `GET /termhistory` — paged reads of a native pane's raw output log (the
//! ptyd-written history files in $XDG_STATE_HOME/mymux/history). The UI's
//! scroll-top pager is built on this; tmux panes have no ptyd log (404).
//!
//! Naming mirrors ptyd's HistLog: `<id & 0x3fffffff>-<pid>.log`, with one
//! rotated sibling `.1` — logically the history is `rotated ++ current`
//! and offsets index across that concatenation.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use mymux_ptyd::proto::history_dir;

use crate::tmux::Hub;

#[derive(Deserialize)]
pub struct HistQuery {
    pane: Option<u32>,
    /// Logical start byte; absent = the tail page.
    offset: Option<u64>,
    /// Bytes to return (default 96 KiB, capped at 256 KiB).
    limit: Option<u64>,
}

/// Native panes (ptyd-hosted) carry the engine bits; tmux panes are plain
/// small ids — only natives have a ptyd history log.
fn is_native(pane: u32) -> bool {
    pane & 0xC000_0000 != 0
}

/// Read `[offset, offset+len)` across (rotated, current) — the rotated file
/// always comes first in the logical view. Returns (bytes, logical_total).
async fn read_span(cur: &std::path::Path, offset: u64, len: u64) -> (Vec<u8>, u64) {
    let rotated = cur.with_extension("log.1");
    let mut parts: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut total = 0u64;
    for p in [rotated, cur.to_path_buf()] {
        if let Ok(meta) = tokio::fs::metadata(&p).await {
            if meta.is_file() && meta.len() > 0 {
                parts.push((p, meta.len()));
                total += meta.len();
            }
        }
    }
    let mut out = Vec::new();
    let mut pos = 0u64;
    for (p, plen) in parts {
        if out.len() as u64 >= len || pos >= offset + len {
            break;
        }
        if pos + plen <= offset {
            pos += plen;
            continue;
        }
        let start = offset.saturating_sub(pos);
        let want = (len - out.len() as u64).min(plen - start);
        let mut f = match tokio::fs::File::open(&p).await {
            Ok(f) => f,
            Err(_) => break,
        };
        if f
            .seek(std::io::SeekFrom::Start(start))
            .await
            .is_err()
        {
            break;
        }
        let mut buf = vec![0u8; want as usize];
        match f.read_exact(&mut buf).await {
            Ok(_) => out.extend_from_slice(&buf),
            Err(_) => {
                // Short read near EOF: take whatever fill_buf gives.
                let n = f.read(&mut buf).await.unwrap_or(0);
                out.extend_from_slice(&buf[..n]);
            }
        }
        pos += plen;
    }
    (out, total)
}

/// `GET /termhistory?pane=&offset=&limit=` — `{total, offset, text}`. The
/// text is the raw ANSI log slice (the client strips escapes for display).
pub async fn history(
    State(hub): State<Arc<Hub>>,
    Query(q): Query<HistQuery>,
) -> Result<axum::Json<serde_json::Value>, StatusCode> {
    let pane = q.pane.filter(|p| is_native(*p)).ok_or(StatusCode::NOT_FOUND)?;
    let pid = hub
        .pane_pids()
        .await
        .into_iter()
        .find_map(|(_w, p, pid, _n, _e)| (p == pane).then_some(pid))
        .ok_or(StatusCode::NOT_FOUND)?;
    let dir = history_dir().ok_or(StatusCode::NOT_FOUND)?;
    let path = dir.join(format!("{}-{pid}.log", pane & 0x3fff_ffff));
    let limit = q.limit.unwrap_or(96_000).clamp(1, 256_000);
    // Measure first, then clamp; `offset` is the window's END (absent = the
    // tail page), the returned window is [end-limit, end).
    let (_, total) = read_span(&path, 0, 0).await;
    if total == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    let end = q.offset.map(|o| o.min(total)).unwrap_or(total);
    let offset = end.saturating_sub(limit.min(end));
    let (bytes, _) = read_span(&path, offset, limit).await;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(axum::Json(serde_json::json!({
        "total": total,
        "offset": offset,
        "text": text,
    })))
}
