//! mymux desktop app — a thin Tauri shell that keeps a resilient SSH tunnel to a
//! remote `mymuxd` and hosts the web UI, unlocking the full native keybindings a
//! browser can't reserve (Cmd+T / Cmd+W / Cmd+1-9).

use mymux_connect::{run_tunnel, TunnelConfig};

/// Resolve the ssh host: `MYMUX_HOST` env, else the first line of
/// `~/.config/mymux/host`.
fn tunnel_host() -> Option<String> {
    if let Ok(h) = std::env::var("MYMUX_HOST") {
        let h = h.trim().to_string();
        if !h.is_empty() {
            return Some(h);
        }
    }
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".config/mymux/host");
    let contents = std::fs::read_to_string(path).ok()?;
    let host = contents.trim().to_string();
    (!host.is_empty()).then_some(host)
}

/// Keep the resilient tunnel to the remote daemon alive on a background thread.
fn spawn_tunnel() {
    let Some(host) = tunnel_host() else {
        eprintln!(
            "mymux: no ssh host configured — set MYMUX_HOST or write ~/.config/mymux/host.\n\
             Using whatever already listens on localhost:8088."
        );
        return;
    };
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("mymux: failed to start tokio runtime: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let mut cfg = TunnelConfig::new(host);
            cfg.ensure_daemon = true;
            run_tunnel(cfg).await;
        });
    });
}

pub fn run() {
    spawn_tunnel();
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the mymux app");
}
