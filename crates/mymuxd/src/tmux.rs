//! The tmux side of the daemon: spawn one `tmux -C` control client, broadcast
//! its pane output to all connected UIs, and forward UI input/resize back as
//! tmux commands on the same pipe.
//!
//! The control client is **restartable**: if the session ends (e.g. the user
//! types `exit`), the supervisor resets state so the next connection respawns it.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use mux_core::{ControlEvent, Parser};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

const SOCKET: &str = "mymux";
const SESSION: &str = "mymux";

/// tmux config sourced at server start (via `-f`) so the *first* pane is already
/// a capable, truecolor terminal — Ink-based agent TUIs (Claude Code, Codex)
/// render poorly under the default `screen` terminfo.
const TMUX_CONF: &str = "\
set -g default-terminal \"tmux-256color\"
set -ga terminal-features \",*:RGB\"
set -g exit-empty off
setenv -g COLORTERM truecolor
";

#[derive(Default)]
struct TmuxState {
    running: bool,
    /// Sender to the current tmux child's stdin; `None` when not running.
    cmd_tx: Option<mpsc::Sender<String>>,
}

/// Shared bridge between the WebSocket clients and a single tmux control client.
pub struct Hub {
    /// Raw pane bytes from tmux, fanned out to every connected UI.
    output_tx: broadcast::Sender<Vec<u8>>,
    state: Mutex<TmuxState>,
    conf_path: PathBuf,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (output_tx, _) = broadcast::channel(4096);
        // Write the tmux config once; on failure tmux just uses its defaults.
        let conf_path = std::env::temp_dir().join("mymux.tmux.conf");
        if let Err(e) = std::fs::write(&conf_path, TMUX_CONF) {
            eprintln!("mymuxd: could not write tmux config: {e}");
        }
        Arc::new(Self {
            output_tx,
            state: Mutex::new(TmuxState::default()),
            conf_path,
        })
    }

    /// Subscribe to pane output. Subscribe *before* [`Hub::ensure_started`] so a
    /// fresh first client sees the session from its very first byte.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    /// Spawn the `tmux -C` control client if it isn't already running. Called on
    /// every connection, so it also respawns after a session has ended.
    pub fn ensure_started(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.running {
            return;
        }

        let (cmd_tx, cmd_rx) = mpsc::channel::<String>(512);
        let conf = self.conf_path.to_string_lossy().into_owned();

        // `-f conf` is sourced before the session is created, so the first pane
        // is already tmux-256color/truecolor. `new-session -A` attaches if the
        // session exists (persistence) else creates it. `-C` = control mode.
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

        tokio::spawn(reader_loop(stdout, self.output_tx.clone()));
        tokio::spawn(writer_loop(stdin, cmd_rx));

        // Supervisor: when tmux exits, reset so the next connection respawns it.
        let hub = self.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            eprintln!("mymuxd: tmux control client exited: {status:?}");
            let mut state = hub.state.lock().unwrap();
            state.running = false;
            state.cmd_tx = None;
        });
    }

    /// Queue a command for tmux's stdin. No-op if tmux isn't running.
    async fn send_cmd(&self, cmd: String) {
        let tx = self.state.lock().unwrap().cmd_tx.clone();
        if let Some(tx) = tx {
            let _ = tx.send(cmd).await;
        }
    }

    /// Inject raw bytes as keystrokes into the active pane via `send-keys -H`.
    pub async fn send_input(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut cmd = String::from("send-keys -H");
        for b in bytes {
            cmd.push_str(&format!(" {b:02x}"));
        }
        self.send_cmd(cmd).await;
    }

    /// Set the control client's size; tmux resizes panes and emits a layout.
    pub async fn resize(&self, cols: u16, rows: u16) {
        self.send_cmd(format!("refresh-client -C {cols}x{rows}")).await;
    }

    /// Snapshot the active pane's current screen (with colors) so a newly
    /// connected client paints the real state instead of a blank terminal.
    /// Returns clear+home followed by the captured screen, or empty on failure.
    pub async fn snapshot(&self) -> Vec<u8> {
        let out = Command::new("tmux")
            .args(["-L", SOCKET, "capture-pane", "-e", "-p", "-t", SESSION])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                let mut seed = b"\x1b[2J\x1b[H".to_vec();
                // capture-pane joins rows with '\n'; a terminal needs '\r\n'.
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
}

async fn reader_loop(stdout: ChildStdout, output_tx: broadcast::Sender<Vec<u8>>) {
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
        if let Some(ev) = parser.push_line(l) {
            match ev {
                ControlEvent::Output { data, .. } => {
                    // Ignore "no subscribers" — first client subscribes first.
                    let _ = output_tx.send(data);
                }
                ControlEvent::Exit { reason } => {
                    eprintln!("mymuxd: tmux %exit ({reason:?})");
                    break;
                }
                // M1+: fold the rest into a Model and push window/pane/layout
                // and agent-state updates to the UI.
                _ => {}
            }
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
