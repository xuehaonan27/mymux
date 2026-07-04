//! Bridge to mymux-ptyd: **persistent** native panes survive mymuxd restarts
//! because the tiny holder daemon owns their PTYs and terminal grids. mymuxd
//! reconnects on startup, adopts whatever panes survived, and keeps routing.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};

use mymux_ptyd::client::{Client, PtydEvent};
use mymux_ptyd::proto::socket_path;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::pty::EPH_BIT;
use crate::tmux::{Hub, ServerEvent};

/// Bit 30 marks a ptyd-backed persistent pane (bit 31 = local ephemeral).
pub const PERSIST_BIT: u32 = 1 << 30;
pub fn is_persistent(id: u32) -> bool {
    id & PERSIST_BIT != 0 && id & EPH_BIT == 0
}

#[derive(Default)]
pub struct Persist {
    client: RwLock<Option<Arc<Client>>>,
    connect_lock: AsyncMutex<()>,
    /// Live persistent panes as we know them — `id → (name, shell pid)` — kept
    /// in step with ptyd via the resync-on-connect List plus spawn/exit events.
    mirror: Mutex<BTreeMap<u32, (String, u32)>>,
    next: Mutex<u32>,
}

impl Persist {
    pub fn list(&self) -> Vec<(u32, String)> {
        self.mirror.lock().unwrap().iter().map(|(&id, (n, _))| (id, n.clone())).collect()
    }

    /// `(id, shell pid, name)` for the process tree + scoped-kill allow-set.
    pub fn pids(&self) -> Vec<(u32, u32, String)> {
        self.mirror
            .lock()
            .unwrap()
            .iter()
            .map(|(&id, (n, pid))| (id, *pid, n.clone()))
            .collect()
    }

    pub fn contains(&self, id: u32) -> bool {
        self.mirror.lock().unwrap().contains_key(&id)
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
                    let panes = client.list().await.unwrap_or_default();
                    {
                        let mut m = self.mirror.lock().unwrap();
                        m.clear();
                        for p in &panes {
                            m.insert(p.id, (p.name.clone(), p.pid));
                        }
                    }
                    {
                        let mut n = self.next.lock().unwrap();
                        let max_low =
                            panes.iter().map(|p| p.id & !PERSIST_BIT).max().unwrap_or(0);
                        *n = (*n).max(max_low + 1).max(1);
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
    ) -> Result<u32, String> {
        let client = self.ensure(hub).await?;
        let id = {
            let mut n = self.next.lock().unwrap();
            *n = (*n).max(1);
            let id = PERSIST_BIT | *n;
            *n += 1;
            id
        };
        let pid = client
            .spawn(id, cwd, cols, rows, "shell".to_string(), vec![
                ("MYMUX_PANE".to_string(), id.to_string()),
            ])
            .await?;
        self.mirror.lock().unwrap().insert(id, ("shell".to_string(), pid));
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

    pub fn kill(&self, id: u32) {
        self.remove_mirror(id);
        if let Some(c) = self.current() {
            c.kill(id);
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
