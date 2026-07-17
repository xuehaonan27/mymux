//! mymux-ptyd — the persistent-pane holder.
//!
//! Deliberately tiny and rarely changed: it owns PTYs, pumps bytes, and keeps a
//! [`PaneGrid`] per pane, so that mymuxd (which changes constantly) can restart
//! or crash without killing anyone's shells. Panes die only with THIS daemon —
//! the same contract tmux's server gives its sessions.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use mymux_ptyd::grid::PaneGrid;
use mymux_ptyd::proto::{
    read_frame, write_frame, Event, PaneInfo, Reply, Req, KIND_INPUT, KIND_JSON, KIND_OUTPUT,
    KIND_SNAPSHOT,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};

#[derive(Clone)]
enum Ev {
    Output { id: u32, data: Vec<u8> },
    Exit { id: u32 },
    /// The pane's grid flipped into/out of the alternate screen.
    Alt { id: u32, on: bool },
}

struct Pane {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: u32,
    name: Mutex<String>,
    size: Mutex<(u16, u16)>,
    grid: Arc<Mutex<PaneGrid>>,
    /// Ephemeral panes die when `owner` (the connection that spawned them)
    /// disconnects; persistent panes die only with this daemon. Both mutable:
    /// a pane can be promoted (⌁→∞) or demoted (∞→⌁) in place — a demotion
    /// re-homes `owner` to the demoting connection.
    ephemeral: std::sync::atomic::AtomicBool,
    owner: std::sync::atomic::AtomicU64,
}

impl Drop for Pane {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct Store {
    panes: Mutex<BTreeMap<u32, Arc<Pane>>>,
    events: broadcast::Sender<Ev>,
    /// Opaque client metadata (mymuxd's layout blob) — memory-only, so it dies
    /// together with the panes it describes.
    meta: Mutex<String>,
    next_conn: std::sync::atomic::AtomicU64,
}

#[tokio::main]
async fn main() {
    let path = mymux_ptyd::proto::socket_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Single instance: a live socket means another ptyd is serving.
    if UnixStream::connect(&path).await.is_ok() {
        eprintln!("mymux-ptyd: already running on {}", path.display());
        return;
    }
    let _ = std::fs::remove_file(&path); // stale socket file
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("mymux-ptyd: bind {}: {e}", path.display());
            std::process::exit(1);
        }
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    eprintln!("mymux-ptyd: listening on {}", path.display());

    let (events, _) = broadcast::channel(4096);
    let store = Arc::new(Store {
        panes: Mutex::new(BTreeMap::new()),
        events,
        meta: Mutex::new(String::new()),
        next_conn: std::sync::atomic::AtomicU64::new(1),
    });

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(handle_conn(stream, store.clone()));
            }
            Err(e) => {
                eprintln!("mymux-ptyd: accept: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

async fn handle_conn(stream: UnixStream, store: Arc<Store>) {
    let conn = store
        .next_conn
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (mut rd, wr) = tokio::io::split(stream);
    let (out, out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
    tokio::spawn(async move {
        let mut wr = wr;
        let mut rx = out_rx;
        while let Some((kind, body)) = rx.recv().await {
            if write_frame(&mut wr, kind, &body).await.is_err() {
                break;
            }
        }
    });

    loop {
        let frame = match read_frame(&mut rd).await {
            Ok(Some(f)) => f,
            Ok(None) | Err(_) => break,
        };
        match frame {
            (KIND_INPUT, body) if body.len() >= 4 => {
                let id = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                let writer = store
                    .panes
                    .lock()
                    .unwrap()
                    .get(&id)
                    .map(|p| p.writer.clone());
                if let Some(w) = writer {
                    let mut w = w.lock().unwrap();
                    let _ = w.write_all(&body[4..]);
                    let _ = w.flush();
                }
            }
            (KIND_JSON, body) => {
                let Ok(req) = serde_json::from_slice::<Req>(&body) else {
                    continue;
                };
                handle_req(req, &store, &out, conn);
            }
            _ => {}
        }
    }

    // The spawning connection is gone: its ephemeral panes go with it (map
    // removal closes the pty; the reader thread emits the single Exit).
    let orphans: Vec<u32> = {
        let panes = store.panes.lock().unwrap();
        panes
            .iter()
            .filter(|(_, p)| {
                p.ephemeral.load(std::sync::atomic::Ordering::Relaxed)
                    && p.owner.load(std::sync::atomic::Ordering::Relaxed) == conn
            })
            .map(|(&id, _)| id)
            .collect()
    };
    for id in orphans {
        let _ = store.panes.lock().unwrap().remove(&id);
    }
}

fn reply(out: &mpsc::UnboundedSender<(u8, Vec<u8>)>, rep: Reply) {
    let _ = out.send((KIND_JSON, serde_json::to_vec(&rep).unwrap_or_default()));
}

fn handle_req(req: Req, store: &Arc<Store>, out: &mpsc::UnboundedSender<(u8, Vec<u8>)>, conn: u64) {
    match req {
        Req::Subscribe => {
            let mut rx = store.events.subscribe();
            let out = out.clone();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(Ev::Output { id, data }) => {
                            let mut body = Vec::with_capacity(4 + data.len());
                            body.extend_from_slice(&id.to_le_bytes());
                            body.extend_from_slice(&data);
                            if out.send((KIND_OUTPUT, body)).is_err() {
                                break;
                            }
                        }
                        Ok(Ev::Exit { id }) => {
                            let ev = Event {
                                ev: "exit".into(),
                                id,
                            };
                            if out
                                .send((KIND_JSON, serde_json::to_vec(&ev).unwrap_or_default()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(Ev::Alt { id, on }) => {
                            let ev = Event {
                                ev: if on { "alt_on".into() } else { "alt_off".into() },
                                id,
                            };
                            if out
                                .send((KIND_JSON, serde_json::to_vec(&ev).unwrap_or_default()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
        Req::Spawn {
            req,
            id,
            cwd,
            cols,
            rows,
            name,
            env,
            ephemeral,
        } => {
            let rep = match spawn_pane(store, id, cwd, cols, rows, name, env, ephemeral, conn) {
                Ok(pid) => Reply {
                    rep: req,
                    ok: true,
                    pid: Some(pid),
                    ..Default::default()
                },
                Err(e) => Reply {
                    rep: req,
                    ok: false,
                    err: Some(e),
                    ..Default::default()
                },
            };
            reply(out, rep);
        }
        Req::Resize { id, cols, rows } => {
            if let Some(p) = store.panes.lock().unwrap().get(&id) {
                let _ = p.master.lock().unwrap().resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
                p.grid.lock().unwrap().resize(cols, rows);
                *p.size.lock().unwrap() = (cols, rows);
            }
        }
        Req::Rename { id, name } => {
            if let Some(p) = store.panes.lock().unwrap().get(&id) {
                *p.name.lock().unwrap() = name;
            }
        }
        Req::SetEphemeral { id, ephemeral } => {
            if let Some(p) = store.panes.lock().unwrap().get(&id) {
                p.ephemeral
                    .store(ephemeral, std::sync::atomic::Ordering::Relaxed);
                if ephemeral {
                    // Demotion re-homes the pane to the demoting connection:
                    // it now dies when THIS client (mymuxd) goes away.
                    p.owner.store(conn, std::sync::atomic::Ordering::Relaxed);
                }
            }
        }
        Req::Kill { id } => {
            // Dropping the pane closes the pty; the reader thread sees EOF and
            // emits the Exit event (single exit path).
            let _ = store.panes.lock().unwrap().remove(&id);
        }
        Req::Snapshot { req, id } => {
            let snap = store
                .panes
                .lock()
                .unwrap()
                .get(&id)
                .map(|p| p.grid.lock().unwrap().snapshot())
                .unwrap_or_default();
            let mut body = Vec::with_capacity(8 + snap.len());
            body.extend_from_slice(&req.to_le_bytes());
            body.extend_from_slice(&snap);
            let _ = out.send((KIND_SNAPSHOT, body));
        }
        Req::SetMeta { data } => {
            *store.meta.lock().unwrap() = data;
        }
        Req::GetMeta { req } => {
            let meta = store.meta.lock().unwrap().clone();
            reply(
                out,
                Reply {
                    rep: req,
                    ok: true,
                    meta: Some(meta),
                    ..Default::default()
                },
            );
        }
        Req::List { req } => {
            let panes: Vec<PaneInfo> = store
                .panes
                .lock()
                .unwrap()
                .iter()
                .map(|(&id, p)| {
                    let (cols, rows) = *p.size.lock().unwrap();
                    PaneInfo {
                        id,
                        pid: p.pid,
                        name: p.name.lock().unwrap().clone(),
                        cols,
                        rows,
                        ephemeral: Some(p.ephemeral.load(std::sync::atomic::Ordering::Relaxed)),
                        alt: Some(p.grid.lock().unwrap().alt_screen()),
                    }
                })
                .collect();
            reply(
                out,
                Reply {
                    rep: req,
                    ok: true,
                    panes: Some(panes),
                    ..Default::default()
                },
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_pane(
    store: &Arc<Store>,
    id: u32,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    name: String,
    env: Vec<(String, String)>,
    ephemeral: bool,
    owner: u64,
) -> Result<u32, String> {
    if store.panes.lock().unwrap().contains_key(&id) {
        return Err(format!("pane id {id} already in use"));
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Panes are raw shells, never nested tmux sessions.
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id().unwrap_or(0);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;
    drop(pair.slave); // so the master reader EOFs when the shell exits

    let grid = Arc::new(Mutex::new(PaneGrid::new(cols, rows)));
    let pane = Arc::new(Pane {
        writer: Arc::new(Mutex::new(writer)),
        master: Mutex::new(master),
        child: Mutex::new(child),
        pid,
        name: Mutex::new(name),
        size: Mutex::new((cols, rows)),
        grid: grid.clone(),
        ephemeral: std::sync::atomic::AtomicBool::new(ephemeral),
        owner: std::sync::atomic::AtomicU64::new(owner),
    });
    store.panes.lock().unwrap().insert(id, pane);

    // Reader thread: pty → grid (+ alt flips) → broadcast + raw history log;
    // on EOF drop the pane and announce.
    let store2 = store.clone();
    let mut hist = HistLog::open(id, pid);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let mut last_alt = false;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let on = {
                        let mut g = grid.lock().unwrap();
                        g.feed(chunk);
                        g.alt_screen()
                    };
                    if on != last_alt {
                        last_alt = on;
                        let _ = store2.events.send(Ev::Alt { id, on });
                    }
                    if let Some(h) = hist.as_mut() {
                        h.write(chunk);
                    }
                    let _ = store2.events.send(Ev::Output {
                        id,
                        data: chunk.to_vec(),
                    });
                }
            }
        }
        let _ = store2.panes.lock().unwrap().remove(&id);
        let _ = store2.events.send(Ev::Exit { id });
    });

    Ok(pid)
}

/// Raw per-pane output log (ANSI included) — the unlimited-scrollback tier.
/// Appends until `cap` (default 64 MB, `MYMUX_HISTORY_CAP` overrides), then
/// rotates once to `<path>.1`, bounding disk use at ~2×cap per pane. Disable
/// with `MYMUX_HISTORY=0`. View with `less -R` / grep via `mymux-attach hist`.
struct HistLog {
    file: std::fs::File,
    path: std::path::PathBuf,
    len: u64,
    cap: u64,
}

impl HistLog {
    fn open(id: u32, pid: u32) -> Option<HistLog> {
        if std::env::var_os("MYMUX_HISTORY").is_some_and(|v| v == "0") {
            return None;
        }
        let dir = mymux_ptyd::proto::history_dir()?;
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(format!("{}-{pid}.log", id & 0x3fff_ffff));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let cap = std::env::var("MYMUX_HISTORY_CAP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(64 * 1024 * 1024);
        Some(HistLog {
            file,
            path,
            len,
            cap,
        })
    }

    fn write(&mut self, chunk: &[u8]) {
        let _ = self.file.write_all(chunk);
        self.len += chunk.len() as u64;
        if self.len > self.cap {
            self.rotate();
        }
    }

    fn rotate(&mut self) {
        let old = std::path::PathBuf::from(format!("{}.1", self.path.display()));
        let _ = std::fs::rename(&self.path, old);
        if let Ok(f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            self.file = f;
            self.len = 0;
        }
    }
}
