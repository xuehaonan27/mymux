//! The tmux side of the daemon: spawn one `tmux -C` control client, fold its
//! events into a [`Model`], and fan structured events ([`ServerEvent`]) out to
//! every connected UI. Input/resize/commands are written back on the same pipe.
//!
//! The control client is **restartable**: if the session ends (e.g. the user
//! types `exit`), the supervisor resets state so the next connection respawns it.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use mux_core::{parse_layout, ControlEvent, Model, Parser, WindowId};
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

    fn emit(&self, ev: ServerEvent) {
        let _ = self.events_tx.send(ev);
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

        tokio::spawn(reader_loop(stdout, self.clone()));
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

    /// Move focus to the pane in a direction (`L`/`R`/`U`/`D`).
    pub async fn select_pane_dir(&self, dir: &str) {
        let flag = match dir {
            "L" => "-L",
            "R" => "-R",
            "U" => "-U",
            "D" => "-D",
            _ => return,
        };
        self.send_cmd(format!("select-pane {flag}")).await;
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

    /// Snapshot one pane's current screen (with colors): clear+home + content,
    /// then restore the real cursor position (capture-pane loses it — without
    /// this the prompt/cursor ends up stuck at the bottom of the pane).
    pub async fn snapshot_pane(&self, pane: u32) -> Vec<u8> {
        let target = format!("%{pane}");
        let cap = Command::new("tmux")
            .args(["-L", SOCKET, "capture-pane", "-e", "-p", "-t", &target])
            .output()
            .await;
        let Ok(cap) = cap else { return Vec::new() };
        if !cap.status.success() {
            return Vec::new();
        }
        let (cy, cx, alt) = self.pane_state(&target).await;

        let mut seed = Vec::new();
        if alt {
            // Match tmux's alternate-screen state so that when the full-screen
            // app later exits (emitting ?1049l) xterm restores the primary
            // buffer, instead of leaving stale content behind. Without this a
            // client that (re)connects while vim/less/claude is running desyncs
            // its buffers from tmux.
            seed.extend_from_slice(b"\x1b[?1049h");
        }
        seed.extend_from_slice(b"\x1b[2J\x1b[H");
        // Drop one trailing newline so we don't paint an extra row (which would
        // scroll the top line away).
        let content = cap.stdout.strip_suffix(b"\n").unwrap_or(&cap.stdout);
        for (i, row) in content.split(|&b| b == b'\n').enumerate() {
            if i > 0 {
                seed.extend_from_slice(b"\r\n");
            }
            seed.extend_from_slice(row);
        }
        seed.extend_from_slice(format!("\x1b[{};{}H", cy + 1, cx + 1).as_bytes());
        seed
    }

    /// The pane's cursor position (0-based `row, col`) and whether it is on the
    /// alternate screen.
    async fn pane_state(&self, target: &str) -> (u32, u32, bool) {
        let out = Command::new("tmux")
            .args([
                "-L", SOCKET, "display-message", "-p", "-t", target,
                "#{cursor_y} #{cursor_x} #{alternate_on}",
            ])
            .output()
            .await;
        if let Ok(o) = out {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout);
                let mut it = s.split_whitespace();
                let cy = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let cx = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                let alt = it.next() == Some("1");
                return (cy, cx, alt);
            }
        }
        (0, 0, false)
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

    /// Pull every window's name + layout from tmux. Control mode does not push a
    /// `%layout-change` for a bare `new-window`, so the model would otherwise
    /// have no geometry for freshly created windows.
    pub async fn refresh_layouts(&self) {
        let out = Command::new("tmux")
            .args([
                "-L", SOCKET, "list-windows", "-F",
                "#{window_id} #{window_name} #{window_layout}",
            ])
            .output()
            .await;
        let Ok(o) = out else { return };
        if !o.status.success() {
            return;
        }
        let text = String::from_utf8_lossy(&o.stdout);
        let mut m = self.model.lock().unwrap();
        for line in text.lines() {
            let mut it = line.splitn(3, ' ');
            let (Some(id), Some(name), Some(layout)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            if let Some(wid) = WindowId::parse(id) {
                let info = m.windows.entry(wid).or_default();
                info.name = Some(name.to_string());
                info.layout = parse_layout(layout);
            }
        }
    }
}

async fn reader_loop(stdout: ChildStdout, hub: Arc<Hub>) {
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

        // Fold into the model; note whether structure changed / window switched.
        let (changed, switched) = {
            let mut m = hub.model.lock().unwrap();
            let prev = m.active_window;
            let changed = m.apply(&ev);
            (changed, m.active_window != prev)
        };
        if changed {
            hub.emit(ServerEvent::State(hub.state_json()));
        }

        let topology = switched || matches!(ev, ControlEvent::WindowAdd { .. });

        match ev {
            ControlEvent::Output { pane, data } => {
                hub.emit(ServerEvent::Output { pane: pane.0, data });
            }
            ControlEvent::Exit { reason } => {
                eprintln!("mymuxd: tmux %exit ({reason:?})");
                break;
            }
            _ => {}
        }

        // A new or switched window: tmux doesn't push a layout for a bare
        // new-window, and never replays a background window's screen. Pull
        // layouts from tmux, push fresh state, then repaint the visible panes.
        if topology {
            // Inline (not spawned) so the refreshed layout lands in the model
            // before any later event builds its state — kills empty-layout races.
            hub.refresh_layouts().await;
            hub.emit(ServerEvent::State(hub.state_json()));
            for (pane, seed) in hub.snapshot_visible().await {
                hub.emit(ServerEvent::Output { pane, data: seed });
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
