//! The tmux side of the daemon: spawn one `tmux -C` control client, fold its
//! events into a [`Model`], and fan structured events ([`ServerEvent`]) out to
//! every connected UI. Input/resize/commands are written back on the same pipe.
//!
//! The control client is **restartable**: if the session ends (e.g. the user
//! types `exit`), the supervisor resets state so the next connection respawns it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mux_core::{parse_layout, ControlEvent, Model, PaneId, Parser, WindowId};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

use crate::agent::{AgentEntry, AgentState, Source};
use crate::pty::{is_ephemeral, PtyManager};
use crate::state::build_state_json;

/// tmux control socket (`tmux -L <socket>`). Overridable via `MYMUX_SOCKET` so a
/// test or second instance can run without colliding with the default `mymux`.
pub(crate) fn socket() -> &'static str {
    static SOCKET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SOCKET
        .get_or_init(|| std::env::var("MYMUX_SOCKET").unwrap_or_else(|_| "mymux".into()))
        .as_str()
}
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

/// Raw per-pane signals the heuristics read (for un-hooked agents).
struct PaneHeur {
    alt: bool,
    last_activity: Instant,
    last_bell: Option<Instant>,
}

/// Agent badges (hook + heuristic) plus the raw signals heuristics use.
#[derive(Default)]
struct AgentTracker {
    entries: BTreeMap<u32, AgentEntry>,
    heur: BTreeMap<u32, PaneHeur>,
}

/// Which view the shared UI is showing: a tmux window, or an ephemeral pty tab.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ActiveView {
    Tmux,
    Ephemeral(u32),
}

/// Shared bridge between the WebSocket clients and a single tmux control client.
pub struct Hub {
    events_tx: broadcast::Sender<ServerEvent>,
    state: Mutex<TmuxState>,
    model: Arc<Mutex<Model>>,
    /// Agent badges (hook reports + heuristics) and per-pane heuristic signals.
    agents: Mutex<AgentTracker>,
    conf_path: PathBuf,
    /// Ephemeral (non-tmux) pty panes, keyed by high-bit id.
    ptys: Mutex<PtyManager>,
    /// Whether the UI is showing tmux or an ephemeral tab (one shared view).
    active_view: Mutex<ActiveView>,
    /// Last whole-window size (cols, rows) the UI reported — the sizer for
    /// ephemeral panes, which tmux does not lay out.
    last_size: Mutex<(u16, u16)>,
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
            agents: Mutex::new(AgentTracker::default()),
            conf_path,
            ptys: Mutex::new(PtyManager::default()),
            active_view: Mutex::new(ActiveView::Tmux),
            last_size: Mutex::new((80, 24)),
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
                "-L", socket(), "-f", conf.as_str(), "-C", "new-session", "-A", "-s", SESSION,
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
        if is_ephemeral(pane) {
            self.ptys.lock().unwrap().write(pane, bytes);
            return;
        }
        let mut cmd = format!("send-keys -t %{pane} -H");
        for b in bytes {
            cmd.push_str(&format!(" {b:02x}"));
        }
        self.send_cmd(cmd).await;
    }

    pub async fn focus(&self, pane: u32) {
        if is_ephemeral(pane) {
            return;
        }
        self.send_cmd(format!("select-pane -t %{pane}")).await;
    }

    /// Move focus to the pane in a direction (`L`/`R`/`U`/`D`).
    pub async fn select_pane_dir(&self, dir: &str) {
        if matches!(*self.active_view.lock().unwrap(), ActiveView::Ephemeral(_)) {
            return;
        }
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
        *self.last_size.lock().unwrap() = (cols, rows);
        let view = *self.active_view.lock().unwrap();
        if let ActiveView::Ephemeral(id) = view {
            self.ptys.lock().unwrap().resize(id, cols, rows);
        }
        // Keep tmux sized too, so switching back to a tmux window needs no resync.
        self.send_cmd(format!("refresh-client -C {cols}x{rows}")).await;
    }

    pub async fn select_window(&self, id: u32) {
        if is_ephemeral(id) {
            if !self.ptys.lock().unwrap().contains(id) {
                return;
            }
            *self.active_view.lock().unwrap() = ActiveView::Ephemeral(id);
            self.emit(ServerEvent::State(self.state_json()));
            let seed = self.ptys.lock().unwrap().ring_snapshot(id);
            if !seed.is_empty() {
                self.emit(ServerEvent::Output { pane: id, data: seed });
            }
            return;
        }
        // Leaving any ephemeral view; if tmux is already on this window it emits
        // no change event, so repaint from the (already-correct) model ourselves.
        let cur = self.model.lock().unwrap().active_window.map(|w| w.0);
        *self.active_view.lock().unwrap() = ActiveView::Tmux;
        self.send_cmd(format!("select-window -t @{id}")).await;
        if cur == Some(id) {
            self.emit(ServerEvent::State(self.state_json()));
            for (pane, seed) in self.snapshot_visible().await {
                self.emit(ServerEvent::Output { pane, data: seed });
            }
        }
    }

    pub async fn new_window(&self) {
        // Open in the active pane's directory, not the tmux server's start dir.
        self.send_cmd("new-window -c \"#{pane_current_path}\"".to_string())
            .await;
    }

    pub async fn close_pane(&self, pane: u32) {
        if is_ephemeral(pane) {
            let was_active = matches!(
                *self.active_view.lock().unwrap(),
                ActiveView::Ephemeral(x) if x == pane
            );
            self.ptys.lock().unwrap().close(pane);
            if was_active {
                *self.active_view.lock().unwrap() = ActiveView::Tmux;
            }
            self.emit(ServerEvent::State(self.state_json()));
            if was_active {
                for (p, seed) in self.snapshot_visible().await {
                    self.emit(ServerEvent::Output { pane: p, data: seed });
                }
            }
            return;
        }
        self.send_cmd(format!("kill-pane -t %{pane}")).await;
    }

    pub async fn split(&self, pane: u32, horizontal: bool) {
        if is_ephemeral(pane) {
            return;
        }
        let flag = if horizontal { "-h" } else { "-v" };
        self.send_cmd(format!("split-window {flag} -c \"#{{pane_current_path}}\" -t %{pane}"))
            .await;
    }

    /// The current state snapshot as JSON (for initial sync / resync).
    pub fn state_json(&self) -> String {
        let ephemerals = self.ptys.lock().unwrap().list();
        let active_ephemeral = match *self.active_view.lock().unwrap() {
            ActiveView::Ephemeral(id) => Some(id),
            ActiveView::Tmux => None,
        };
        let size = *self.last_size.lock().unwrap();
        let model = self.model.lock().unwrap();
        let agents = self.agents.lock().unwrap();
        let view: BTreeMap<u32, AgentState> =
            agents.entries.iter().map(|(&p, e)| (p, e.state)).collect();
        build_state_json(&model, &view, &ephemerals, active_ephemeral, size)
    }

    /// Update an agent's hook-reported state (`None` clears it), then broadcast.
    pub fn set_agent(&self, pane: u32, state: Option<AgentState>) {
        {
            let mut agents = self.agents.lock().unwrap();
            match state {
                Some(s) => {
                    agents.entries.insert(pane, AgentEntry { state: s, source: Source::Hook });
                }
                None => {
                    agents.entries.remove(&pane);
                }
            }
        }
        self.emit(ServerEvent::State(self.state_json()));
    }

    /// Fold a pane's output into the heuristic signals (alt-screen, activity, bell).
    fn note_output(&self, pane: u32, data: &[u8]) {
        let now = Instant::now();
        let alt_on = contains(data, b"\x1b[?1049h");
        let alt_off = contains(data, b"\x1b[?1049l");
        let bell = data.contains(&0x07);
        let cleared_done;
        {
            let mut agents = self.agents.lock().unwrap();
            let h = agents.heur.entry(pane).or_insert(PaneHeur {
                alt: false,
                last_activity: now,
                last_bell: None,
            });
            h.last_activity = now;
            if alt_on {
                h.alt = true;
            }
            if alt_off {
                h.alt = false;
            }
            if bell {
                h.last_bell = Some(now);
            }
            // Fresh output means the pane is active again, so a stale "done" badge
            // (e.g. from Codex's turn-complete notify) is wrong — clear it and let
            // the hook / heuristic re-establish the live state.
            cleared_done = agents.entries.get(&pane).map(|e| e.state) == Some(AgentState::Done);
            if cleared_done {
                agents.entries.remove(&pane);
            }
        }
        if cleared_done {
            self.emit(ServerEvent::State(self.state_json()));
        }
    }

    /// Recompute heuristic badges for background full-screen panes (hook reports
    /// always win; the window you're currently viewing gets no badge).
    fn run_heuristics(&self) {
        const IDLE: Duration = Duration::from_secs(8);
        const BELL_WINDOW: Duration = Duration::from_secs(25);
        let now = Instant::now();
        let active: BTreeSet<u32> = self
            .model
            .lock()
            .unwrap()
            .active_window_panes()
            .iter()
            .map(|p| p.0)
            .collect();

        let mut changed = false;
        {
            let mut agents = self.agents.lock().unwrap();
            let panes: Vec<u32> = agents.heur.keys().copied().collect();
            for p in panes {
                if agents.entries.get(&p).map(|e| e.source) == Some(Source::Hook) {
                    continue; // hooks own this pane
                }
                let (alt, last_activity, last_bell) = {
                    let h = &agents.heur[&p];
                    (h.alt, h.last_activity, h.last_bell)
                };
                let desired = if active.contains(&p) || !alt {
                    None
                } else if now.duration_since(last_activity) > IDLE {
                    let belled = last_bell.is_some_and(|b| now.duration_since(b) < BELL_WINDOW);
                    Some(if belled { AgentState::Waiting } else { AgentState::Done })
                } else {
                    Some(AgentState::Running)
                };
                if agents.entries.get(&p).map(|e| e.state) != desired {
                    match desired {
                        Some(s) => {
                            agents
                                .entries
                                .insert(p, AgentEntry { state: s, source: Source::Heuristic });
                        }
                        None => {
                            agents.entries.remove(&p);
                        }
                    }
                    changed = true;
                }
            }
        }
        if changed {
            self.emit(ServerEvent::State(self.state_json()));
        }
    }

    /// Clear "done" badges for the active window's panes — you've now seen them.
    fn clear_done_on_focus(&self) {
        let panes: Vec<u32> = self
            .model
            .lock()
            .unwrap()
            .active_window_panes()
            .iter()
            .map(|p| p.0)
            .collect();
        let mut changed = false;
        {
            let mut agents = self.agents.lock().unwrap();
            for p in &panes {
                if agents.entries.get(p).map(|e| e.state) == Some(AgentState::Done) {
                    agents.entries.remove(p);
                    changed = true;
                }
            }
        }
        if changed {
            self.emit(ServerEvent::State(self.state_json()));
        }
    }

    /// Snapshot one pane's current screen (with colors): clear+home + content,
    /// then restore the real cursor position (capture-pane loses it — without
    /// this the prompt/cursor ends up stuck at the bottom of the pane).
    pub async fn snapshot_pane(&self, pane: u32) -> Vec<u8> {
        let target = format!("%{pane}");
        let cap = Command::new("tmux")
            .args(["-L", socket(), "capture-pane", "-e", "-p", "-t", &target])
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
                "-L", socket(), "display-message", "-p", "-t", target,
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
        // An ephemeral tab reseeds from its raw ring, not from tmux.
        let view = *self.active_view.lock().unwrap();
        if let ActiveView::Ephemeral(id) = view {
            let seed = self.ptys.lock().unwrap().ring_snapshot(id);
            return if seed.is_empty() { Vec::new() } else { vec![(id, seed)] };
        }
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
                "-L", socket(), "list-windows", "-F",
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

    /// Every pane across all windows with its shell pid, for the process tree:
    /// `(window_id, pane_id, pane_pid, window_name)`.
    pub async fn pane_pids(&self) -> Vec<(u32, u32, u32, String)> {
        let out = Command::new("tmux")
            .args([
                "-L", socket(), "list-panes", "-a", "-F",
                "#{window_id} #{pane_id} #{pane_pid} #{window_name}",
            ])
            .output()
            .await;
        let Ok(o) = out else { return Vec::new() };
        if !o.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&o.stdout);
        let mut rows = Vec::new();
        for line in text.lines() {
            // "@0 %1 12345 window name" — window_name may contain spaces (last field).
            let mut it = line.splitn(4, ' ');
            let (Some(w), Some(p), Some(pid)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let name = it.next().unwrap_or("").to_string();
            let (Some(wid), Some(pane), Ok(pid)) =
                (WindowId::parse(w), PaneId::parse(p), pid.parse::<u32>())
            else {
                continue;
            };
            rows.push((wid.0, pane.0, pid, name));
        }
        // Ephemeral shells appear as their own single-pane "window".
        for (id, pid, name) in self.ptys.lock().unwrap().entries() {
            rows.push((id, id, pid, name));
        }
        rows
    }

    /// Spawn a new ephemeral (raw, non-tmux) shell tab and switch to it.
    pub async fn new_ephemeral(self: &Arc<Self>) {
        let cwd = self.active_pane_cwd().await;
        let (cols, rows) = *self.last_size.lock().unwrap();
        let handle = tokio::runtime::Handle::current();
        let id = self.ptys.lock().unwrap().spawn(
            self.events_tx.clone(),
            self.clone(),
            handle,
            cwd,
            cols,
            rows,
        );
        let Some(id) = id else {
            eprintln!("mymuxd: failed to spawn ephemeral shell");
            return;
        };
        *self.active_view.lock().unwrap() = ActiveView::Ephemeral(id);
        self.emit(ServerEvent::State(self.state_json()));
    }

    /// Called (from the pty reader thread) when an ephemeral shell exits: drop it
    /// and, if it was the visible view, fall back to tmux and repaint.
    pub async fn ephemeral_exited(self: Arc<Self>, id: u32) {
        if !self.ptys.lock().unwrap().close(id) {
            return;
        }
        let was_active =
            matches!(*self.active_view.lock().unwrap(), ActiveView::Ephemeral(x) if x == id);
        if was_active {
            *self.active_view.lock().unwrap() = ActiveView::Tmux;
        }
        self.emit(ServerEvent::State(self.state_json()));
        if was_active {
            for (pane, seed) in self.snapshot_visible().await {
                self.emit(ServerEvent::Output { pane, data: seed });
            }
        }
    }

    /// The active tmux pane's cwd, to root a new ephemeral shell nearby.
    async fn active_pane_cwd(&self) -> Option<PathBuf> {
        let pane = self.model.lock().unwrap().active_pane?;
        let out = Command::new("tmux")
            .args([
                "-L", socket(), "display-message", "-p", "-t",
                &format!("%{}", pane.0), "#{pane_current_path}",
            ])
            .output()
            .await
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!p.is_empty()).then(|| PathBuf::from(p))
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
                hub.note_output(pane.0, &data);
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
            if switched {
                hub.clear_done_on_focus();
            }
        }
    }
}

/// True if `needle` occurs in `hay`.
fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.len() >= needle.len() && hay.windows(needle.len()).any(|w| w == needle)
}

/// Periodically recompute heuristic agent badges for un-hooked panes.
pub async fn heuristic_sweep(hub: Arc<Hub>) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        hub.run_heuristics();
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
