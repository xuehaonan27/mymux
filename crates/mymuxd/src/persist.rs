//! Bridge to mymux-ptyd: ALL native panes (⌁ ephemeral and ∞ persistent) are
//! held by the tiny holder daemon, which owns their PTYs and terminal grids.
//! Persistence is a per-pane flag: ptyd kills a pane spawned as ephemeral
//! when our connection drops (so ⌁ still dies with mymuxd, as before), while
//! persistent panes survive mymuxd restarts — we reconnect and re-adopt them.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};

use mymux_ptyd::client::{Client, PtydEvent};
use mymux_ptyd::proto::socket_path;
pub use mymux_ptyd::proto::{is_ephemeral, is_persistent, EPH_BIT, PERSIST_BIT};
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::native::NativeWindows;
use crate::tmux::{Hub, ServerEvent};

/// What we mirror per live pane. `ephemeral` is the pane's CURRENT kind (the
/// id keeps its birth bits; ⌁→∞ promotion flips only this flag).
#[derive(Clone)]
pub struct PaneMeta {
    pub name: String,
    pub pid: u32,
    pub ephemeral: bool,
}

#[derive(Default)]
pub struct Persist {
    client: RwLock<Option<Arc<Client>>>,
    connect_lock: AsyncMutex<()>,
    /// Live native panes as we know them, kept in step with ptyd via the
    /// resync-on-connect List plus spawn/exit events.
    mirror: Mutex<BTreeMap<u32, PaneMeta>>,
    next: Mutex<u32>,
}

impl Persist {
    pub fn list(&self) -> Vec<(u32, String)> {
        self.mirror
            .lock()
            .unwrap()
            .iter()
            .map(|(&id, m)| (id, m.name.clone()))
            .collect()
    }

    /// `(id, shell pid, name)` for the process tree + scoped-kill allow-set.
    pub fn pids(&self) -> Vec<(u32, u32, String)> {
        self.mirror
            .lock()
            .unwrap()
            .iter()
            .map(|(&id, m)| (id, m.pid, m.name.clone()))
            .collect()
    }

    pub fn contains(&self, id: u32) -> bool {
        self.mirror.lock().unwrap().contains_key(&id)
    }

    /// Shell pid of a pane (to read its cwd for splits).
    pub fn pid_of(&self, id: u32) -> Option<u32> {
        self.mirror.lock().unwrap().get(&id).map(|m| m.pid)
    }

    pub fn name_of(&self, id: u32) -> Option<String> {
        self.mirror.lock().unwrap().get(&id).map(|m| m.name.clone())
    }

    /// The pane's CURRENT kind (flag truth, not the id bit).
    pub fn pane_ephemeral(&self, id: u32) -> Option<bool> {
        self.mirror.lock().unwrap().get(&id).map(|m| m.ephemeral)
    }

    /// Flip a pane persistent in place (⌁→∞ "keep this shell").
    pub fn promote(&self, id: u32) {
        if let Some(m) = self.mirror.lock().unwrap().get_mut(&id) {
            m.ephemeral = false;
        }
        if let Some(c) = self.current() {
            c.set_ephemeral(id, false);
        }
    }

    /// Flip a pane throwaway in place (∞→⌁): it will die with this mymuxd
    /// (ptyd re-homes the pane to our connection on demotion).
    pub fn demote(&self, id: u32) {
        if let Some(m) = self.mirror.lock().unwrap().get_mut(&id) {
            m.ephemeral = true;
        }
        if let Some(c) = self.current() {
            c.set_ephemeral(id, true);
        }
    }

    pub fn remove_mirror(&self, id: u32) -> bool {
        self.mirror.lock().unwrap().remove(&id).is_some()
    }

    /// Drop all state after the ptyd connection died (its panes died with it).
    pub fn clear(&self) -> bool {
        *self.client.write().unwrap() = None;
        let mut m = self.mirror.lock().unwrap();
        let had = !m.is_empty();
        m.clear();
        had
    }

    fn current(&self) -> Option<Arc<Client>> {
        self.client.read().unwrap().clone()
    }

    /// On startup: if a ptyd socket already exists, adopt surviving panes.
    /// (Doesn't force-start ptyd — that happens on first use.)
    pub async fn warmup(&self, hub: &Arc<Hub>) {
        if socket_path().exists() && self.ensure(hub).await.is_ok() && !self.list().is_empty() {
            hub.emit(ServerEvent::State(hub.state_json()));
        }
    }

    /// Connected client, bootstrapping ptyd when needed.
    async fn ensure(&self, hub: &Arc<Hub>) -> Result<Arc<Client>, String> {
        if let Some(c) = self.current() {
            return Ok(c);
        }
        let _g = self.connect_lock.lock().await;
        if let Some(c) = self.current() {
            return Ok(c);
        }
        let path = socket_path();
        let mut tried_start = false;
        for _ in 0..25 {
            match Client::connect(&path).await {
                Ok((client, events)) => {
                    let listed = client.list().await.unwrap_or_default();
                    // Ephemeral panes must never survive a mymuxd restart.
                    // ptyd kills them when our old connection drops; sweeping
                    // here covers an old ptyd that kept them as plain panes.
                    // Kind = the FLAG (a promoted ⌁ is persistent and stays).
                    let (stale, panes): (Vec<_>, Vec<_>) =
                        listed.into_iter().partition(|p| p.is_ephemeral());
                    for p in &stale {
                        client.kill(p.id);
                    }
                    {
                        let mut m = self.mirror.lock().unwrap();
                        m.clear();
                        for p in &panes {
                            m.insert(
                                p.id,
                                PaneMeta {
                                    name: p.name.clone(),
                                    pid: p.pid,
                                    ephemeral: false, // survivors are persistent by definition
                                },
                            );
                        }
                    }
                    {
                        let mut n = self.next.lock().unwrap();
                        let max_low = panes.iter().map(|p| p.id & 0x3fff_ffff).max().unwrap_or(0);
                        *n = (*n).max(max_low + 1).max(1);
                    }
                    // Adopt the layout blob and reconcile it against the panes
                    // that actually survived, then persist the cleaned view.
                    let blob = client.get_meta().await.unwrap_or_default();
                    {
                        let mut nw = hub.natives.lock().unwrap();
                        *nw = NativeWindows::from_blob(&blob);
                        let alive: Vec<(u32, String, u16, u16)> = panes
                            .iter()
                            .map(|p| (p.id, p.name.clone(), p.cols, p.rows))
                            .collect();
                        nw.reconcile(&alive);
                        // The user's tab arrangement rides in the same blob;
                        // state_json prunes dead ids and appends new ones.
                        let order = NativeWindows::blob_order(&blob);
                        *hub.tab_order.lock().unwrap() = order.clone();
                        client.set_meta(nw.to_blob(&order));
                    }
                    *self.client.write().unwrap() = Some(client.clone());
                    tokio::spawn(pump(hub.clone(), events));
                    return Ok(client);
                }
                Err(_) => {
                    if !tried_start {
                        tried_start = true;
                        bootstrap_ptyd().await;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        Err("mymux-ptyd is unavailable".to_string())
    }

    pub async fn spawn_pane(
        &self,
        hub: &Arc<Hub>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        ephemeral: bool,
    ) -> Result<u32, String> {
        let client = self.ensure(hub).await?;
        let id = {
            let mut n = self.next.lock().unwrap();
            *n = (*n).max(1);
            let bit = if ephemeral { EPH_BIT } else { PERSIST_BIT };
            let id = bit | *n;
            *n += 1;
            id
        };
        let pid = client
            .spawn(
                id,
                cwd,
                cols,
                rows,
                String::new(),
                vec![("MYMUX_PANE".to_string(), id.to_string())],
                ephemeral,
            )
            .await?;
        // Empty name = unnamed; the UI/attach show the short numeric id then.
        self.mirror.lock().unwrap().insert(
            id,
            PaneMeta {
                name: String::new(),
                pid,
                ephemeral,
            },
        );
        Ok(id)
    }

    pub fn input(&self, id: u32, bytes: &[u8]) {
        if let Some(c) = self.current() {
            c.input(id, bytes);
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(c) = self.current() {
            c.resize(id, cols, rows);
        }
    }

    pub fn rename(&self, id: u32, name: String) {
        if let Some(m) = self.mirror.lock().unwrap().get_mut(&id) {
            m.name = name.clone();
        }
        if let Some(c) = self.current() {
            c.rename(id, name);
        }
    }

    pub fn kill(&self, id: u32) {
        self.remove_mirror(id);
        if let Some(c) = self.current() {
            c.kill(id);
        }
    }

    /// Store the native layout blob in ptyd (no-op while disconnected — an
    /// empty ptyd has nothing the blob could describe anyway).
    pub fn set_meta(&self, data: String) {
        if let Some(c) = self.current() {
            c.set_meta(data);
        }
    }

    pub async fn snapshot(&self, id: u32) -> Vec<u8> {
        match self.current() {
            Some(c) => c.snapshot(id).await.unwrap_or_default(),
            None => Vec::new(),
        }
    }
}

/// ptyd events → the Hub: output frames, pane exits, connection loss.
async fn pump(hub: Arc<Hub>, mut events: mpsc::UnboundedReceiver<PtydEvent>) {
    while let Some(ev) = events.recv().await {
        match ev {
            PtydEvent::Output { id, data } => {
                // Same as the tmux reader: feed the agent heuristics/stale-done
                // logic so native panes behave identically.
                hub.note_output(id, &data);
                hub.emit(ServerEvent::Output { pane: id, data });
            }
            PtydEvent::Exit { id } => {
                hub.clone().native_exited(id).await;
            }
            PtydEvent::Closed => {
                hub.persist_disconnected().await;
                break;
            }
        }
    }
}

/// Start ptyd: the systemd --user service when available, else a sibling
/// binary next to the current executable (dev builds). Never kill-on-drop —
/// ptyd must outlive us; that's its whole purpose.
async fn bootstrap_ptyd() {
    let via_systemd = tokio::process::Command::new("systemctl")
        .args(["--user", "start", "mymux-ptyd.service"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if via_systemd {
        return;
    }
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("mymux-ptyd")))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("mymux-ptyd"));
    let _ = tokio::process::Command::new(bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
