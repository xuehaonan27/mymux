//! Package endpoints — the UI's "marketplace" backend. The daemon embeds NO
//! recipes or acquisition logic (see docs/PKG-SPEC.md): every request is
//! relayed to the decoupled `mymux-pkg` CLI (sibling binary, else PATH).

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

fn pkg_cli() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("mymux-pkg")))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("mymux-pkg"))
}

/// Package specs come from the UI: keep them boring before they hit argv
/// (no shell involved, but names shouldn't smuggle path tricks either).
/// Accepts curated names plus dynamic npm specs (`npm:@scope/pkg`).
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.@:/".contains(c))
}

/// Resolved package DIRS with an install/remove in flight. Keyed by the
/// directory mymux-pkg stages into, not the raw spec: `npm:foo` and
/// `npm:foo@1.0.0` are different specs but the SAME `.tmp-<dir>`/dest dir, and
/// two installs racing one staging dir is exactly what this guard exists to
/// prevent (audit #35). Guard drops keep the set honest across timeouts and
/// panics.
static INFLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

struct InflightGuard(String);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        INFLIGHT.lock().unwrap().remove(&self.0);
    }
}

fn claim(name: &str) -> Option<InflightGuard> {
    let mut s = INFLIGHT.lock().unwrap();
    if !s.insert(name.to_string()) {
        return None;
    }
    Some(InflightGuard(name.to_string()))
}

/// The directory mymux-pkg resolves a spec to (staging `.tmp-<dir>` and dest
/// `<base>/<dir>` both derive from it). MUST match mymux-pkg's own mapping
/// (`cmd_remove` / `install_npm_dynamic`): an `npm:` spec loses its @version
/// (the separator is the LAST '@' that isn't the leading one), and every
/// char outside [alnum . - _] becomes '_'.
fn resolved_dir(name: &str) -> String {
    let bare = match name.split_once(':') {
        Some(("npm", rest)) => match rest.rfind('@') {
            Some(i) if i > 0 => &rest[..i],
            _ => rest,
        },
        _ => name,
    };
    bare.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// `GET /pkgs/search?q=` — relay `mymux-pkg search` (curated index only).
/// Runs on the daemon host, which owns the package dir being queried.
pub async fn search(
    axum::extract::Query(q): axum::extract::Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let empty = serde_json::json!({ "hits": [], "warnings": [] });
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() || query.len() > 100 {
        return Json(empty);
    }
    let out = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new(pkg_cli())
            .arg("search")
            .arg(&query)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let v = match out {
        Err(_) => serde_json::json!({
            "hits": [],
            "warnings": ["search timed out on the daemon host — slow network or a proxy problem? (see ~/.config/mymux/env)"],
        }),
        Ok(r) => r
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice(&o.stdout).ok())
            .unwrap_or_else(|| {
                serde_json::json!({
                    "hits": [],
                    "warnings": ["mymux-pkg search failed on the daemon host"],
                })
            }),
    };
    Json(v)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

/// `GET /pkgs/catalog` — the CLI's recipe directory (JSON array, relayed).
pub async fn catalog() -> Json<serde_json::Value> {
    let out = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(pkg_cli())
            .arg("catalog")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let v = out
        .ok()
        .and_then(Result::ok)
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or_else(|| serde_json::json!([]));
    Json(v)
}

#[derive(Deserialize)]
pub struct PkgReq {
    name: String,
}

#[derive(Serialize)]
pub struct PkgResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    err: Option<String>,
}

fn fail(err: impl Into<String>) -> Json<PkgResp> {
    Json(PkgResp {
        ok: false,
        err: Some(err.into()),
    })
}

/// Run the CLI with a hard deadline. kill_on_drop reaps the child when the
/// timeout fires — a wedged download must not leave a zombie install running
/// (and holding the in-flight claim's staging dir) forever.
async fn run(args: &[&str], limit: Duration) -> PkgResp {
    let out = tokio::time::timeout(
        limit,
        Command::new(pkg_cli())
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match out {
        Err(_) => PkgResp {
            ok: false,
            err: Some(format!(
                "timed out after {}s — slow network or a proxy problem? (see ~/.config/mymux/env)",
                limit.as_secs()
            )),
        },
        Ok(Ok(o)) if o.status.success() => PkgResp {
            ok: true,
            err: None,
        },
        Ok(Ok(o)) => {
            let tail: Vec<String> = String::from_utf8_lossy(&o.stderr)
                .lines()
                .rev()
                .take(3)
                .map(str::to_string)
                .collect();
            let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join(" · ");
            PkgResp {
                ok: false,
                err: Some(if tail.is_empty() {
                    "failed".into()
                } else {
                    tail
                }),
            }
        }
        Ok(Err(e)) => PkgResp {
            ok: false,
            err: Some(format!("mymux-pkg is not installed: {e}")),
        },
    }
}

/// `POST /pkgs/install {name}` — install a package by recipe name or spec.
pub async fn install(Json(req): Json<PkgReq>) -> Json<PkgResp> {
    if !valid_name(&req.name) {
        return fail("bad package name");
    }
    let Some(_guard) = claim(&resolved_dir(&req.name)) else {
        return fail(format!("{} is already being installed", req.name));
    };
    Json(run(&["install", &req.name], Duration::from_secs(600)).await)
}

/// `POST /pkgs/remove {name}` — remove an installed package.
pub async fn remove(Json(req): Json<PkgReq>) -> Json<PkgResp> {
    if !valid_name(&req.name) {
        return fail("bad package name");
    }
    let Some(_guard) = claim(&resolved_dir(&req.name)) else {
        return fail(format!("{} has an operation in flight", req.name));
    };
    Json(run(&["remove", &req.name], Duration::from_secs(60)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_dir_collapses_specs_the_way_mymux_pkg_does() {
        assert_eq!(resolved_dir("npm:foo"), resolved_dir("npm:foo@1.0.0"));
        assert_eq!(
            resolved_dir("npm:@scope/pkg"),
            resolved_dir("npm:@scope/pkg@2.0.0")
        );
        assert_eq!(resolved_dir("npm:@scope/pkg"), "_scope_pkg");
        assert_eq!(resolved_dir("npm:foo"), "foo");
        assert_ne!(resolved_dir("npm:foo"), resolved_dir("npm:bar"));
        // Curated (non-npm) names pass through safe_dir unchanged.
        assert_eq!(resolved_dir("rust-analyzer"), "rust-analyzer");
        // And an install spec matches the remove spec's dir.
        assert_eq!(resolved_dir("npm:foo@1.0.0"), resolved_dir("npm:foo"));
    }

    #[test]
    fn inflight_claim_blocks_the_same_resolved_dir() {
        let g1 = claim(&resolved_dir("npm:mymux-test-pkg-a")).expect("first claim");
        // Same package, different spec → same dir → blocked.
        assert!(claim(&resolved_dir("npm:mymux-test-pkg-a@9.9.9")).is_none());
        // A different package installs in parallel just fine.
        let g2 = claim(&resolved_dir("npm:mymux-test-pkg-b")).expect("other package");
        drop(g2);
        drop(g1);
        // Guard drop releases the dir for the next operation.
        assert!(claim(&resolved_dir("npm:mymux-test-pkg-a@9.9.9")).is_some());
    }
}
