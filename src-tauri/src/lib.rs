//! mymux desktop app — a thin Tauri shell. It hosts the web UI and owns the SSH
//! tunnel to the remote `mymuxd`: a native host manager (russh, in-process) driven
//! by the UI via commands, plus a legacy single-host auto-connect via the `ssh`
//! binary that stays until the host-manager UI lands.

use std::sync::{Arc, Mutex};

use mymux_connect::{config_dir, run_russh_tunnel, Host, HostStore, Status};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};

/// Idempotent remote-daemon launch: the systemd --user service, else a detached
/// `setsid`.
fn remote_daemon_cmd() -> String {
    "systemctl --user start mymuxd.service 2>/dev/null || pgrep -x mymuxd >/dev/null 2>&1 || setsid mymuxd >/tmp/mymuxd.log 2>&1 </dev/null &".to_string()
}

// ---- native host manager: russh tunnel, driven by the UI -------------------

struct Active {
    task: JoinHandle<()>,
    forwarder: JoinHandle<()>,
    #[allow(dead_code)]
    host_id: String,
}

#[derive(Default)]
struct ConnState {
    active: Mutex<Option<Active>>,
    last_status: Arc<Mutex<Option<Status>>>,
}

/// Tear down the running tunnel (if any) and wait for its listener to drop, so a
/// subsequent connect can rebind the local port.
async fn teardown(state: &ConnState) {
    let old = { state.active.lock().unwrap().take() };
    if let Some(a) = old {
        a.task.abort();
        a.forwarder.abort();
        let _ = a.task.await;
    }
}

#[tauri::command]
fn hosts_list() -> HostStore {
    HostStore::load(&config_dir())
}

#[tauri::command(rename_all = "snake_case")]
fn host_save(host: Host, make_default: Option<bool>) -> Result<(), String> {
    let dir = config_dir();
    let mut store = HostStore::load(&dir);
    let id = host.id.clone();
    store.upsert(host);
    if make_default.unwrap_or(false) {
        store.default_id = Some(id);
    }
    store.save(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn host_delete(id: String) -> Result<(), String> {
    let dir = config_dir();
    let mut store = HostStore::load(&dir);
    store.remove(&id);
    store.save(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn conn_status(state: State<'_, ConnState>) -> Option<Status> {
    state.last_status.lock().unwrap().clone()
}

#[tauri::command]
async fn disconnect(state: State<'_, ConnState>) -> Result<(), String> {
    teardown(&state).await;
    *state.last_status.lock().unwrap() = None;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
async fn connect(
    app: AppHandle,
    state: State<'_, ConnState>,
    host_id: String,
    passphrase: Option<String>,
    trust_host_key: Option<bool>,
) -> Result<(), String> {
    let host = HostStore::load(&config_dir())
        .get(&host_id)
        .cloned()
        .ok_or_else(|| format!("no such host: {host_id}"))?;

    teardown(&state).await; // free the local port before rebinding

    let cfg = host.to_tunnel_config(8088, 8088, remote_daemon_cmd(), trust_host_key.unwrap_or(false));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Status>(32);

    // Forward tunnel status to the webview + remember the latest.
    let last = state.last_status.clone();
    let app2 = app.clone();
    let forwarder = tauri::async_runtime::spawn(async move {
        while let Some(s) = rx.recv().await {
            *last.lock().unwrap() = Some(s.clone());
            let _ = app2.emit("mymux:status", s);
        }
    });
    let task = tauri::async_runtime::spawn(run_russh_tunnel(cfg, passphrase, tx));

    *state.active.lock().unwrap() = Some(Active {
        task,
        forwarder,
        host_id,
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(ConnState::default())
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            host_save,
            host_delete,
            connect,
            disconnect,
            conn_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running the mymux app");
}
