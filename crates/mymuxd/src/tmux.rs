//! The tmux side of the daemon: spawn one `tmux -C` control client, broadcast
//! its pane output to all connected UIs, and forward UI input/resize back as
//! tmux commands on the same pipe.

use std::process::Stdio;
use std::sync::{Arc, Mutex};

use mux_core::{ControlEvent, Parser};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

/// Shared bridge between the WebSocket clients and a single tmux control client.
pub struct Hub {
    /// Raw pane bytes from tmux, fanned out to every connected UI.
    output_tx: broadcast::Sender<Vec<u8>>,
    /// Commands to write on tmux's stdin (`send-keys`, `refresh-client`, ...).
    cmd_tx: mpsc::Sender<String>,
    /// Parked until the first connection spawns tmux.
    cmd_rx: Mutex<Option<mpsc::Receiver<String>>>,
    started: Mutex<bool>,
    socket: String,
    session: String,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (output_tx, _) = broadcast::channel(4096);
        let (cmd_tx, cmd_rx) = mpsc::channel(512);
        Arc::new(Self {
            output_tx,
            cmd_tx,
            cmd_rx: Mutex::new(Some(cmd_rx)),
            started: Mutex::new(false),
            socket: "mymux".to_string(),
            session: "mymux".to_string(),
        })
    }

    /// Subscribe to pane output. Subscribe *before* calling [`Hub::ensure_started`]
    /// so the first client sees the session from its very first byte.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    /// Spawn `tmux -C` once. Idempotent: later calls are no-ops.
    pub fn ensure_started(self: &Arc<Self>) {
        let mut started = self.started.lock().unwrap();
        if *started {
            return;
        }
        let Some(cmd_rx) = self.cmd_rx.lock().unwrap().take() else {
            return;
        };

        // `new-session -A` attaches if the session already exists (persistence),
        // else creates it. `-C` puts the client in control mode over stdio.
        let spawn = Command::new("tmux")
            .args([
                "-L", &self.socket, "-C", "new-session", "-A", "-s", &self.session,
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
        *started = true;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        tokio::spawn(reader_loop(stdout, self.output_tx.clone()));
        tokio::spawn(writer_loop(stdin, cmd_rx));
        tokio::spawn(async move {
            let status = child.wait().await;
            eprintln!("mymuxd: tmux control client exited: {status:?}");
        });
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
        let _ = self.cmd_tx.send(cmd).await;
    }

    /// Set the control client's size; tmux resizes panes and emits a layout.
    pub async fn resize(&self, cols: u16, rows: u16) {
        let _ = self
            .cmd_tx
            .send(format!("refresh-client -C {cols}x{rows}"))
            .await;
    }

    /// Nudge the active pane to redraw (Ctrl-L) so a fresh attach paints.
    /// TODO(M2): replace with a proper screen reseed (`capture-pane -ep`).
    pub async fn repaint(&self) {
        let _ = self.cmd_tx.send("send-keys -H 0c".to_string()).await;
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
