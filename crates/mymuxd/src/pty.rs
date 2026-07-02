//! Ephemeral (non-tmux) panes: a raw shell on a mymuxd-owned pty, shown as its
//! own top-level tab. Unlike tmux panes these are best-effort — they survive a WS
//! disconnect (the daemon holds them) but die with the daemon, and reseed from a
//! raw byte ring rather than a reconstructed screen. Routing keys off a high-bit
//! id so the rest of the daemon stays a single `is_ephemeral` test.

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

use crate::tmux::{Hub, ServerEvent};

/// High bit marks an ephemeral id, so it can never collide with tmux's small
/// monotonic `%N`/`@N` ids and routing is one test everywhere.
pub const EPH_BIT: u32 = 1 << 31;
pub fn is_ephemeral(id: u32) -> bool {
    id & EPH_BIT != 0
}

/// Cap on the per-pane best-effort reseed buffer (raw pty bytes).
const RING_CAP: usize = 256 * 1024;

struct Ephemeral {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    ring: Arc<Mutex<VecDeque<u8>>>,
    name: String,
}

impl Drop for Ephemeral {
    fn drop(&mut self) {
        // Ephemeral panes die with the daemon: kill and reap on removal.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct PtyManager {
    map: BTreeMap<u32, Ephemeral>,
    next: u32,
}

impl PtyManager {
    /// Spawn `$SHELL` on a fresh pty; stream its output to `tx` and schedule
    /// `Hub::ephemeral_exited` when it dies. Returns the new ephemeral id.
    pub fn spawn(
        &mut self,
        tx: broadcast::Sender<ServerEvent>,
        hub: Arc<Hub>,
        handle: tokio::runtime::Handle,
        cwd: Option<PathBuf>,
        cols: u16,
        rows: u16,
    ) -> Option<u32> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .ok()?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).ok()?;
        let reader = pair.master.try_clone_reader().ok()?;
        let writer = pair.master.take_writer().ok()?;
        let master = pair.master;
        drop(pair.slave); // so the master reader EOFs when the shell exits

        self.next += 1;
        let id = EPH_BIT | self.next;
        let ring = Arc::new(Mutex::new(VecDeque::with_capacity(4096)));

        // Reader thread: pty → ring + broadcast; on EOF schedule Hub cleanup.
        let ring2 = ring.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // shell exited / pty closed
                    Ok(n) => {
                        let chunk = &buf[..n];
                        {
                            let mut r = ring2.lock().unwrap();
                            r.extend(chunk.iter().copied());
                            let overflow = r.len().saturating_sub(RING_CAP);
                            r.drain(..overflow);
                        }
                        let _ = tx.send(ServerEvent::Output { pane: id, data: chunk.to_vec() });
                    }
                }
            }
            handle.spawn(hub.ephemeral_exited(id));
        });

        self.map.insert(
            id,
            Ephemeral {
                writer,
                master,
                child,
                ring,
                name: "shell".to_string(),
            },
        );
        Some(id)
    }

    pub fn contains(&self, id: u32) -> bool {
        self.map.contains_key(&id)
    }

    pub fn write(&mut self, id: u32, bytes: &[u8]) {
        if let Some(e) = self.map.get_mut(&id) {
            let _ = e.writer.write_all(bytes);
            let _ = e.writer.flush();
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(e) = self.map.get(&id) {
            let _ = e
                .master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// A clean-screen reseed of the pane's recent output (best effort — a raw
    /// byte replay, not a reconstructed screen like tmux `capture-pane`).
    pub fn ring_snapshot(&self, id: u32) -> Vec<u8> {
        match self.map.get(&id) {
            Some(e) => {
                let r = e.ring.lock().unwrap();
                let mut out = Vec::with_capacity(r.len() + 8);
                out.extend_from_slice(b"\x1b[2J\x1b[H");
                out.extend(r.iter().copied());
                out
            }
            None => Vec::new(),
        }
    }

    /// Remove (and thus kill + reap) an ephemeral; returns whether it existed.
    pub fn close(&mut self, id: u32) -> bool {
        self.map.remove(&id).is_some()
    }

    /// `(id, name)` for every live ephemeral, in id order.
    pub fn list(&self) -> Vec<(u32, String)> {
        self.map
            .iter()
            .map(|(&id, e)| (id, e.name.clone()))
            .collect()
    }
}
