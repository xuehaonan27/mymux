//! LSP proxy: supervise a language server per workspace root and bridge it to
//! the editor over a WebSocket. The socket speaks **raw, standard LSP** — each
//! WS text frame is one JSON-RPC message, no `Content-Length` headers (those
//! exist only on the child's stdio) — so any future frontend can talk to it
//! unchanged (see docs/LSP-PLAN.md).
//!
//! C1 scope: rust-analyzer, resolved from PATH, one server per connection,
//! killed when the socket closes.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::response::Response;
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

use crate::fs::root_for;

#[derive(Deserialize)]
pub struct LspQuery {
    pane: Option<u32>,
    #[serde(default = "default_lang")]
    lang: String,
}
fn default_lang() -> String {
    "rust".to_string()
}

/// Languages the proxy can launch. Servers come from managed packages first
/// (the mymux-pkg contract), with a PATH heuristic as fallback.
fn server_cmd(lang: &str) -> Option<(&'static str, &'static [&'static str])> {
    match lang {
        "rust" => Some(("rust-analyzer", &[])),
        "go" => Some(("gopls", &[])),
        "python" => Some(("pyright-langserver", &["--stdio"])),
        "c" | "cpp" => Some(("clangd", &[])),
        _ => None,
    }
}

/// The package contract directory (docs/PKG-SPEC.md). Mirrored from
/// mymux-pkg on purpose — the two sides share the CONVENTION, not code.
fn pkgs_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MYMUX_PKG_DIR") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(d).join("mymux/pkgs"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/mymux/pkgs"))
}

/// A managed package's server binary for `lang`, if one is installed.
/// Invalid or unknown packages are skipped (contract: consumers are lenient).
fn managed_server(lang: &str) -> Option<(PathBuf, Vec<String>)> {
    #[derive(serde::Deserialize)]
    struct Pkg {
        v: u32,
        kind: String,
        #[serde(default)]
        langs: Vec<String>,
        bin: String,
        #[serde(default)]
        args: Vec<String>,
    }
    for e in std::fs::read_dir(pkgs_dir()?).ok()?.flatten() {
        let dir = e.path();
        let Ok(s) = std::fs::read_to_string(dir.join("pkg.json")) else {
            continue;
        };
        let Ok(p) = serde_json::from_str::<Pkg>(&s) else {
            continue;
        };
        if p.v != 1 || p.kind != "lsp-server" || p.bin.is_empty() {
            continue;
        }
        if !p.langs.iter().any(|l| l == lang) {
            continue;
        }
        let bin = dir.join(p.bin);
        if bin.is_file() {
            return Some((bin, p.args));
        }
    }
    None
}

/// Resolve the server launch (binary + args) for a language: a managed
/// package first — including languages the built-in table doesn't know, when
/// the user bound one via `mymux-pkg lang` (its manifest carries the launch
/// args) — then the PATH heuristic for the built-in table (with a
/// `--version` probe: a rustup shim can exist without the component; managed
/// installs were verified at install time and skip the probe).
async fn resolve_server(lang: &str) -> Option<(PathBuf, Vec<String>)> {
    if let Some((bin, mut args)) = managed_server(lang) {
        // Manifests written before `args` existed have none; for built-in
        // languages fall back to the table defaults (pyright needs --stdio).
        if args.is_empty() {
            if let Some((_, table_args)) = server_cmd(lang) {
                args = table_args.iter().map(|s| s.to_string()).collect();
            }
        }
        return Some((bin, args));
    }
    let (cmd, args) = server_cmd(lang)?;
    let bin = find_server(cmd)?;
    let runs = Command::new(&bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    runs.then(|| (bin, args.iter().map(|s| s.to_string()).collect()))
}

/// Locate a server binary. Under systemd --user the daemon's PATH is minimal
/// (no `~/.cargo/bin` etc.), so after env PATH we search the usual per-user
/// tool directories explicitly.
fn find_server(cmd: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("go/bin"));
    }
    dirs.into_iter().map(|d| d.join(cmd)).find(|p| {
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    })
}

/// PATH for spawned servers. npm-installed servers are `#!/usr/bin/env node`
/// scripts, and under systemd --user the daemon's PATH has no node — extend
/// it with the usual per-user tool dirs (newest nvm node first).
fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let mut nvm: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node"))
            .map(|rd| rd.flatten().map(|e| e.path().join("bin")).collect())
            .unwrap_or_default();
        nvm.sort();
        if let Some(newest) = nvm.pop() {
            dirs.push(newest);
        }
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("go/bin"));
    }
    std::env::join_paths(dirs.iter().filter(|d| d.is_dir()))
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// The nearest ancestor of `cwd` (inclusive) containing one of `markers`.
fn nearest(cwd: &Path, markers: &[&str]) -> Option<PathBuf> {
    let mut dir: Option<&Path> = Some(cwd);
    while let Some(d) = dir {
        if markers.iter().any(|m| d.join(m).exists()) {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// The workspace root for a language, walking up from the pane's cwd. For rust
/// that's the OUTERMOST ancestor with a Cargo.toml (the cargo workspace root).
async fn lsp_root(pane: Option<u32>, lang: &str) -> Option<PathBuf> {
    let cwd = root_for(pane).await;
    match lang {
        "rust" => {
            let mut found = None;
            let mut dir: Option<&Path> = Some(cwd.as_path());
            while let Some(d) = dir {
                if d.join("Cargo.toml").exists() {
                    found = Some(d.to_path_buf());
                }
                dir = d.parent();
            }
            found
        }
        "go" => nearest(&cwd, &["go.mod"]),
        "python" => {
            Some(nearest(&cwd, &["pyproject.toml", "setup.py", "requirements.txt"]).unwrap_or(cwd))
        }
        "c" | "cpp" => Some(nearest(&cwd, &["compile_commands.json"]).unwrap_or(cwd)),
        _ => Some(cwd),
    }
}

#[derive(Serialize)]
pub struct LspInfo {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// True when the language is supported and `mymux-pkg` has a recipe —
    /// the UI can offer a one-click install.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    installable: bool,
    /// Language-server workspace root (rootUri = `file://{root}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    /// The pane's cwd — what the code panel's relative paths resolve against.
    #[serde(skip_serializing_if = "Option::is_none")]
    fs_root: Option<String>,
}

fn unavailable(reason: String, fs_root: Option<String>, installable: bool) -> Json<LspInfo> {
    Json(LspInfo {
        available: false,
        reason: Some(reason),
        installable,
        root: None,
        fs_root,
    })
}

/// `GET /lsp/info?pane=&lang=` — can we serve LSP for this pane, and where from?
pub async fn info(Query(q): Query<LspQuery>) -> Json<LspInfo> {
    let fs_root = root_for(q.pane).await.display().to_string();
    if resolve_server(&q.lang).await.is_none() {
        // Not resolvable. Built-in languages have a one-recipe install; other
        // languages need the packages panel + a `mymux-pkg lang` binding.
        return match server_cmd(&q.lang) {
            Some((cmd, _)) => {
                unavailable(format!("{cmd} is not installed"), Some(fs_root), true)
            }
            None => unavailable(
                format!(
                    "no language server bound for {} (install one in the packages panel, then `mymux-pkg lang <pkg> {}`)",
                    q.lang, q.lang
                ),
                Some(fs_root),
                false,
            ),
        };
    }
    match lsp_root(q.pane, &q.lang).await {
        Some(root) => Json(LspInfo {
            available: true,
            reason: None,
            installable: false,
            root: Some(root.display().to_string()),
            fs_root: Some(fs_root),
        }),
        None => unavailable(
            "no project root found here".to_string(),
            Some(fs_root),
            false,
        ),
    }
}

#[derive(serde::Deserialize)]
pub struct InstallReq {
    lang: String,
}

#[derive(Serialize)]
pub struct InstallResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    err: Option<String>,
}

/// `POST /lsp/install {lang}` — run `mymux-pkg install --lang <lang>` (sibling
/// binary next to mymuxd, else PATH). The daemon embeds no acquisition logic;
/// it is just one caller of the decoupled package CLI.
pub async fn install(axum::Json(req): axum::Json<InstallReq>) -> Json<InstallResp> {
    if server_cmd(&req.lang).is_none() {
        return Json(InstallResp {
            ok: false,
            err: Some(format!("unsupported language: {}", req.lang)),
        });
    }
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("mymux-pkg")))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("mymux-pkg"));
    let out = Command::new(bin)
        .args(["install", "--lang", &req.lang])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => Json(InstallResp {
            ok: true,
            err: None,
        }),
        Ok(o) => {
            let tail: String = String::from_utf8_lossy(&o.stderr)
                .lines()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" · ");
            Json(InstallResp {
                ok: false,
                err: Some(if tail.is_empty() {
                    "install failed".into()
                } else {
                    tail
                }),
            })
        }
        Err(e) => Json(InstallResp {
            ok: false,
            err: Some(format!("mymux-pkg is not installed: {e}")),
        }),
    }
}

/// `GET /lsp?pane=&lang=` — WebSocket upgrade; one language server per socket.
pub async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<LspQuery>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, q))
}

async fn handle(socket: WebSocket, q: LspQuery) {
    let Some((bin, args)) = resolve_server(&q.lang).await else {
        return;
    };
    let Some(root) = lsp_root(q.pane, &q.lang).await else {
        return;
    };

    let spawn = Command::new(&bin)
        .args(&args)
        .current_dir(&root)
        .env("PATH", augmented_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mymuxd: lsp spawn {}: {e}", bin.display());
            return;
        }
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");

    let (mut tx, mut rx) = socket.split();

    // Server stdout → WS: unframe Content-Length messages, one per WS frame.
    let mut send_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        while let Some(payload) = read_lsp_frame(&mut reader).await {
            if tx.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });

    // WS → server stdin: frame each JSON message with Content-Length.
    loop {
        tokio::select! {
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let head = format!("Content-Length: {}\r\n\r\n", t.as_bytes().len());
                    if stdin.write_all(head.as_bytes()).await.is_err()
                        || stdin.write_all(t.as_bytes()).await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {} // ping/pong handled by axum
                Some(Err(_)) => break,
            },
            _ = &mut send_task => break, // server exited
        }
    }
    send_task.abort();
    let _ = child.kill().await; // kill + reap; the editor is gone
}

/// Read one `Content-Length`-framed LSP message from the server; `None` on EOF.
async fn read_lsp_frame(r: &mut BufReader<ChildStdout>) -> Option<String> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).await.ok()? == 0 {
            return None; // EOF
        }
        let line = line.trim_end();
        if line.is_empty() {
            break; // end of headers
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            len = v.trim().parse().ok();
        }
    }
    let mut buf = vec![0u8; len?];
    r.read_exact(&mut buf).await.ok()?;
    String::from_utf8(buf).ok()
}
