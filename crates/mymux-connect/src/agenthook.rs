//! Agent-notify hook management on a host: install / uninstall / status of
//! the four agent hooks (claude, codex, kimi, opencode) through the SAME
//! persistent SSH master the tunnel uses. Payloads are embedded at build time;
//! per call we upload them + the small agenthook-remote.sh driver and run it.
//!
//! Uninstall removes ONLY our blocks (never a user's own notify/hooks — the
//! remote script is careful; the app never sees the target files directly).

use std::time::Duration;

use crate::russh_tunnel::{master_exec_bytes, master_exec_script, Master, Status};

const DRIVER: &str = include_str!("../../../scripts/agenthook-remote.sh");
const REPORT: &str = include_str!("../../../scripts/mymux-agent-report.sh");
const CODEX_HANDLER: &str = include_str!("../../../scripts/mymux-codex-notify.sh");
const OPENCODE_PLUGIN: &str = include_str!("../../../scripts/opencode-mymux-plugin.js");

/// The four agents the manager can wire up. Labels = user-facing names.
pub const AGENTS: [(&str, &str); 4] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("kimi", "Kimi Code"),
    ("opencode", "Open Code"),
];

const DRIVER_PATH: &str = "/tmp/mymux-agenthook.sh";

/// Upload the driver script once per call (idempotent, 4 KiB — cheap and
/// always the current version after an app upgrade).
async fn upload_driver(master: &Master) -> Result<(), Status> {
    let cmd = format!("cat > {DRIVER_PATH} && chmod +x {DRIVER_PATH}");
    master_exec_bytes(master, &cmd, DRIVER.as_bytes(), Duration::from_secs(30))
        .await
        .map(|_| ())
}

/// Upload one payload into place (target path absolute, app-controlled constant).
/// The target is DOUBLE-quoted: it starts with `$HOME` (or an XDG fallback),
/// and single quotes would land the file in a literal `./$HOME/` directory —
/// the hooks used to "install successfully" into exactly that black hole.
async fn upload_payload(master: &Master, target: &str, bytes: &[u8]) -> Result<(), Status> {
    let cmd = format!(
        "mkdir -p \"$(dirname \"{target}\")\" && cat > \"{target}\" && chmod +x \"{target}\" && test -x \"{target}\""
    );
    master_exec_bytes(master, &cmd, bytes, Duration::from_secs(60))
        .await
        .map(|_| ())
}

fn ensure_client_paths(agent: &str) -> Result<Vec<(&'static str, &'static [u8])>, Status> {
    let mut v: Vec<(&'static str, &'static [u8])> =
        Vec::with_capacity(2);
    match agent {
        "claude" | "kimi" => v.push(("$HOME/.local/bin/mymux-agent-report.sh", REPORT.as_bytes())),
        "codex" => {
            v.push(("$HOME/.local/bin/mymux-agent-report.sh", REPORT.as_bytes()));
            v.push(("$HOME/.local/bin/mymux-codex-notify.sh", CODEX_HANDLER.as_bytes()));
        }
        // Same XDG logic the driver uses to VERIFY (${XDG_CONFIG_HOME:-...}),
        // or a user with XDG set gets the plugin written where the checker
        // (and opencode itself) never looks.
        "opencode" => v.push((
            "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/mymux.js",
            OPENCODE_PLUGIN.as_bytes(),
        )),
        other => {
            return Err(Status::Error(format!("unknown agent {other}")));
        }
    }
    Ok(v)
}

fn payload_for(agent: &str) -> &'static str {
    match agent {
        "claude" | "kimi" => "$HOME/.local/bin/mymux-agent-report.sh",
        "codex" => "$HOME/.local/bin/mymux-codex-notify.sh",
        _ => "",
    }
}

/// installed/missing for one agent.
pub async fn hook_status(master: &Master, agent: &str) -> Result<bool, String> {
    upload_driver(master).await.map_err(|s| format!("upload driver: {s:?}"))?;
    let out = master_exec_script(
        master,
        &format!("{DRIVER_PATH} {agent} status"),
        Duration::from_secs(30),
    )
    .await
    .map_err(|s| format!("status {agent}: {s:?}"))?;
    Ok(out.trim() == "installed")
}

/// install=true installs, install=false uninstalls.
pub async fn hook_set(master: &Master, agent: &str, install: bool) -> Result<String, String> {
    upload_driver(master).await.map_err(|s| format!("upload driver: {s:?}"))?;
    if install {
        for (target, bytes) in ensure_client_paths(agent).map_err(|s| format!("{s:?}"))? {
            upload_payload(master, target, bytes)
                .await
                .map_err(|s| format!("upload payload -> {target}: {s:?}"))?;
        }
    }
    let (verb, payload) = if install {
        ("install", payload_for(agent))
    } else {
        ("uninstall", "")
    };
    let cmd = format!("{DRIVER_PATH} {agent} {verb} {payload}");
    master_exec_script(master, &cmd, Duration::from_secs(60))
        .await
        .map_err(|s| format!("{verb} {agent}: {s:?}"))
}
