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

/// Languages the proxy can launch (C1: rust only; C3 adds more + VSIX install).
fn server_cmd(lang: &str) -> Option<(&'static str, &'static [&'static str])> {
    match lang {
        "rust" => Some(("rust-analyzer", &[])),
        _ => None,
    }
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
        _ => Some(cwd),
    }
}

#[derive(Serialize)]
pub struct LspInfo {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Language-server workspace root (rootUri = `file://{root}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    /// The pane's cwd — what the code panel's relative paths resolve against.
    #[serde(skip_serializing_if = "Option::is_none")]
    fs_root: Option<String>,
}

fn unavailable(reason: String, fs_root: Option<String>) -> Json<LspInfo> {
    Json(LspInfo {
        available: false,
        reason: Some(reason),
        root: None,
        fs_root,
    })
}

/// `GET /lsp/info?pane=&lang=` — can we serve LSP for this pane, and where from?
pub async fn info(Query(q): Query<LspQuery>) -> Json<LspInfo> {
    let Some((cmd, _)) = server_cmd(&q.lang) else {
        return unavailable(format!("unsupported language: {}", q.lang), None);
    };
    let fs_root = root_for(q.pane).await.display().to_string();
    // The binary must actually RUN — a rustup shim can be on PATH while the
    // component is missing, so probe `--version` on the resolved path.
    let Some(bin) = find_server(cmd) else {
        return unavailable(format!("{cmd} is not installed"), Some(fs_root));
    };
    let runs = Command::new(&bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    if !runs {
        return unavailable(format!("{cmd} is not installed"), Some(fs_root));
    }
    match lsp_root(q.pane, &q.lang).await {
        Some(root) => Json(LspInfo {
            available: true,
            reason: None,
            root: Some(root.display().to_string()),
            fs_root: Some(fs_root),
        }),
        None => unavailable("no project root found here".to_string(), Some(fs_root)),
    }
}

/// `GET /lsp?pane=&lang=` — WebSocket upgrade; one language server per socket.
pub async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<LspQuery>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, q))
}

async fn handle(socket: WebSocket, q: LspQuery) {
    let Some((cmd, args)) = server_cmd(&q.lang) else {
        return;
    };
    let Some(bin) = find_server(cmd) else { return };
    let Some(root) = lsp_root(q.pane, &q.lang).await else {
        return;
    };

    let spawn = Command::new(&bin)
        .args(args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mymuxd: lsp spawn {cmd}: {e}");
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
