//! The tmux side of the daemon: spawn one `tmux -C` control client, fold its
//! events into a [`Model`], and fan structured events ([`ServerEvent`]) out to
//! every connected UI. Input/resize/commands are written back on the same pipe.
//!
//! The control client is **restartable**: if the session ends (e.g. the user
//! types `exit`), the supervisor resets state so the next connection respawns it.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use mux_core::{ControlEvent, Model, Parser};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

use crate::state::build_state_json;

const SOCKET: &str = "mymux";
const SESSION: &str = "mymux";

/// tmux config sourced at server start (via `-f`) so the *first* pane is already
/// a capable, truecolor terminal — agent TUIs render poorly under `screen`.
const TMUX_CONF: &str = "\
set -g default-terminal \"tmux-256color\"
set -ga terminal-features \",*:RGB\"
set -g exit-empty off
setenv -g COLORTERM truecolor
";

/// A message fanned out to every connected UI.
#[derive(Clone)]
pub enum ServerEvent {
    /// Raw bytes from one pane (already un-escaped).
    Output { pane: u32, data: Vec<u8> },
    /// A pre-serialized `{"t":"state",...}` snapshot (structure changed).
    State(String),
}

#[derive(Default)]
struct TmuxState {
    running: bool,
    cmd_tx: Option<mpsc::Sender<String>>,
}

/// Shared bridge between the WebSocket clients and a single tmux control client.
pub struct Hub {
    events_tx: broadcast::Sender<ServerEvent>,
    state: Mutex<TmuxState>,
    model: Arc<Mutex<Model>>,
    conf_path: PathBuf,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (events_tx, _) = broadcast::channel(4096);
        let conf_path = std::env::temp_dir().join("mymux.tmux.conf");
        if let Err(e) = std::fs::write(&conf_path, TMUX_CONF) {
            eprintln!("mymuxd: could not write tmux config: {e}");
        }
        Arc::new(Self {
            events_tx,
            state: Mutex::new(TmuxState::default()),
            model: Arc::new(Mutex::new(Model::new())),
            conf_path,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.events_tx.subscribe()
    }

    /// Spawn the `tmux -C` control client if it isn't running. Called on every
    /// connection, so it also respawns after a session has ended.
    pub fn ensure_started(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.running {
            return;
        }

        let (cmd_tx, cmd_rx) = mpsc::channel::<String>(512);
        let conf = self.conf_path.to_string_lossy().into_owned();

        let spawn = Command::new("tmux")
            .args([
                "-L", SOCKET, "-f", conf.as_str(), "-C", "new-session", "-A", "-s", SESSION,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn();

        let mut child = match spawn {
            Ok(c) => c,
            Err(e) => {
                eprintln!("mymuxd: failed to spawn tmux: {e}");
                return;
            }
        };

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        state.running = true;
        state.cmd_tx = Some(cmd_tx);
        drop(state);

        // A fresh session means stale model state; start clean.
        *self.model.lock().unwrap() = Model::new();

        tokio::spawn(reader_loop(stdout, self.events_tx.clone(), self.model.clone()));
        tokio::spawn(writer_loop(stdin, cmd_rx));

        let hub = self.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            eprintln!("mymuxd: tmux control client exited: {status:?}");
            let mut state = hub.state.lock().unwrap();
            state.running = false;
            state.cmd_tx = None;
        });
    }

    async fn send_cmd(&self, cmd: String) {
        let tx = self.state.lock().unwrap().cmd_tx.clone();
        if let Some(tx) = tx {
            let _ = tx.send(cmd).await;
        }
    }

    /// Inject raw bytes into a specific pane via `send-keys -H`.
    pub async fn send_input(&self, pane: u32, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut cmd = format!("send-keys -t %{pane} -H");
        for b in bytes {
            cmd.push_str(&format!(" {b:02x}"));
        }
        self.send_cmd(cmd).await;
    }

    pub async fn focus(&self, pane: u32) {
        self.send_cmd(format!("select-pane -t %{pane}")).await;
    }

    pub async fn resize(&self, cols: u16, rows: u16) {
        self.send_cmd(format!("refresh-client -C {cols}x{rows}")).await;
    }

    pub async fn select_window(&self, id: u32) {
        self.send_cmd(format!("select-window -t @{id}")).await;
    }

    pub async fn new_window(&self) {
        self.send_cmd("new-window".to_string()).await;
    }

    pub async fn close_pane(&self, pane: u32) {
        self.send_cmd(format!("kill-pane -t %{pane}")).await;
    }

    pub async fn split(&self, pane: u32, horizontal: bool) {
        let flag = if horizontal { "-h" } else { "-v" };
        self.send_cmd(format!("split-window {flag} -t %{pane}")).await;
    }

    /// The current state snapshot as JSON (for initial sync / resync).
    pub fn state_json(&self) -> String {
        build_state_json(&self.model.lock().unwrap())
    }

    /// Snapshot one pane's current screen (with colors): clear+home + content.
    pub async fn snapshot_pane(&self, pane: u32) -> Vec<u8> {
        let out = Command::new("tmux")
            .args(["-L", SOCKET, "capture-pane", "-e", "-p", "-t", &format!("%{pane}")])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                let mut seed = b"\x1b[2J\x1b[H".to_vec();
                for (i, row) in o.stdout.split(|&b| b == b'\n').enumerate() {
                    if i > 0 {
                        seed.extend_from_slice(b"\r\n");
                    }
                    seed.extend_from_slice(row);
                }
                seed
            }
            _ => Vec::new(),
        }
    }

    /// Snapshot every pane in the active window: `(paneId, seedBytes)`.
    pub async fn snapshot_visible(&self) -> Vec<(u32, Vec<u8>)> {
        let panes: Vec<u32> = self
            .model
            .lock()
            .unwrap()
            .active_window_panes()
            .iter()
            .map(|p| p.0)
            .collect();
        let mut seeds = Vec::new();
        for p in panes {
            let seed = self.snapshot_pane(p).await;
            if !seed.is_empty() {
                seeds.push((p, seed));
            }
        }
        seeds
    }
}

async fn reader_loop(
    stdout: ChildStdout,
    events_tx: broadcast::Sender<ServerEvent>,
    model: Arc<Mutex<Model>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut parser = Parser::new();
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break, // EOF: tmux gone
            Ok(_) => {}
            Err(e) => {
                eprintln!("mymuxd: tmux read error: {e}");
                break;
            }
        }
        let l: &[u8] = if line.last() == Some(&b'\n') {
            &line[..line.len() - 1]
        } else {
            &line
        };
        let Some(ev) = parser.push_line(l) else {
            continue;
        };

        // Fold into the model; push a fresh state snapshot if structure changed.
        let changed = model.lock().unwrap().apply(&ev);
        if changed {
            let json = build_state_json(&model.lock().unwrap());
            let _ = events_tx.send(ServerEvent::State(json));
        }

        match ev {
            ControlEvent::Output { pane, data } => {
                let _ = events_tx.send(ServerEvent::Output { pane: pane.0, data });
            }
            ControlEvent::Exit { reason } => {
                eprintln!("mymuxd: tmux %exit ({reason:?})");
                break;
            }
            _ => {}
        }
    }
}

async fn writer_loop(mut stdin: ChildStdin, mut cmd_rx: mpsc::Receiver<String>) {
    while let Some(cmd) = cmd_rx.recv().await {
        if stdin.write_all(cmd.as_bytes()).await.is_err()
            || stdin.write_all(b"\n").await.is_err()
            || stdin.flush().await.is_err()
        {
            break;
        }
    }
}
