//! Ephemeral (non-tmux) panes: a raw shell on a mymuxd-owned pty, shown as its
//! own top-level tab. They survive a WS disconnect (the daemon holds them) but
//! die with the daemon, and reseed from a server-side terminal grid
//! ([`PaneGrid`]) — full colors/cursor/alt-screen fidelity, same as tmux panes.
//! Routing keys off a high-bit id so the rest of the daemon stays a single
//! `is_ephemeral` test.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

use crate::tmux::{Hub, ServerEvent};
use mymux_ptyd::grid::PaneGrid;

/// High bit marks an ephemeral id, so it can never collide with tmux's small
/// monotonic `%N`/`@N` ids and routing is one test everywhere.
pub const EPH_BIT: u32 = 1 << 31;
pub fn is_ephemeral(id: u32) -> bool {
    id & EPH_BIT != 0
}

struct Ephemeral {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    child_pid: u32,
    /// Server-side terminal state; the reseed source.
    grid: Arc<Mutex<PaneGrid>>,
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
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;

        self.next += 1;
        let id = EPH_BIT | self.next;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // A raw shell is not inside tmux — strip inherited tmux markers so it
        // doesn't behave as a nested session (the daemon may itself run in tmux).
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");
        // Let an agent's hook report which pane it's in — there's no $TMUX_PANE here.
        cmd.env("MYMUX_PANE", id.to_string());
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).ok()?;
        let child_pid = child.process_id().unwrap_or(0);
        let reader = pair.master.try_clone_reader().ok()?;
        let writer = pair.master.take_writer().ok()?;
        let master = pair.master;
        drop(pair.slave); // so the master reader EOFs when the shell exits

        let grid = Arc::new(Mutex::new(PaneGrid::new(cols, rows)));

        // Reader thread: pty → grid + broadcast; on EOF schedule Hub cleanup.
        let grid2 = grid.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // shell exited / pty closed
                    Ok(n) => {
                        let chunk = &buf[..n];
                        grid2.lock().unwrap().feed(chunk);
                        let _ = tx.send(ServerEvent::Output {
                            pane: id,
                            data: chunk.to_vec(),
                        });
                    }
                }
            }
            handle.spawn(hub.native_exited(id));
        });

        self.map.insert(
            id,
            Ephemeral {
                writer,
                master,
                child,
                child_pid,
                grid,
                name: String::new(), // unnamed → UI shows the short numeric id
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
            let _ = e.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            e.grid.lock().unwrap().resize(cols, rows);
        }
    }

    pub fn rename(&mut self, id: u32, name: String) {
        if let Some(e) = self.map.get_mut(&id) {
            e.name = name;
        }
    }

    /// A faithful reseed of the pane's terminal state (grid + colors + cursor +
    /// alt screen), safe to send to a fresh or mid-state client terminal.
    pub fn snapshot(&self, id: u32) -> Vec<u8> {
        match self.map.get(&id) {
            Some(e) => e.grid.lock().unwrap().snapshot(),
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

    /// `(id, shell_pid, name)` for every live ephemeral (for the process tree).
    pub fn entries(&self) -> Vec<(u32, u32, String)> {
        self.map
            .iter()
            .map(|(&id, e)| (id, e.child_pid, e.name.clone()))
            .collect()
    }
}
