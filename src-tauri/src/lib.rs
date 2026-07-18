//! mymux desktop app — a thin Tauri shell. It hosts the web UI and owns the SSH
//! tunnels to remote `mymuxd`s: a native host manager (russh, in-process) driven
//! by the UI via commands. Several hosts can be connected at once — each gets its
//! own local forward port, and status events are tagged with the host id.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use mymux_connect::{config_dir, exec_bytes, master_exec_bytes, parse_probe, run_russh_tunnel, DaemonMeta, Host, HostStore, Status, WorkReport, UNINSTALL_SCRIPT};
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
    conns: Arc<Mutex<HashMap<String, Active>>>,
    /// Latest tunnel status per host id (kept by each forwarder task).
    statuses: Arc<Mutex<HashMap<String, Status>>>,
    /// The LAST explanatory reason per host ("bind 8089 in use", "health
    /// probe timed out", …) — what liberates 'connecting' from being a
    /// reasonless spinner. Cleared on every Connected transition.
    reasons: Arc<Mutex<HashMap<String, String>>>,
    /// Last local port used per host, so a host keeps a stable URL across
    /// reconnects of its tunnel.
    ports: Arc<Mutex<HashMap<String, u16>>>,
    /// Latest post-connect meta probe per host (daemon version + hook map).
    metas: Arc<Mutex<HashMap<String, HostMeta>>>,
}

/// A host's post-connect audit, refreshed on every Connected transition and
/// after each daemon_update: whether the remote daemon matches this app's
/// pin, and which agent hooks are installed.
#[derive(Default, Clone, Serialize)]
struct HostMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon: Option<DaemonMeta>,
    hooks: HashMap<String, bool>,
}

/// The `mymux:hostmeta` event payload: which host a meta refresh belongs to.
#[derive(Clone, Serialize)]
struct HostMetaMsg {
    host_id: String,
    meta: HostMeta,
}

/// The `mymux:status` event payload: which host a status belongs to, plus the
/// latest explanatory reason when one exists ("bind 8089 in use", …).
#[derive(Clone, Serialize)]
struct StatusEvent {
    host_id: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    why: Option<String>,
}

#[derive(Serialize)]
struct ConnInfo {
    host_id: String,
    port: u16,
    status: Option<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    why: Option<String>,
}

/// A free local port for a host's tunnel, from explicit maps (also usable
/// from spawned closures that only hold Arc clones): its remembered port
/// when available, else probe upward from 8088, skipping ports held by other
/// live tunnels. None when the whole 8088-8187 range is taken.
fn alloc_port_maps(
    conns: &Mutex<HashMap<String, Active>>,
    ports: &Mutex<HashMap<String, u16>>,
    host_id: &str,
) -> Option<u16> {
    let in_use: Vec<u16> = conns.lock().unwrap().values().map(|a| a.port).collect();
    let free = |p: u16| {
        !in_use.contains(&p) && std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
    };
    if let Some(&p) = ports.lock().unwrap().get(host_id) {
        if free(p) {
            return Some(p);
        }
    }
    (8088u16..8188).find(|&p| free(p))
}

/// A free local port for a host's tunnel, as a Result for command paths.
fn alloc_port(state: &ConnState, host_id: &str) -> Result<u16, String> {
    alloc_port_maps(&state.conns, &state.ports, host_id)
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
    let reasons = state.reasons.lock().unwrap();
    state
        .conns
        .lock()
        .unwrap()
        .iter()
        .map(|(id, a)| ConnInfo {
            host_id: id.clone(),
            port: a.port,
            status: statuses.get(id).cloned(),
            why: reasons.get(id).cloned(),
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

/// The latest post-connect meta probe for a host (daemon version + hooks),
/// so a UI that attached after the event can still render it.
#[tauri::command(rename_all = "snake_case")]
fn host_meta(state: State<'_, ConnState>, host_id: String) -> Option<HostMeta> {
    state.metas.lock().unwrap().get(&host_id).cloned()
}

/// Run one meta probe over a live master and publish it (cache + event). Both
/// call sites — the Connected-transition watcher and daemon_update — conflate
/// here so "what the UI shows" always comes from the same store.
async fn refresh_host_meta(
    metas: &Arc<Mutex<HashMap<String, HostMeta>>>,
    app: &AppHandle,
    host_id: &str,
    master: &std::sync::Arc<mymux_connect::Master>,
) {
    let daemon = mymux_connect::probe_daemon_meta(master).await.ok();
    let mut hooks = HashMap::new();
    for (agent, _label) in mymux_connect::agenthook::AGENTS {
        if let Ok(on) = mymux_connect::agenthook::hook_status(master, agent).await {
            hooks.insert(agent.to_string(), on);
        }
    }
    let meta = HostMeta { daemon, hooks };
    metas.lock().unwrap().insert(host_id.to_string(), meta.clone());
    let _ = app.emit(
        "mymux:hostmeta",
        HostMetaMsg {
            host_id: host_id.to_string(),
            meta,
        },
    );
}

/// Push this app's daemon bundle to a connected host and run the installer —
/// the user-confirmed UPDATE for a live, outdated daemon (the zero-touch
/// path only fires when the daemon won't start at all). The installer swaps
/// binaries atomically and restarts ONLY mymuxd under systemd
/// (KillMode=process: tmux sessions survive; ptyd is never restarted, so
/// persistent panes ride through — throwaway ⌁ panes do die). The tunnel
/// flaps back on its own and a fresh meta probe re-clears the badge.
#[tauri::command(rename_all = "snake_case")]
async fn daemon_update(
    app: AppHandle,
    state: State<'_, ConnState>,
    host_id: String,
) -> Result<String, String> {
    let master = hook_master(&state, &host_id)?;
    let out = mymux_connect::push_daemon_update(&master).await?;
    refresh_host_meta(&state.metas, &app, &host_id, &master).await;
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

    // Forward tunnel status to the webview, tagged with the host id. Every
    // transition INTO Connected fires one background meta probe (daemon
    // version audit + agent-hook review) on the same master — this is the
    // check that also catches a still-running OLD daemon, which the
    // zero-touch installer never sees (it only acts on DaemonUnreachable).
    let statuses = state.statuses.clone();
    let reasons = state.reasons.clone();
    let metas = state.metas.clone();
    let hid = host_id.clone();
    let app2 = app.clone();
    let master3 = master.clone();
    let forwarder = tauri::async_runtime::spawn(async move {
        let mut was_connected = false;
        while let Some(s) = rx.recv().await {
            // Error notes carry the WHY; everything else carries the state.
            if let Status::Error(why) = &s {
                reasons.lock().unwrap().insert(hid.clone(), why.clone());
            }
            if s == Status::Connected {
                reasons.lock().unwrap().remove(&hid);
            }
            statuses.lock().unwrap().insert(hid.clone(), s.clone());
            let why = reasons.lock().unwrap().get(&hid).cloned();
            let _ = app2.emit(
                "mymux:status",
                StatusEvent {
                    host_id: hid.clone(),
                    status: s.clone(),
                    why,
                },
            );
            let now_connected = s == Status::Connected;
            if now_connected && !was_connected {
                let (m, h, a, ms) = (master3.clone(), hid.clone(), app2.clone(), metas.clone());
                tauri::async_runtime::spawn(async move {
                    refresh_host_meta(&ms, &a, &h, &m).await;
                });
            }
            was_connected = now_connected;
        }
    });
    let master2 = master.clone();
    let task = tauri::async_runtime::spawn({
        let conns_c = state.conns.clone();
        let ports_c = state.ports.clone();
        let hid_c = host_id.clone();
        async move {
            // A held port is transient: the supervisor re-asks for a fresh
            // port and retries instead of dying on the first failed bind.
            let realloc = move || alloc_port_maps(&conns_c, &ports_c, &hid_c);
            run_russh_tunnel(cfg, &master2, tx, realloc).await;
        }
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
            agent_hook,
            host_meta,
            daemon_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running the mymux app");
}
