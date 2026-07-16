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

use mux_core::{parse_layout, CellKind, ControlEvent, LayoutCell, Model, PaneId, Parser, WindowId};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc};

use crate::agent::{AgentEntry, AgentState, Source};
use crate::native::{NativeWindows, Remove};
use crate::persist::{is_ephemeral, is_persistent, Persist};
use crate::state::{build_state_json, ActiveNative, NativeTab};

/// Any daemon-native (non-tmux) pane id: local ephemeral or ptyd persistent.
fn is_native_id(id: u32) -> bool {
    is_ephemeral(id) || is_persistent(id)
}

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
    /// Bell scanning state: inside an OSC (`ESC ] … BEL|ST`)? OSC payload
    /// BELs are the TITLE STRING's terminator, not an attention bell — a
    /// fancy shell prompt would otherwise "ring" on every redraw.
    in_osc: bool,
}

/// Scan one output chunk for an ATTENTION bell: a 0x07 outside any OSC
/// (split-tolerant via the entry's in_osc carry).
fn scan_bell(in_osc: &mut bool, mut rest: &[u8]) -> bool {
    loop {
        if *in_osc {
            if let Some(i) = rest.windows(2).position(|w| w == b"\x1b\\") {
                *in_osc = false; // ST terminates the OSC
                rest = &rest[i + 2..];
                continue;
            }
            match rest.iter().position(|&b| b == 0x07) {
                // BEL inside OSC (usually the terminator) — consumed, not a bell.
                Some(i) => {
                    *in_osc = false;
                    rest = &rest[i + 1..];
                }
                None => return false,
            }
        } else if let Some(i) = rest.windows(2).position(|w| w == b"\x1b]") {
            *in_osc = true;
            rest = &rest[i..];
        } else {
            return rest.contains(&0x07);
        }
    }
}

/// Agent badges (hook + heuristic) plus the raw signals heuristics use.
#[derive(Default)]
struct AgentTracker {
    entries: BTreeMap<u32, AgentEntry>,
    heur: BTreeMap<u32, PaneHeur>,
}

/// Which view the shared UI is showing: a tmux window, or a native tab
/// (ephemeral or persistent — the id's high bits say which backend).
#[derive(Clone, Copy, PartialEq, Eq)]
enum ActiveView {
    Tmux,
    Native(u32),
}

/// Shared bridge between the WebSocket clients and a single tmux control client.
pub struct Hub {
    events_tx: broadcast::Sender<ServerEvent>,
    state: Mutex<TmuxState>,
    model: Arc<Mutex<Model>>,
    /// Agent badges (hook reports + heuristics) and per-pane heuristic signals.
    agents: Mutex<AgentTracker>,
    conf_path: PathBuf,
    /// All native (non-tmux) panes live in mymux-ptyd, ephemeral or not.
    pub(crate) persist: Persist,
    /// Layout trees grouping persistent panes into windows (native splits).
    pub(crate) natives: Mutex<NativeWindows>,
    /// Whether the UI is showing tmux or an ephemeral tab (one shared view).
    active_view: Mutex<ActiveView>,
    /// Last whole-window size (cols, rows) the UI reported — the sizer for
    /// ephemeral panes, which tmux does not lay out.
    last_size: Mutex<(u16, u16)>,
    /// One-shot guard for the first-connection default-shell bootstrap.
    booted: std::sync::atomic::AtomicBool,
    /// Tab display order: window ids (tmux and native share the u32 space)
    /// in FIRST-SEEN order, so new windows of either engine append on the
    /// right instead of interleaving by engine. User reorders move entries;
    /// persisted in the ptyd blob.
    pub(crate) tab_order: Mutex<Vec<u32>>,
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
            persist: Persist::default(),
            natives: Mutex::new(NativeWindows::default()),
            active_view: Mutex::new(ActiveView::Tmux),
            last_size: Mutex::new((80, 24)),
            booted: std::sync::atomic::AtomicBool::new(false),
            tab_order: Mutex::new(Vec::new()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.events_tx.subscribe()
    }

    pub(crate) fn emit(&self, ev: ServerEvent) {
        let _ = self.events_tx.send(ev);
    }

    /// Push the native layout blob to ptyd (fire-and-forget) so a restarted
    /// mymuxd adopts window grouping, splits AND the user's tab order.
    pub(crate) fn save_layout_blob(&self) {
        let order = self.tab_order.lock().unwrap().clone();
        let blob = self.natives.lock().unwrap().to_blob(&order);
        self.persist.set_meta(blob);
    }

    /// Drag a split divider: move the boundary next to a pane. Native windows
    /// edit the layout tree (ptyd then gets the new sizes); tmux panes go to
    /// tmux's own resize-pane. The UI always targets the boundary's left/top
    /// leaf, so dir is 'right' | 'down' with a signed cell count.
    pub async fn resize_pane(&self, pane: u32, dir: String, cells: i32) {
        if self.persist.pid_of(pane).is_some() {
            let changed = self.natives.lock().unwrap().resize_pane(pane, &dir, cells);
            if let Some(changed) = changed {
                for (p, w, h) in changed {
                    self.persist.resize(p, w, h);
                }
                self.save_layout_blob();
                self.emit(ServerEvent::State(self.state_json()));
            }
            return;
        }
        let flag = match (dir.as_str(), cells >= 0) {
            ("right", true) => "-R",
            ("right", false) => "-L",
            ("down", true) => "-D",
            ("down", false) => "-U",
            _ => return,
        };
        if cells != 0 {
            self.send_cmd(format!("resize-pane -t %{pane} {flag} {}", cells.abs()))
                .await;
        }
    }

    /// Move a window (any engine) to a new position in the tab order.
    pub async fn reorder_window(&self, id: u32, to: usize) {
        {
            let mut order = self.tab_order.lock().unwrap();
            let Some(from) = order.iter().position(|x| *x == id) else {
                return;
            };
            let item = order.remove(from);
            let idx = to.min(order.len());
            order.insert(idx, item);
        }
        self.save_layout_blob();
        self.emit(ServerEvent::State(self.state_json()));
    }

    /// Whether the active tmux socket already has a live server (pre-existing
    /// windows, possibly with agents — those must be adopted, never orphaned).
    async fn tmux_server_alive() -> bool {
        Command::new("tmux")
            .args(["-L", socket(), "has-session"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// True when the surviving tmux server holds exactly one never-used
    /// window: a single pane whose shell has no children and no foreground
    /// job. That is the bare session an OLDER mymuxd auto-created at connect
    /// — our own artifact, safe to clean up. Anything with real content
    /// (more windows, a running job, even a child process) fails this check
    /// and gets adopted instead.
    async fn tmux_session_pristine() -> bool {
        let out = Command::new("tmux")
            .args(["-L", socket(), "list-panes", "-a", "-F", "#{pane_pid}"])
            .output()
            .await;
        let Ok(o) = out else { return false };
        if !o.status.success() {
            return false;
        }
        let text = String::from_utf8_lossy(&o.stdout);
        let pids: Vec<&str> = text.lines().collect();
        let [only] = pids.as_slice() else {
            return false; // more than one pane/window = real content
        };
        let Ok(pid) = only.trim().parse::<u32>() else {
            return false;
        };
        let children = std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(true); // can't tell → assume used → adopt
        !children && foreground_cmd(pid).is_none()
    }

    /// First-connection bootstrap: NATIVE is the default experience. A
    /// running tmux server is adopted (its windows may hold agents), but tmux
    /// is never STARTED here — that happens on demand via `new_window`
    /// (⌘K w). With nothing to show, open a persistent shell as the first
    /// window. `MYMUX_DEFAULT_VIEW=none` disables the auto-shell (tests).
    pub async fn ensure_default_view(self: &Arc<Self>) {
        if !self.state.lock().unwrap().running && Self::tmux_server_alive().await {
            if Self::tmux_session_pristine().await {
                // A leftover bare session from an older mymuxd (which always
                // auto-started tmux): clean up our own artifact — scoped to
                // OUR socket — and boot native instead of adopting an empty
                // tab forever.
                eprintln!("mymuxd: cleaning up a pristine legacy tmux session");
                let _ = Command::new("tmux")
                    .args(["-L", socket(), "kill-server"])
                    .status()
                    .await;
            } else {
                self.ensure_started();
                return;
            }
        }
        if std::env::var_os("MYMUX_DEFAULT_VIEW").is_some_and(|v| v == "none") {
            return;
        }
        // Adopt ptyd survivors before deciding "empty" (idempotent; the
        // startup warmup may still be in flight on the very first connect).
        self.persist.warmup(self).await;
        let first_native = self.natives.lock().unwrap().tabs().first().map(|t| t.0);
        if first_native.is_some() || self.state.lock().unwrap().running {
            // Adopted natives with no tmux running: the view must land on
            // something real, not the empty tmux side.
            if let Some(id) = first_native {
                let mut view = self.active_view.lock().unwrap();
                if matches!(*view, ActiveView::Tmux) && !self.state.lock().unwrap().running {
                    *view = ActiveView::Native(id);
                }
            }
            return;
        }
        if self.booted.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return; // another connection is bootstrapping right now
        }
        self.new_persistent(None).await;
        if self.natives.lock().unwrap().tabs().is_empty() {
            // Spawn failed (ptyd unreachable?) — let a later connect retry.
            self.booted
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
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
                "-L",
                socket(),
                "-f",
                conf.as_str(),
                "-C",
                "new-session",
                "-A",
                "-s",
                SESSION,
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
        // Size the fresh session to the last known client size right away, so a
        // (re)spawned session lays out correctly even before the UI's next
        // resize event arrives.
        let (cols, rows) = *self.last_size.lock().unwrap();
        let _ = cmd_tx.try_send(format!("refresh-client -C {cols}x{rows}"));
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
            {
                let mut state = hub.state.lock().unwrap();
                state.running = false;
                state.cmd_tx = None;
            }
            // The tmux session is over (e.g. the last pane exited). No respawn.
            // With native windows still alive, tmux ending is just one engine
            // bowing out: switch the view there and carry on. Only when
            // NOTHING remains does the session end for real (UIs return to
            // their host picker / reconnect).
            let first_native = hub.natives.lock().unwrap().tabs().first().map(|t| t.0);
            match first_native {
                Some(id) => {
                    {
                        let mut view = hub.active_view.lock().unwrap();
                        if matches!(*view, ActiveView::Tmux) {
                            *view = ActiveView::Native(id);
                        }
                    }
                    *hub.model.lock().unwrap() = Model::new(); // tmux windows are gone
                    hub.emit(ServerEvent::State(hub.state_json()));
                    hub.reseed_visible().await;
                }
                None => {
                    hub.emit(ServerEvent::State(r#"{"t":"session_end"}"#.to_string()));
                }
            }
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
        if is_native_id(pane) {
            self.persist.input(pane, bytes);
            return;
        }
        let mut cmd = format!("send-keys -t %{pane} -H");
        for b in bytes {
            cmd.push_str(&format!(" {b:02x}"));
        }
        self.send_cmd(cmd).await;
    }

    pub async fn focus(&self, pane: u32) {
        if is_native_id(pane) {
            // Track the active pane inside its native window so tab switches
            // and reconnects land focus back on it.
            if self.natives.lock().unwrap().set_active(pane).is_some() {
                self.save_layout_blob();
                self.emit(ServerEvent::State(self.state_json()));
            }
            return;
        }
        self.send_cmd(format!("select-pane -t %{pane}")).await;
    }

    /// Move focus to the pane in a direction (`L`/`R`/`U`/`D`).
    pub async fn select_pane_dir(&self, dir: &str) {
        let view = *self.active_view.lock().unwrap();
        if let ActiveView::Native(id) = view {
            // Navigating away needs the other panes visible again (tmux
            // semantics: select-pane unzooms).
            let unzoomed = self.unzoom_backend(id);
            let moved = {
                let mut nw = self.natives.lock().unwrap();
                match nw.active_pane_of(id).and_then(|cur| nw.nav(id, cur, dir)) {
                    Some(next) => nw.set_active(next).is_some(),
                    None => false,
                }
            };
            if moved || unzoomed {
                self.save_layout_blob();
                self.emit(ServerEvent::State(self.state_json()));
            }
            if unzoomed {
                self.reseed_visible().await;
            }
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
        if let ActiveView::Native(id) = view {
            self.resize_native_window(id, cols, rows);
            // The tree geometry changed — tell the UI (tmux does this via
            // %layout-change; here we are the layout engine).
            self.emit(ServerEvent::State(self.state_json()));
        }
        // Keep tmux sized too, so switching back to a tmux window needs no resync.
        self.send_cmd(format!("refresh-client -C {cols}x{rows}"))
            .await;
    }

    /// Scale a native window's tree to a new view size and resize each
    /// member pane in ptyd to its cell — except a zoomed pane, which gets the
    /// full view (the tree underneath keeps tracking the size for unzoom).
    fn resize_native_window(&self, win: u32, cols: u16, rows: u16) {
        let (sizes, zoomed) = {
            let mut nw = self.natives.lock().unwrap();
            (nw.resize_window(win, cols, rows), nw.zoomed_of(win))
        };
        if sizes.is_empty() {
            // Not in any window (adoption race) — size the lone pane directly.
            self.persist.resize(win, cols, rows);
            return;
        }
        for (p, w, h) in sizes {
            if zoomed != Some(p) {
                self.persist.resize(p, w, h);
            }
        }
        if let Some(z) = zoomed {
            self.persist.resize(z, cols, rows);
        }
        self.save_layout_blob();
    }

    /// If the window is zoomed, unzoom and restore the tree's pane sizes.
    /// Returns true when panes were un-hidden (caller reseeds after its own
    /// state emit — the UI re-creates their terminals empty).
    fn unzoom_backend(&self, win: u32) -> bool {
        let Some(sizes) = self.natives.lock().unwrap().clear_zoom(win) else {
            return false;
        };
        for (p, w, h) in sizes {
            self.persist.resize(p, w, h);
        }
        true
    }

    /// Reseed every visible pane (used after zoom changes re-created panes).
    async fn reseed_visible(&self) {
        for (pane, seed) in self.snapshot_visible().await {
            self.emit(ServerEvent::Output { pane, data: seed });
        }
    }

    /// Toggle zoom (maximize) on a native pane; tmux views pass through.
    pub async fn toggle_zoom(&self, pane: u32) {
        if !is_native_id(pane) {
            self.send_cmd("resize-pane -Z".to_string()).await;
            return;
        }
        let win = {
            let mut nw = self.natives.lock().unwrap();
            if nw.toggle_zoom(pane).is_none() {
                return;
            }
            nw.window_of(pane)
        };
        let Some(win) = win else { return };
        let (cols, rows) = *self.last_size.lock().unwrap();
        self.resize_native_window(win, cols, rows);
        self.save_layout_blob();
        self.emit(ServerEvent::State(self.state_json()));
        // Panes appeared or vanished either way — reseed what's visible now.
        self.reseed_visible().await;
    }

    /// Swap the focused pane with its next/previous neighbour in layout order.
    pub async fn swap_pane(&self, next: bool) {
        let view = *self.active_view.lock().unwrap();
        let ActiveView::Native(id) = view else {
            let flag = if next { "-D" } else { "-U" };
            self.send_cmd(format!("swap-pane {flag}")).await;
            return;
        };
        let unzoomed = self.unzoom_backend(id);
        let sizes = {
            let mut nw = self.natives.lock().unwrap();
            nw.active_pane_of(id).and_then(|cur| nw.swap(cur, next))
        };
        let Some(sizes) = sizes else {
            if unzoomed {
                self.emit(ServerEvent::State(self.state_json()));
                self.reseed_visible().await;
            }
            return;
        };
        for (p, w, h) in sizes {
            self.persist.resize(p, w, h);
        }
        self.save_layout_blob();
        self.emit(ServerEvent::State(self.state_json()));
        if unzoomed {
            self.reseed_visible().await;
        }
    }

    /// Break a pane out of its split into its own window (keeps running).
    pub async fn break_pane(&self, pane: u32) {
        if !is_native_id(pane) {
            self.send_cmd(format!("break-pane -t %{pane}")).await;
            return;
        }
        let Some(win) = self.natives.lock().unwrap().window_of(pane) else {
            return;
        };
        if self.natives.lock().unwrap().panes_of(win).len() < 2 {
            return; // already its own window
        }
        let _ = self.unzoom_backend(win);
        if let Remove::Collapsed { resizes, .. } = self.natives.lock().unwrap().remove_pane(pane) {
            for (p, w, h) in resizes {
                self.persist.resize(p, w, h);
            }
        }
        let (cols, rows) = *self.last_size.lock().unwrap();
        let name = self.persist.name_of(pane).unwrap_or_default();
        self.natives
            .lock()
            .unwrap()
            .add_single(pane, name, cols, rows);
        self.persist.resize(pane, cols, rows);
        *self.active_view.lock().unwrap() = ActiveView::Native(pane);
        self.save_layout_blob();
        self.emit(ServerEvent::State(self.state_json()));
        self.reseed_visible().await;
    }

    /// Promote an ephemeral window to persistent in place (⌁→∞): every member
    /// pane flips its flag; ids (and MYMUX_PANE) stay put.
    pub async fn promote_window(&self, id: u32) {
        if !is_native_id(id) {
            return;
        }
        let panes = self.natives.lock().unwrap().panes_of(id);
        let targets = if panes.is_empty() { vec![id] } else { panes };
        for p in targets {
            self.persist.promote(p);
        }
        self.emit(ServerEvent::State(self.state_json()));
    }

    /// Demote a persistent window to throwaway (∞→⌁): it will die with this
    /// mymuxd. The UI confirms before sending this.
    pub async fn demote_window(&self, id: u32) {
        if !is_native_id(id) {
            return;
        }
        let panes = self.natives.lock().unwrap().panes_of(id);
        let targets = if panes.is_empty() { vec![id] } else { panes };
        for p in targets {
            self.persist.demote(p);
        }
        self.emit(ServerEvent::State(self.state_json()));
    }

    pub async fn select_window(&self, id: u32) {
        if is_native_id(id) {
            let known =
                self.natives.lock().unwrap().contains_window(id) || self.persist.contains(id);
            if !known {
                return;
            }
            *self.active_view.lock().unwrap() = ActiveView::Native(id);
            // The tab may have been resized while backgrounded; true up the
            // backend before painting so seeds are laid out correctly.
            let (cols, rows) = *self.last_size.lock().unwrap();
            self.resize_native_window(id, cols, rows);
            self.emit(ServerEvent::State(self.state_json()));
            for (pane, seed) in self.snapshot_visible().await {
                self.emit(ServerEvent::Output { pane, data: seed });
            }
            // Landing on this window means its finished work has been seen.
            self.clear_done_on_focus();
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

    pub async fn new_window(self: &Arc<Self>, cwd: Option<String>) {
        // tmux is opt-in now: the first ⌘K w boots the control client (and
        // with it the server) on demand. `new-session` already creates the
        // first window — sending new-window too would make TWO.
        let fresh = !self.state.lock().unwrap().running;
        self.ensure_started();
        if fresh {
            return;
        }
        // Open in the requested directory, else the active pane's (never the
        // tmux server's start dir).
        match cwd.as_deref().and_then(canon_dir) {
            Some(dir) => {
                let quoted = dir.replace('\'', "'\\''");
                self.send_cmd(format!("new-window -c '{quoted}'")).await;
            }
            None => {
                self.send_cmd("new-window -c \"#{pane_current_path}\"".to_string())
                    .await;
            }
        }
    }

    /// Rename a window/tab of any kind: tmux window, ephemeral or persistent.
    pub async fn rename_window(&self, id: u32, name: String) {
        if is_native_id(id) {
            // `id` is a native window; name it and its member panes (pane
            // names are what `mymux-attach ls` shows).
            let panes = {
                let mut nw = self.natives.lock().unwrap();
                nw.set_name(id, &name);
                nw.panes_of(id)
            };
            if panes.is_empty() {
                self.persist.rename(id, name);
            } else {
                for p in panes {
                    self.persist.rename(p, name.clone());
                }
            }
            self.save_layout_blob();
        } else {
            // tmux announces %window-renamed itself; single-quote the name.
            let quoted = name.replace('\'', "'\\''");
            self.send_cmd(format!("rename-window -t @{id} '{quoted}'"))
                .await;
            return;
        }
        self.emit(ServerEvent::State(self.state_json()));
    }

    pub async fn close_pane(&self, pane: u32, force: bool) {
        if is_native_id(pane) {
            if !force {
                if let Some(cmd) = self.persist.pid_of(pane).and_then(foreground_cmd) {
                    self.emit_confirm_close(pane, &cmd);
                    return;
                }
            }
            self.persist.kill(pane);
            self.native_pane_removed(pane).await;
            return;
        }
        if !force {
            if let Some(cmd) = self.tmux_pane_pid(pane).await.and_then(foreground_cmd) {
                self.emit_confirm_close(pane, &cmd);
                return;
            }
        }
        self.send_cmd(format!("kill-pane -t %{pane}")).await;
    }

    /// The pane's shell is busy: ask the user instead of killing it blind.
    fn emit_confirm_close(&self, pane: u32, cmd: &str) {
        let msg = serde_json::json!({ "t": "confirm_close", "pane": pane, "cmd": cmd });
        self.emit(ServerEvent::State(msg.to_string()));
    }

    async fn tmux_pane_pid(&self, pane: u32) -> Option<u32> {
        let out = Command::new("tmux")
            .args([
                "-L",
                socket(),
                "display-message",
                "-p",
                "-t",
                &format!("%{pane}"),
                "#{pane_pid}",
            ])
            .output()
            .await
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    /// The viewed window vanished: fall to another native window, else tmux
    /// (if it's running), else nothing remains and the session is over (the
    /// UIs return to their host picker). Emits the follow-up state/seeds.
    async fn fall_back_view(&self) {
        let next = self.natives.lock().unwrap().tabs().first().map(|t| t.0);
        if let Some(id) = next {
            *self.active_view.lock().unwrap() = ActiveView::Native(id);
        } else if self.state.lock().unwrap().running {
            *self.active_view.lock().unwrap() = ActiveView::Tmux;
        } else {
            self.emit(ServerEvent::State(r#"{"t":"session_end"}"#.to_string()));
            return;
        }
        self.emit(ServerEvent::State(self.state_json()));
        self.reseed_visible().await;
    }

    /// A native pane is gone (killed or exited on its own): collapse its
    /// window's layout, resize the survivors, fix the view, repaint.
    async fn native_pane_removed(&self, pane: u32) {
        // Drop any agent badge/heuristic state the dead pane left behind.
        {
            let mut agents = self.agents.lock().unwrap();
            agents.entries.remove(&pane);
            agents.heur.remove(&pane);
        }
        // If the window was zoomed, panes are about to reappear — reseed then.
        let was_zoomed = {
            let nw = self.natives.lock().unwrap();
            nw.window_of(pane).and_then(|w| nw.zoomed_of(w)).is_some()
        };
        let rm = self.natives.lock().unwrap().remove_pane(pane);
        match rm {
            Remove::None => {
                self.emit(ServerEvent::State(self.state_json()));
            }
            Remove::WindowGone(win) => {
                let was_active = matches!(
                    *self.active_view.lock().unwrap(),
                    ActiveView::Native(x) if x == win
                );
                self.save_layout_blob();
                if was_active {
                    // Next native window → tmux (if running) → session end.
                    self.fall_back_view().await;
                } else {
                    self.emit(ServerEvent::State(self.state_json()));
                }
            }
            Remove::Collapsed { resizes, .. } => {
                for (p, w, h) in resizes {
                    self.persist.resize(p, w, h);
                }
                self.save_layout_blob();
                self.emit(ServerEvent::State(self.state_json()));
                if was_zoomed {
                    self.reseed_visible().await;
                }
            }
        }
    }

    pub async fn split(self: &Arc<Self>, pane: u32, horizontal: bool) {
        if is_native_id(pane) {
            self.split_native(pane, horizontal).await;
            return;
        }
        let flag = if horizontal { "-h" } else { "-v" };
        self.send_cmd(format!(
            "split-window {flag} -c \"#{{pane_current_path}}\" -t %{pane}"
        ))
        .await;
    }

    /// Split a native pane: spawn a sibling ptyd pane (same kind as the
    /// target — an ⌁ window splits into ⌁ panes) in the target's cwd, insert
    /// it into the layout, and resize both halves.
    async fn split_native(self: &Arc<Self>, pane: u32, horizontal: bool) {
        let Some(win) = self.natives.lock().unwrap().window_of(pane) else {
            return;
        };
        let unzoomed = self.unzoom_backend(win);
        let sizes = self.natives.lock().unwrap().split_sizes(pane, horizontal);
        let Some(((ow, oh), (new_w, new_h))) = sizes else {
            // Too small to split; still repaint if we just unzoomed.
            if unzoomed {
                self.emit(ServerEvent::State(self.state_json()));
                self.reseed_visible().await;
            }
            return;
        };
        let cwd = self
            .persist
            .pid_of(pane)
            .and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
            .map(|p| p.display().to_string());
        let new_id = match self
            .persist
            .spawn_pane(self, cwd, new_w, new_h, is_ephemeral(pane))
            .await
        {
            Ok(id) => id,
            Err(e) => {
                eprintln!("mymuxd: failed to spawn split pane: {e}");
                return;
            }
        };
        let inserted = self.natives.lock().unwrap().split(pane, horizontal, new_id);
        if !inserted {
            // The window vanished while we were spawning — undo the pane.
            self.persist.kill(new_id);
            return;
        }
        self.persist.resize(pane, ow, oh);
        self.save_layout_blob();
        self.emit(ServerEvent::State(self.state_json()));
        if unzoomed {
            self.reseed_visible().await;
        }
    }

    /// The current state snapshot as JSON (for initial sync / resync).
    pub fn state_json(&self) -> String {
        let tabs: Vec<NativeTab> = self
            .natives
            .lock()
            .unwrap()
            .tabs()
            .into_iter()
            .map(|(id, name, panes)| NativeTab {
                // Kind = the mirror's flag (a promoted ⌁ shows as ∞); the id
                // bit is only the birth kind, kept as a fallback.
                ephemeral: self
                    .persist
                    .pane_ephemeral(id)
                    .unwrap_or_else(|| is_ephemeral(id)),
                id,
                name,
                panes,
            })
            .collect();
        let active = match *self.active_view.lock().unwrap() {
            ActiveView::Native(id) => {
                let nw = self.natives.lock().unwrap();
                let zoomed = nw.zoomed_of(id);
                let full = |pane: u32| {
                    let (cols, rows) = *self.last_size.lock().unwrap();
                    LayoutCell {
                        x: 0,
                        y: 0,
                        w: cols,
                        h: rows,
                        kind: CellKind::Leaf(PaneId(pane)),
                    }
                };
                let (pane, layout) = match (zoomed, nw.active_pane_of(id), nw.layout_of(id)) {
                    // Zoomed: the UI sees just that pane, full-view.
                    (Some(z), _, Some(_)) => (z, full(z)),
                    (None, Some(p), Some(l)) => (p, l),
                    // Not-yet-grouped pane (adoption race): one full leaf.
                    _ => (id, full(id)),
                };
                Some(ActiveNative {
                    window: id,
                    pane,
                    layout,
                    zoomed: zoomed.is_some(),
                })
            }
            ActiveView::Tmux => None,
        };
        let model = self.model.lock().unwrap();
        let agents = self.agents.lock().unwrap();
        let view: BTreeMap<u32, crate::state::AgentView> = agents
            .entries
            .iter()
            .map(|(&p, e)| (p, (e.state, e.needy_since_ms)))
            .collect();
        let mut order = self.tab_order.lock().unwrap();
        build_state_json(&model, &view, &tabs, active.as_ref(), &mut order)
    }

    /// Update an agent's hook-reported state (`None` clears it), then broadcast.
    pub fn set_agent(&self, pane: u32, state: Option<AgentState>) {
        {
            let mut agents = self.agents.lock().unwrap();
            match state {
                Some(s) => {
                    let prev = agents.entries.get(&pane).copied();
                    agents
                        .entries
                        .insert(pane, AgentEntry::new(s, Source::Hook, prev.as_ref()));
                }
                None => {
                    agents.entries.remove(&pane);
                }
            }
        }
        self.emit(ServerEvent::State(self.state_json()));
    }

    /// ptyd's authoritative alt-screen report (chunk-split safe, covers the
    /// 1047/1048 flavors the note_output byte-scan doesn't). Just updates the
    /// heuristic signal; the 2s sweep turns it into badges.
    pub(crate) fn note_alt(&self, pane: u32, on: bool) {
        let mut agents = self.agents.lock().unwrap();
        agents.heur.entry(pane).or_insert(PaneHeur {
            alt: false,
            last_activity: Instant::now(),
            last_bell: None,
            in_osc: false,
        }).alt = on;
    }

    /// Fold a pane's output into the heuristic signals (alt-screen, activity, bell).
    pub(crate) fn note_output(&self, pane: u32, data: &[u8]) {
        let now = Instant::now();
        let alt_on = contains(data, b"\x1b[?1049h");
        let alt_off = contains(data, b"\x1b[?1049l");
        let cleared_done;
        let bell;
        {
            let mut agents = self.agents.lock().unwrap();
            let h = agents.heur.entry(pane).or_insert(PaneHeur {
                alt: false,
                last_activity: now,
                last_bell: None,
                in_osc: false,
            });
            h.last_activity = now;
            bell = scan_bell(&mut h.in_osc, data);
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
            // the hook / heuristic re-establish the live state. GRACE: agents
            // flush trailing output right after their turn-complete hook fires;
            // clearing on that would drop the badge before anyone saw it.
            const DONE_GRACE: Duration = Duration::from_millis(1500);
            cleared_done = agents
                .entries
                .get(&pane)
                .map(|e| e.state == AgentState::Done && e.set_at.elapsed() > DONE_GRACE)
                .unwrap_or(false);
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
        // The "viewed" set spans engines: the active tmux window's panes, or
        // the active native window's VISIBLE layout leaves (zoom-aware) —
        // panes you're looking at get no badge. Before this read the tmux
        // model only, a focused native pane could badge spuriously.
        let active: BTreeSet<u32> = match *self.active_view.lock().unwrap() {
            ActiveView::Native(id) => self
                .natives
                .lock()
                .unwrap()
                .visible_panes_of(id)
                .into_iter()
                .collect(),
            ActiveView::Tmux => self
                .model
                .lock()
                .unwrap()
                .active_window_panes()
                .iter()
                .map(|p| p.0)
                .collect(),
        };

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
                    Some(if belled {
                        AgentState::Waiting
                    } else {
                        AgentState::Done
                    })
                } else {
                    Some(AgentState::Running)
                };
                if agents.entries.get(&p).map(|e| e.state) != desired {
                    match desired {
                        Some(s) => {
                            let prev = agents.entries.get(&p).copied();
                            agents
                                .entries
                                .insert(p, AgentEntry::new(s, Source::Heuristic, prev.as_ref()));
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
    /// Clear "done" badges on the panes the user is now LOOKING at — seeing
    /// the finished work is the acknowledgement. Covers both engines: the
    /// active tmux window's panes, or the active native window's visible ones.
    pub(crate) fn clear_done_on_focus(&self) {
        let panes: Vec<u32> = match *self.active_view.lock().unwrap() {
            ActiveView::Native(id) => self.natives.lock().unwrap().visible_panes_of(id),
            ActiveView::Tmux => self
                .model
                .lock()
                .unwrap()
                .active_window_panes()
                .iter()
                .map(|p| p.0)
                .collect(),
        };
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
                "-L",
                socket(),
                "display-message",
                "-p",
                "-t",
                target,
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
        // A native tab reseeds from its server-side grid, not from tmux.
        let view = *self.active_view.lock().unwrap();
        if let ActiveView::Native(id) = view {
            let panes = {
                let p = self.natives.lock().unwrap().visible_panes_of(id);
                if p.is_empty() {
                    vec![id]
                } else {
                    p
                }
            };
            let mut seeds = Vec::new();
            for p in panes {
                let seed = self.persist.snapshot(p).await;
                if !seed.is_empty() {
                    seeds.push((p, seed));
                }
            }
            return seeds;
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
                "-L",
                socket(),
                "list-windows",
                "-F",
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

    /// After layouts refresh, make sure the active pane actually belongs to the
    /// active window (a bare window switch doesn't re-announce the pane, and
    /// the layout may only arrive here) — otherwise the UI can't focus it.
    fn fix_active_pane(&self) {
        let mut m = self.model.lock().unwrap();
        let Some(aw) = m.active_window else { return };
        let (leaves, remembered) = match m.windows.get(&aw) {
            Some(wi) => {
                let mut leaves = Vec::new();
                if let Some(l) = &wi.layout {
                    l.root.for_each_pane(&mut |p, _| leaves.push(p));
                }
                (leaves, wi.active_pane)
            }
            None => return,
        };
        if leaves.is_empty() {
            return;
        }
        let current_ok = m.active_pane.map(|p| leaves.contains(&p)).unwrap_or(false);
        if !current_ok {
            m.active_pane = remembered
                .filter(|p| leaves.contains(p))
                .or(Some(leaves[0]));
        }
    }

    /// Every pane across all windows with its shell pid, for the process tree:
    /// `(window_id, pane_id, pane_pid, window_name, ephemeral)`.
    pub async fn pane_pids(&self) -> Vec<(u32, u32, u32, String, bool)> {
        let out = Command::new("tmux")
            .args([
                "-L",
                socket(),
                "list-panes",
                "-a",
                "-F",
                "#{window_id} #{pane_id} #{pane_pid} #{window_name}",
            ])
            .output()
            .await;
        let mut rows = Vec::new();
        // tmux may simply not be running (native is the default now) — its
        // absence must not hide the native panes below.
        if let Ok(o) = out {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
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
                    rows.push((wid.0, pane.0, pid, name, false));
                }
            }
        }
        // Native (ptyd-held) shells, grouped under their layout windows.
        {
            let nw = self.natives.lock().unwrap();
            for (id, pid, name) in self.persist.pids() {
                let win = nw.window_of(id).unwrap_or(id);
                let eph = self
                    .persist
                    .pane_ephemeral(id)
                    .unwrap_or_else(|| is_ephemeral(id));
                rows.push((win, id, pid, name, eph));
            }
        }
        rows
    }

    /// Spawn a new native shell tab and switch to it. Both kinds live in
    /// mymux-ptyd; `ephemeral` panes are killed by ptyd when our connection
    /// drops (they die with mymuxd, as ⌁ always has), persistent ones survive.
    async fn new_native(self: &Arc<Self>, ephemeral: bool, cwd_override: Option<String>) {
        // An explicit directory wins (spawn elsewhere WITHOUT touching the
        // current pane — its agent keeps running); default = the focused
        // pane's cwd. Invalid/missing overrides fall back gracefully.
        let cwd = match cwd_override.as_deref().and_then(canon_dir) {
            Some(dir) => Some(dir),
            None => self
                .active_pane_cwd()
                .await
                .map(|p| p.display().to_string()),
        };
        let (cols, rows) = *self.last_size.lock().unwrap();
        match self
            .persist
            .spawn_pane(self, cwd, cols, rows, ephemeral)
            .await
        {
            Ok(id) => {
                self.natives
                    .lock()
                    .unwrap()
                    .add_single(id, String::new(), cols, rows);
                *self.active_view.lock().unwrap() = ActiveView::Native(id);
                self.save_layout_blob();
                self.emit(ServerEvent::State(self.state_json()));
            }
            Err(e) => {
                eprintln!("mymuxd: failed to spawn native shell: {e}");
                let msg = serde_json::json!({
                    "t": "error",
                    "msg": format!("failed to spawn native shell: {e}"),
                });
                self.emit(ServerEvent::State(msg.to_string()));
            }
        }
    }

    /// Spawn a new ephemeral (raw, dies-with-mymuxd) shell tab.
    pub async fn new_ephemeral(self: &Arc<Self>, cwd: Option<String>) {
        self.new_native(true, cwd).await;
    }

    /// Spawn a new persistent shell tab (survives mymuxd restarts).
    pub async fn new_persistent(self: &Arc<Self>, cwd: Option<String>) {
        self.new_native(false, cwd).await;
    }

    /// Called when a native pane's process ended (a ptyd exit event): drop it
    /// and, if it was the visible view, fall back to tmux and repaint.
    pub async fn native_exited(self: Arc<Self>, id: u32) {
        if !self.persist.remove_mirror(id) {
            return; // already handled (e.g. an explicit close)
        }
        self.native_pane_removed(id).await;
    }

    /// The ptyd connection died: every native pane died with it.
    pub async fn persist_disconnected(self: &Arc<Self>) {
        let had = self.persist.clear();
        self.natives.lock().unwrap().clear();
        // The initial window died with ptyd — allow the next connection to
        // boot one again (booted is the once-per-daemon guard; a ptyd loss
        // resets the invariant it protects).
        self.booted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let was_native = matches!(*self.active_view.lock().unwrap(), ActiveView::Native(_));
        if had || was_native {
            eprintln!("mymuxd: mymux-ptyd connection lost — native panes are gone");
            if was_native {
                // tmux if it's running, else nothing is left → session end.
                self.fall_back_view().await;
            } else {
                self.emit(ServerEvent::State(self.state_json()));
            }
        }
    }

    /// The focused pane's cwd, to root a new shell tab nearby. Works for both
    /// engines: a native view reads `/proc/<shell pid>/cwd`, a tmux view asks
    /// tmux.
    async fn active_pane_cwd(&self) -> Option<PathBuf> {
        let view = *self.active_view.lock().unwrap();
        if let ActiveView::Native(id) = view {
            let pane = self
                .natives
                .lock()
                .unwrap()
                .active_pane_of(id)
                .unwrap_or(id);
            let pid = self.persist.pid_of(pane)?;
            return std::fs::read_link(format!("/proc/{pid}/cwd")).ok();
        }
        let pane = self.model.lock().unwrap().active_pane?;
        let out = Command::new("tmux")
            .args([
                "-L",
                socket(),
                "display-message",
                "-p",
                "-t",
                &format!("%{}", pane.0),
                "#{pane_current_path}",
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
            hub.fix_active_pane();
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
    !needle.is_empty()
        && hay.len() >= needle.len()
        && hay.windows(needle.len()).any(|w| w == needle)
}

/// Validate a user-supplied spawn directory: trim, expand a leading `~`, and
/// require it to exist as a directory. `None` = fall back to the default.
fn canon_dir(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let expanded = if let Some(rest) = raw.strip_prefix("~/") {
        format!("{}/{rest}", std::env::var("HOME").ok()?)
    } else if raw == "~" {
        std::env::var("HOME").ok()?
    } else {
        raw.to_string()
    };
    std::fs::metadata(&expanded)
        .ok()?
        .is_dir()
        .then_some(expanded)
}

/// The shell's current foreground job (`None` at an idle prompt): the tty's
/// foreground process group (tpgid, /proc stat field 8) differs from the
/// shell's own group when something like vim or an agent holds the terminal.
fn foreground_cmd(shell_pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    let rest = stat.rsplit_once(')')?.1; // skip "pid (comm" — comm may hold spaces
    let mut fields = rest.split_whitespace();
    let pgrp: i32 = fields.clone().nth(2)?.parse().ok()?;
    let tpgid: i32 = fields.nth(5)?.parse().ok()?;
    if tpgid <= 0 || tpgid == pgrp {
        return None;
    }
    let comm = std::fs::read_to_string(format!("/proc/{tpgid}/comm")).ok()?;
    let c = comm.trim().to_string();
    (!c.is_empty()).then_some(c)
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

#[cfg(test)]
mod tests {
    use super::scan_bell;

    #[test]
    fn plain_bell_counts() {
        let mut osc = false;
        assert!(scan_bell(&mut osc, b"hello\x07world"));
        assert!(!osc);
    }

    #[test]
    fn osc_title_bel_is_not_a_bell() {
        let mut osc = false;
        // A fancy prompt: OSC window-title terminated by BEL, plus its own content.
        assert!(!scan_bell(&mut osc, b"\x1b]0;user@host: ~/mymux\x07$ "));
        assert!(!osc);
        // …and a REAL bell after the title still counts.
        assert!(scan_bell(&mut osc, b"\x1b]0;t\x07$ \x07"));
    }

    #[test]
    fn st_terminated_osc_is_not_a_bell() {
        let mut osc = false;
        assert!(!scan_bell(&mut osc, b"\x1b]8;http://x\x1b\\text"));
        assert!(!osc);
    }

    #[test]
    fn osc_split_across_chunks_carries() {
        let mut osc = false;
        assert!(!scan_bell(&mut osc, b"prompt \x1b]0;part"));
        assert!(osc); // unterminated OSC: the state carries over
        assert!(!scan_bell(&mut osc, b"two\x07"));
        assert!(!osc); // the BEL in this chunk was the title terminator
        assert!(scan_bell(&mut osc, b"\x07")); // a later real bell counts
    }
}
