//! Package endpoints — the UI's "marketplace" backend. The daemon embeds NO
//! recipes or acquisition logic (see docs/PKG-SPEC.md): every request is
//! relayed to the decoupled `mymux-pkg` CLI (sibling binary, else PATH).

use std::path::PathBuf;

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

/// Package names come from the UI: keep them boring before they hit argv.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `GET /pkgs/catalog` — the CLI's recipe directory (JSON array, relayed).
pub async fn catalog() -> Json<serde_json::Value> {
    let out = Command::new(pkg_cli()).arg("catalog").output().await;
    let v = out
        .ok()
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

async fn run(args: &[&str]) -> PkgResp {
    match Command::new(pkg_cli()).args(args).output().await {
        Ok(o) if o.status.success() => PkgResp {
            ok: true,
            err: None,
        },
        Ok(o) => {
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
        Err(e) => PkgResp {
            ok: false,
            err: Some(format!("mymux-pkg is not installed: {e}")),
        },
    }
}

/// `POST /pkgs/install {name}` — install a package by recipe name.
pub async fn install(Json(req): Json<PkgReq>) -> Json<PkgResp> {
    if !valid_name(&req.name) {
        return Json(PkgResp {
            ok: false,
            err: Some("bad package name".into()),
        });
    }
    Json(run(&["install", &req.name]).await)
}

/// `POST /pkgs/remove {name}` — remove an installed package.
pub async fn remove(Json(req): Json<PkgReq>) -> Json<PkgResp> {
    if !valid_name(&req.name) {
        return Json(PkgResp {
            ok: false,
            err: Some("bad package name".into()),
        });
    }
    Json(run(&["remove", &req.name]).await)
}
