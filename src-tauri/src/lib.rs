//! mymux desktop app — a thin Tauri shell. It hosts the web UI and owns the SSH
//! tunnels to remote `mymuxd`s: a native host manager (russh, in-process) driven
//! by the UI via commands. Several hosts can be connected at once — each gets its
//! own local forward port, and status events are tagged with the host id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mymux_connect::{config_dir, exec_bytes, master_exec_bytes, parse_probe, run_russh_tunnel, Host, HostStore, Status, WorkReport, UNINSTALL_SCRIPT};
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};

/// Idempotent remote-daemon launch: the systemd --user service, else a detached
/// `setsid`.
fn remote_daemon_cmd() -> String {
    "systemctl --user start mymuxd.service 2>/dev/null || pgrep -x mymuxd >/dev/null 2>&1 || setsid mymuxd >/tmp/mymuxd.log 2>&1 </dev/null &".to_string()
}

struct Active {
    task: JoinHandle<()>,
    forwarder: JoinHandle<()>,
    port: u16,
    /// The host's persistent SSH master — uninstall rides it too (no fresh
    /// auth while connected).
    master: std::sync::Arc<mymux_connect::Master>,
}

#[derive(Default)]
struct ConnState {
    /// Live tunnels, one per host id.
    conns: Mutex<HashMap<String, Active>>,
    /// Latest tunnel status per host id (kept by each forwarder task).
    statuses: Arc<Mutex<HashMap<String, Status>>>,
    /// Last local port used per host, so a host keeps a stable URL across
    /// reconnects of its tunnel.
    ports: Mutex<HashMap<String, u16>>,
}

/// The `mymux:status` event payload: which host a status belongs to.
#[derive(Clone, Serialize)]
struct StatusEvent {
    host_id: String,
    status: Status,
}

#[derive(Serialize)]
struct ConnInfo {
    host_id: String,
    port: u16,
    status: Option<Status>,
}

/// A free local port for a host's tunnel: its remembered port when available,
/// else probe upward from 8088, skipping ports held by other live tunnels.
fn alloc_port(state: &ConnState, host_id: &str) -> Result<u16, String> {
    let in_use: Vec<u16> = state.conns.lock().unwrap().values().map(|a| a.port).collect();
    let free = |p: u16| {
        !in_use.contains(&p) && std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
    };
    if let Some(&p) = state.ports.lock().unwrap().get(host_id) {
        if free(p) {
            return Ok(p);
        }
    }
    (8088u16..8188)
        .find(|&p| free(p))
        .ok_or_else(|| "no free local port in 8088-8187".to_string())
}

/// Tear down one host's tunnel (if any) and wait for its listener to drop, so a
/// reconnect can rebind the same port.
async fn teardown(state: &ConnState, host_id: &str) {
    let old = state.conns.lock().unwrap().remove(host_id);
    if let Some(a) = old {
        a.task.abort();
        a.forwarder.abort();
        let _ = a.task.await;
    }
    state.statuses.lock().unwrap().remove(host_id);
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

#[tauri::command(rename_all = "snake_case")]
fn conn_status(state: State<'_, ConnState>, host_id: String) -> Option<Status> {
    state.statuses.lock().unwrap().get(&host_id).cloned()
}

/// Every live tunnel with its local port and latest status.
#[tauri::command]
fn conns_list(state: State<'_, ConnState>) -> Vec<ConnInfo> {
    let statuses = state.statuses.lock().unwrap();
    state
        .conns
        .lock()
        .unwrap()
        .iter()
        .map(|(id, a)| ConnInfo {
            host_id: id.clone(),
            port: a.port,
            status: statuses.get(id).cloned(),
        })
        .collect()
}

#[tauri::command(rename_all = "snake_case")]
async fn disconnect(state: State<'_, ConnState>, host_id: String) -> Result<(), String> {
    teardown(&state, &host_id).await;
    Ok(())
}

/// Run the box-side uninstall script: over the live tunnel's MASTER when
/// connected (no fresh auth at all), else a one-shot auth with the given
/// passphrase — keeping "uninstall works while disconnected". `args` is
/// "--probe" (read-only work report) or "--yes" (the destructive run, only
/// after the UI showed the report and the user confirmed).
async fn run_remote_uninstall(
    state: &ConnState,
    host_id: &str,
    passphrase: Option<String>,
    args: &str,
    limit: std::time::Duration,
) -> Result<String, String> {
    let cmd = format!("bash -s -- {args}");
    let shared = state
        .conns
        .lock()
        .unwrap()
        .get(host_id)
        .map(|a| a.master.clone());
    let out = if let Some(master) = shared {
        master_exec_bytes(&master, &cmd, UNINSTALL_SCRIPT.as_bytes(), limit).await
    } else {
        let host = HostStore::load(&config_dir())
            .get(host_id)
            .cloned()
            .ok_or_else(|| format!("no such host: {host_id}"))?;
        // Ports/daemon-cmd are irrelevant for a one-shot exec; host key is verified
        // against known_hosts as usual (unknown → error tells the UI to connect
        // once first).
        let cfg = host.to_tunnel_config(0, 0, String::new(), false);
        exec_bytes(
            &cfg,
            passphrase.as_deref(),
            &cmd,
            UNINSTALL_SCRIPT.as_bytes(),
            limit,
        )
        .await
    };
    let out = out.map_err(|s| match s {
        Status::Error(e) => e,
        Status::HostKeyUnknown { .. } => {
            "host key not in known_hosts — connect to this host once (trusting its key) before uninstalling"
                .into()
        }
        Status::AuthFailed => {
            "authentication failed — wrong passphrase, or the key isn't authorized".into()
        }
        other => format!("remote command failed: {other:?}"),
    })?;
    Ok(out)
}

/// `probe_remote` — what work is running on the host and what an uninstall
/// would remove. Read-only; the UI shows this as the confirmation page.
#[tauri::command(rename_all = "snake_case")]
async fn probe_remote(state: State<'_, ConnState>, host_id: String, passphrase: Option<String>) -> Result<WorkReport, String> {
    let out =
        run_remote_uninstall(&state, &host_id, passphrase, "--probe", std::time::Duration::from_secs(60))
            .await?;
    Ok(parse_probe(&out))
}

/// `uninstall_remote` — the destructive run (--yes), returning the script's
/// own log lines for the UI to display.
#[tauri::command(rename_all = "snake_case")]
async fn uninstall_remote(state: State<'_, ConnState>, host_id: String, passphrase: Option<String>) -> Result<String, String> {
    run_remote_uninstall(&state, &host_id, passphrase, "--yes", std::time::Duration::from_secs(120)).await
}

/// Shared-master resolution for agent-hook commands (the four status/action
/// calls ride ONE auth — the tunnel is almost always up when the user manages
/// a host; a disconnected host gets a clear, non-silent error instead).
fn hook_master(state: &ConnState, host_id: &str) -> Result<std::sync::Arc<mymux_connect::Master>, String> {
    state
        .conns
        .lock()
        .unwrap()
        .get(host_id)
        .map(|a| a.master.clone())
        .ok_or_else(|| {
            "connect to this host first — agent hooks ride the live tunnel's master".to_string()
        })
}

/// Whether each agent's notify hooks are present on this host.
#[tauri::command(rename_all = "snake_case")]
async fn agent_hook_status(
    state: State<'_, ConnState>,
    host_id: String,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let master = hook_master(&state, &host_id)?;
    let mut out = std::collections::HashMap::new();
    for (agent, _label) in mymux_connect::agenthook::AGENTS {
        let s = mymux_connect::agenthook::hook_status(&master, agent).await?;
        out.insert(agent.to_string(), s);
    }
    Ok(out)
}

/// Install (or uninstall, with `install: false`) one agent's notify hooks.
#[tauri::command(rename_all = "snake_case")]
async fn agent_hook(
    state: State<'_, ConnState>,
    host_id: String,
    agent: String,
    install: bool,
) -> Result<String, String> {
    let master = hook_master(&state, &host_id)?;
    mymux_connect::agenthook::hook_set(&master, &agent, install).await
}

/// Connect (or re-drive: retry passphrase / trust host key) one host's tunnel.
/// Other hosts' tunnels are untouched. Returns the local forward port — the UI
/// points that host's workspace at `ws://127.0.0.1:<port>/ws`.
#[tauri::command(rename_all = "snake_case")]
async fn connect(
    app: AppHandle,
    state: State<'_, ConnState>,
    host_id: String,
    passphrase: Option<String>,
    trust_host_key: Option<bool>,
) -> Result<u16, String> {
    let host = HostStore::load(&config_dir())
        .get(&host_id)
        .cloned()
        .ok_or_else(|| format!("no such host: {host_id}"))?;

    teardown(&state, &host_id).await; // re-drive this host only
    let port = alloc_port(&state, &host_id)?;
    state.ports.lock().unwrap().insert(host_id.clone(), port);

    let cfg = host.to_tunnel_config(port, 8088, remote_daemon_cmd(), trust_host_key.unwrap_or(false));
    // One persistent master per (re-)drive: every forward cycle, exec and
    // uninstall over this host leases channels off its single auth.
    let master = std::sync::Arc::new(mymux_connect::Master::new(cfg.clone(), passphrase));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Status>(32);

    // Forward tunnel status to the webview, tagged with the host id.
    let statuses = state.statuses.clone();
    let hid = host_id.clone();
    let app2 = app.clone();
    let forwarder = tauri::async_runtime::spawn(async move {
        while let Some(s) = rx.recv().await {
            statuses.lock().unwrap().insert(hid.clone(), s.clone());
            let _ = app2.emit("mymux:status", StatusEvent { host_id: hid.clone(), status: s });
        }
    });
    let master2 = master.clone();
    let task = tauri::async_runtime::spawn(async move {
        run_russh_tunnel(cfg, &master2, tx).await;
    });

    state
        .conns
        .lock()
        .unwrap()
        .insert(host_id, Active { task, forwarder, port, master });
    Ok(port)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(ConnState::default())
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            host_save,
            host_delete,
            connect,
            disconnect,
            conn_status,
            conns_list,
            probe_remote,
            uninstall_remote,
            agent_hook_status,
            agent_hook
        ])
        .run(tauri::generate_context!())
        .expect("error while running the mymux app");
}
