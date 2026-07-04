//! mymux-attach — the escape hatch for persistent panes.
//!
//! When the mymux app is unreachable (broken build, no Mac at hand), attach to
//! a ptyd-held pane from any plain terminal: full snapshot first, then a raw
//! byte bridge. `Ctrl-\` detaches; the pane keeps running. This mirrors what
//! `tmux -L mymux attach` provides for the tmux engine.
//!
//! Usage:
//!   mymux-attach            attach when exactly one pane exists, else list
//!   mymux-attach ls         list panes
//!   mymux-attach <target>   attach — target is a pane's short id, full id, or
//!                           a unique NAME PREFIX (like `tmux a -t`)
//!   mymux-attach hist [t]   full raw output logs (unlimited scrollback):
//!                           bare lists every log, with a target prints that
//!                           pane's file paths — `less -R $(mymux-attach hist 3)`

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use mymux_ptyd::client::{Client, PtydEvent};
use mymux_ptyd::proto::{history_dir, socket_path};

/// Restore the terminal on drop (any exit path).
struct RawGuard(libc::termios);

impl Drop for RawGuard {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.0);
        }
    }
}

/// `hist` subcommand: locate the raw output logs ptyd keeps per pane (they
/// outlive the panes — histories of DEAD shells are the whole point). Bare
/// lists everything; a numeric target matches `<short>-*.log` right in the
/// directory (works with ptyd down); a name prefix needs a live ptyd.
async fn hist_cmd(target: Option<String>) {
    let Some(dir) = history_dir() else {
        eprintln!("mymux-attach: cannot locate the history dir (HOME unset?)");
        std::process::exit(1);
    };
    let list = |short: Option<u32>| -> Vec<(PathBuf, u64)> {
        let mut v = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !name.contains(".log") {
                    continue;
                }
                if let Some(s) = short {
                    if !name.starts_with(&format!("{s}-")) {
                        continue;
                    }
                }
                v.push((e.path(), e.metadata().map(|m| m.len()).unwrap_or(0)));
            }
        }
        v.sort();
        v
    };
    let human = |len: u64| -> String {
        if len >= 1 << 20 {
            format!("{:.1}M", len as f64 / (1 << 20) as f64)
        } else {
            format!("{}K", len >> 10)
        }
    };
    let Some(t) = target else {
        let all = list(None);
        if all.is_empty() {
            eprintln!("mymux-attach: no history logs in {}", dir.display());
            return;
        }
        eprintln!(
            "history logs in {} (view with: less -R <file>):",
            dir.display()
        );
        for (p, len) in all {
            eprintln!("  {:>8}  {}", human(len), p.display());
        }
        return;
    };
    let short = match t.parse::<u32>() {
        Ok(n) => n & 0x3fff_ffff,
        Err(_) => {
            // Name prefix: names live only on live panes — ask ptyd.
            let Ok((client, _)) = Client::connect(&socket_path()).await else {
                eprintln!("mymux-attach: ptyd unreachable — use the numeric id (see `hist`).");
                std::process::exit(1);
            };
            let panes = client.list().await.unwrap_or_default();
            let m: Vec<_> = panes
                .iter()
                .filter(|p| !p.name.is_empty() && p.name.starts_with(&t))
                .collect();
            match m.as_slice() {
                [one] => one.id & 0x3fff_ffff,
                [] => {
                    eprintln!("mymux-attach: no pane matches '{t}'.");
                    std::process::exit(1);
                }
                many => {
                    eprintln!("mymux-attach: '{t}' is ambiguous:");
                    for p in many {
                        eprintln!("  {:<4} {}", p.id & 0x3fff_ffff, p.name);
                    }
                    std::process::exit(1);
                }
            }
        }
    };
    let files = list(Some(short));
    if files.is_empty() {
        eprintln!("mymux-attach: no history for pane {t}.");
        std::process::exit(1);
    }
    for (p, _) in files {
        println!("{}", p.display()); // stdout: pipeable into less -R / grep
    }
}

fn enter_raw() -> Option<RawGuard> {
    unsafe {
        if libc::isatty(0) == 0 {
            return None; // piped stdin: plain passthrough (scripting/tests)
        }
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) != 0 {
            return None;
        }
        let orig = t;
        let mut raw = t;
        libc::cfmakeraw(&mut raw);
        if libc::tcsetattr(0, libc::TCSANOW, &raw) != 0 {
            return None;
        }
        Some(RawGuard(orig))
    }
}

fn local_size() -> Option<(u16, u16)> {
    unsafe {
        if libc::isatty(1) == 0 {
            return None;
        }
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
            Some((ws.ws_col, ws.ws_row))
        } else {
            None
        }
    }
}

#[tokio::main]
async fn main() {
    let arg = std::env::args().nth(1);
    if matches!(arg.as_deref(), Some("-h") | Some("--help")) {
        eprintln!(
            "usage: mymux-attach [ls | hist [pane] | <short-id> | <full-id> | <name-prefix>]   (Ctrl-\\ detaches)"
        );
        return;
    }
    if arg.as_deref() == Some("hist") {
        hist_cmd(std::env::args().nth(2)).await;
        return;
    }

    let path = socket_path();
    let (client, mut events) = match Client::connect(&path).await {
        Ok(x) => x,
        Err(e) => {
            eprintln!(
                "mymux-attach: cannot reach mymux-ptyd at {}: {e}",
                path.display()
            );
            std::process::exit(1);
        }
    };

    let panes = client.list().await.unwrap_or_default();
    let short = |id: u32| id & 0x3fff_ffff;
    let print_panes = |panes: &[mymux_ptyd::proto::PaneInfo]| {
        eprintln!("panes (attach with: mymux-attach <short-id | name-prefix>):");
        for p in panes {
            let name = if p.name.is_empty() {
                "-"
            } else {
                p.name.as_str()
            };
            // ⌁ ephemeral panes vanish with their mymuxd; ∞ persistent stay.
            let kind = if p.is_ephemeral() { "⌁" } else { "∞" };
            eprintln!(
                "  {:<4} {} {:<20} pid {:<8} {}x{}  (id {})",
                short(p.id),
                kind,
                name,
                p.pid,
                p.cols,
                p.rows,
                p.id
            );
        }
    };

    let interactive = unsafe { libc::isatty(0) == 1 };
    let id: u32 = match arg.as_deref() {
        Some("ls") | Some("list") => {
            if panes.is_empty() {
                eprintln!("mymux-attach: no persistent panes.");
            } else {
                print_panes(&panes);
            }
            return;
        }
        None => {
            // Bare invocation: attach when unambiguous AND a human is driving;
            // piped stdin always lists (script-safe).
            if panes.len() == 1 && interactive {
                panes[0].id
            } else {
                if panes.is_empty() {
                    eprintln!("mymux-attach: no persistent panes.");
                } else {
                    print_panes(&panes);
                }
                return;
            }
        }
        Some(target) => {
            // Numeric: full id, else short id. Otherwise: unique name prefix.
            let by_num = target.parse::<u32>().ok().and_then(|n| {
                panes
                    .iter()
                    .find(|p| p.id == n)
                    .or_else(|| panes.iter().find(|p| short(p.id) == n))
            });
            match by_num {
                Some(p) => p.id,
                None => {
                    let matches: Vec<_> = panes
                        .iter()
                        .filter(|p| !p.name.is_empty() && p.name.starts_with(target))
                        .collect();
                    match matches.as_slice() {
                        [one] => one.id,
                        [] => {
                            eprintln!("mymux-attach: no pane matches '{target}'.");
                            if !panes.is_empty() {
                                print_panes(&panes);
                            }
                            std::process::exit(1);
                        }
                        many => {
                            eprintln!("mymux-attach: '{target}' is ambiguous:");
                            for p in many {
                                eprintln!("  {:<4} {}", short(p.id), p.name);
                            }
                            std::process::exit(1);
                        }
                    }
                }
            }
        }
    };
    if !panes.iter().any(|p| p.id == id) {
        eprintln!("mymux-attach: no pane {id}.");
        std::process::exit(1);
    }

    eprintln!("mymux-attach: attaching to {id} — Ctrl-\\ detaches.");

    // Size the pane to this terminal (shared with any connected UI, same as a
    // smaller `tmux attach` would).
    if let Some((cols, rows)) = local_size() {
        client.resize(id, cols, rows);
    }

    let _raw = enter_raw();

    // Faithful snapshot first, then live output.
    let snap = client.snapshot(id).await.unwrap_or_default();
    {
        let mut so = std::io::stdout().lock();
        let _ = so.write_all(&snap);
        let _ = so.flush();
    }

    static DONE: AtomicBool = AtomicBool::new(false);

    // stdin → pane (blocking reads on a plain thread; exits with the process).
    let stdin_client = client.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut si = std::io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            match si.read(&mut buf) {
                Ok(0) | Err(_) => break, // terminal/pipe gone → detach
                Ok(n) => {
                    let chunk = &buf[..n];
                    if chunk.contains(&0x1c) {
                        break; // Ctrl-\ : detach
                    }
                    stdin_client.input(id, chunk);
                }
            }
        }
        DONE.store(true, Ordering::SeqCst);
    });

    // SIGWINCH → propagate the new size.
    let mut winch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()).ok();

    loop {
        tokio::select! {
            ev = events.recv() => match ev {
                Some(PtydEvent::Output { id: pid, data }) if pid == id => {
                    let mut so = std::io::stdout().lock();
                    let _ = so.write_all(&data);
                    let _ = so.flush();
                }
                Some(PtydEvent::Exit { id: pid }) if pid == id => {
                    eprintln!("\r\nmymux-attach: pane exited.");
                    break;
                }
                Some(PtydEvent::Closed) | None => {
                    eprintln!("\r\nmymux-attach: ptyd connection lost.");
                    break;
                }
                Some(_) => {}
            },
            _ = async { if let Some(w) = winch.as_mut() { w.recv().await } else { std::future::pending().await } } => {
                if let Some((cols, rows)) = local_size() {
                    client.resize(id, cols, rows);
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(120)) => {
                if DONE.load(Ordering::SeqCst) {
                    eprintln!("\r\nmymux-attach: detached (pane keeps running).");
                    break;
                }
            }
        }
    }
}
