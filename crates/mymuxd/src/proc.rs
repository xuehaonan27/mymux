//! Process-tree endpoints for the mini-htop panel.
//!
//! `GET /proc/tree` returns, grouped by window → pane, the process subtree rooted
//! at each pane's shell pid (read straight from `/proc`, std-only). `POST
//! /proc/kill` signals a pid **only** if it's inside one of those subtrees — a
//! captured, scoped kill, never by name (see the project rule against broad kills).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::tmux::Hub;

/// USER_HZ — jiffies per second. 100 on Linux essentially everywhere; only
/// affects the client's %CPU scaling.
const CLK_TCK: u64 = 100;
/// Linux page size (for RSS pages → KiB). 4 KiB on the platforms we target.
const PAGE_KB: u64 = 4;

struct ProcInfo {
    ppid: u32,
    comm: String,
    state: char,
    cpu_jiffies: u64,
    rss_kb: u64,
}

/// Parse one `/proc/<pid>/stat`. The `comm` field is parenthesized and may itself
/// contain spaces/parens, so we split on the *last* `)` and index the fixed
/// fields after it (0-based here = 1-based field minus 3).
fn read_stat(pid: u32) -> Option<ProcInfo> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let comm = s.get(open + 1..close)?.to_string();
    let f: Vec<&str> = s.get(close + 1..)?.split_whitespace().collect();
    // f[0]=state f[1]=ppid f[11]=utime f[12]=stime f[21]=rss(pages)
    let state = f.first().and_then(|x| x.chars().next()).unwrap_or('?');
    let ppid = f.get(1)?.parse::<u32>().ok()?;
    let utime = f.get(11)?.parse::<u64>().ok()?;
    let stime = f.get(12)?.parse::<u64>().ok()?;
    let rss_pages = f.get(21)?.parse::<i64>().ok()?.max(0) as u64;
    Some(ProcInfo {
        ppid,
        comm,
        state,
        cpu_jiffies: utime + stime,
        rss_kb: rss_pages * PAGE_KB,
    })
}

/// The full argv of a process (NUL-separated in `/proc/<pid>/cmdline`), or `None`
/// for kernel threads / no cmdline (caller falls back to `[comm]`).
fn read_cmdline(pid: u32) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    if raw.is_empty() {
        return None;
    }
    let s = raw
        .split(|&b| b == 0)
        .filter(|p| !p.is_empty())
        .map(String::from_utf8_lossy)
        .collect::<Vec<_>>()
        .join(" ");
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// One pass over `/proc`: pid → info, and ppid → children.
fn scan_procs() -> (BTreeMap<u32, ProcInfo>, BTreeMap<u32, Vec<u32>>) {
    let mut info = BTreeMap::new();
    let mut kids: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let Ok(rd) = std::fs::read_dir("/proc") else {
        return (info, kids);
    };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if let Some(pi) = read_stat(pid) {
            kids.entry(pi.ppid).or_default().push(pid);
            info.insert(pid, pi);
        }
    }
    (info, kids)
}

#[derive(Serialize)]
struct ProcNode {
    pid: u32,
    ppid: u32,
    depth: u32,
    comm: String,
    cmd: String,
    state: String,
    rss_kb: u64,
    cpu_jiffies: u64,
}

/// DFS a process subtree into a flat, depth-tagged list (for indented rendering).
/// `seen` guards against revisiting (and, defensively, any pid cycle).
fn subtree(
    pid: u32,
    info: &BTreeMap<u32, ProcInfo>,
    kids: &BTreeMap<u32, Vec<u32>>,
    seen: &mut BTreeSet<u32>,
    out: &mut Vec<ProcNode>,
    depth: u32,
) {
    if !seen.insert(pid) {
        return;
    }
    let Some(pi) = info.get(&pid) else { return };
    out.push(ProcNode {
        pid,
        ppid: pi.ppid,
        depth,
        comm: pi.comm.clone(),
        cmd: read_cmdline(pid).unwrap_or_else(|| format!("[{}]", pi.comm)),
        state: pi.state.to_string(),
        rss_kb: pi.rss_kb,
        cpu_jiffies: pi.cpu_jiffies,
    });
    if let Some(cs) = kids.get(&pid) {
        for &c in cs {
            subtree(c, info, kids, seen, out, depth + 1);
        }
    }
}

/// Every pid inside any pane's subtree — the set a kill is allowed to touch.
fn allowed_pids(panes: &[(u32, u32, u32, String)], kids: &BTreeMap<u32, Vec<u32>>) -> BTreeSet<u32> {
    fn collect(root: u32, kids: &BTreeMap<u32, Vec<u32>>, out: &mut BTreeSet<u32>) {
        if !out.insert(root) {
            return;
        }
        if let Some(cs) = kids.get(&root) {
            for &c in cs {
                collect(c, kids, out);
            }
        }
    }
    let mut out = BTreeSet::new();
    for &(_, _, shell_pid, _) in panes {
        collect(shell_pid, kids, &mut out);
    }
    out
}

#[derive(Serialize)]
struct PaneProcs {
    pane: u32,
    pid: u32,
    procs: Vec<ProcNode>,
}

#[derive(Serialize)]
struct WinProcs {
    id: u32,
    name: String,
    panes: Vec<PaneProcs>,
}

#[derive(Serialize)]
pub struct ProcTree {
    clk_tck: u64,
    windows: Vec<WinProcs>,
}

/// `GET /proc/tree` — window → pane → process subtree. The client polls this and
/// derives %CPU from `cpu_jiffies` deltas.
pub async fn tree(State(hub): State<Arc<Hub>>) -> Json<ProcTree> {
    let panes = hub.pane_pids().await;
    let (info, kids) = scan_procs();

    // Group panes under their window, in window-id order.
    let mut wins: BTreeMap<u32, WinProcs> = BTreeMap::new();
    for (win, pane, pid, name) in panes {
        let mut procs = Vec::new();
        let mut seen = BTreeSet::new();
        subtree(pid, &info, &kids, &mut seen, &mut procs, 0);
        wins.entry(win)
            .or_insert_with(|| WinProcs {
                id: win,
                name,
                panes: Vec::new(),
            })
            .panes
            .push(PaneProcs { pane, pid, procs });
    }

    Json(ProcTree {
        clk_tck: CLK_TCK,
        windows: wins.into_values().collect(),
    })
}

#[derive(Deserialize)]
pub struct KillReq {
    pid: u32,
    /// "TERM" (default) or "KILL".
    #[serde(default)]
    signal: Option<String>,
}

/// `POST /proc/kill` `{pid, signal?}` — signal a pid, but only if it is inside a
/// current pane's process subtree (rebuilt fresh here, so acting on a slightly
/// stale UI is safe: a reused pid outside the tree is refused). Never by name.
pub async fn kill(State(hub): State<Arc<Hub>>, Json(req): Json<KillReq>) -> StatusCode {
    let panes = hub.pane_pids().await;
    let (_, kids) = scan_procs();
    if !allowed_pids(&panes, &kids).contains(&req.pid) {
        return StatusCode::FORBIDDEN;
    }
    let sig = match req.signal.as_deref() {
        Some("KILL") | Some("kill") | Some("9") => "KILL",
        _ => "TERM",
    };
    let ok = Command::new("kill")
        .args(["-s", sig, &req.pid.to_string()])
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_self_from_proc() {
        let me = std::process::id();
        let pi = read_stat(me).expect("stat for self");
        assert!(!pi.comm.is_empty());
        assert_ne!(pi.state, '?'); // parsed a real state char
        assert_ne!(pi.ppid, 0);
    }

    #[test]
    fn subtree_of_parent_includes_self_at_depth_zero() {
        let me = std::process::id();
        let (info, kids) = scan_procs();
        let ppid = info.get(&me).expect("self present").ppid;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        subtree(ppid, &info, &kids, &mut seen, &mut out, 0);
        assert_eq!(out.first().map(|n| n.pid), Some(ppid)); // root first, depth 0
        assert_eq!(out.first().map(|n| n.depth), Some(0));
        assert!(out.iter().any(|n| n.pid == me), "descendants include self");
    }

    #[test]
    fn allowed_pids_scopes_downward_only() {
        let me = std::process::id();
        let (_, kids) = scan_procs();
        // Treat our own pid as a pane shell: the allow-set is its subtree.
        let panes = vec![(0u32, 0u32, me, String::new())];
        let allowed = allowed_pids(&panes, &kids);
        assert!(allowed.contains(&me)); // the root itself
        assert!(!allowed.contains(&1)); // an ancestor (init) is never in a subtree
    }
}
