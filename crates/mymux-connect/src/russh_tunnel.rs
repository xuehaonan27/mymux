//! In-process SSH tunnel via **russh** — a local `-L` forward to the remote
//! `mymuxd`, with in-app key + passphrase auth and `known_hosts` host-key
//! verification. This is the foundation for the native host manager (approach B);
//! the ssh-binary [`run_tunnel`](crate::run_tunnel) stays as a fallback until this
//! path is proven end-to-end.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Config, Handler};
use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::ssh_key::PublicKey;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use serde::Serialize;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// How to reach a host and what to forward.
#[derive(Clone)]
pub struct HostConfig {
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub identity_path: PathBuf,
    /// `known_hosts` file to verify against (default `~/.ssh/known_hosts`).
    pub known_hosts_path: PathBuf,
    pub local_port: u16,
    pub remote_port: u16,
    pub remote_daemon_cmd: String,
    /// Trust + record an unknown host key (TOFU). `false` → reject an unknown key
    /// and report its fingerprint so the UI can ask the user first.
    pub trust_unknown_host_key: bool,
}

/// Connection lifecycle, surfaced to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Connecting,
    Connected,
    Reconnecting,
    /// Wrong passphrase / key, or the server rejected our key.
    AuthFailed,
    /// Host key not in `known_hosts`; ask the user, then retry with trust=true.
    HostKeyUnknown {
        fingerprint: String,
    },
    /// Host key CHANGED vs `known_hosts` — possible MITM; refuse.
    HostKeyMismatch,
    /// SSH works, but nothing listens on the remote daemon port — mymuxd is
    /// not running/installed on the host. Needs user action; no retry loop.
    DaemonUnreachable,
    /// The zero-touch installer is running on the host (daemon was missing);
    /// the connect retries once it finishes.
    Installing,
    Error(String),
}

/// Terminal states that shouldn't be retried in a tight loop (need user action).
fn is_fatal(s: &Status) -> bool {
    matches!(
        s,
        Status::AuthFailed
            | Status::HostKeyUnknown { .. }
            | Status::HostKeyMismatch
            | Status::DaemonUnreachable
    )
}

/// russh client handler — its whole job is verifying the server key.
struct Client {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    trust_unknown: bool,
    /// Why we rejected the key (read by the supervisor after connect fails).
    reject: Arc<Mutex<Option<Status>>>,
}

impl Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        use russh::keys::Error as KeyErr;
        let checked = check_known_hosts_path(&self.host, self.port, key, &self.known_hosts_path);
        if matches!(checked, Ok(true)) {
            return Ok(true); // known + matches
        }
        if matches!(checked, Err(KeyErr::KeyChanged { .. })) {
            // Same host, different key → changed / MITM.
            *self.reject.lock().unwrap() = Some(Status::HostKeyMismatch);
            return Ok(false);
        }
        // Unknown host: not in the file, or the file doesn't exist yet.
        if self.trust_unknown {
            let _ = learn_known_hosts_path(&self.host, self.port, key, &self.known_hosts_path);
            Ok(true)
        } else {
            let fp = key.fingerprint(HashAlg::Sha256).to_string();
            *self.reject.lock().unwrap() = Some(Status::HostKeyUnknown { fingerprint: fp });
            Ok(false)
        }
    }
}

/// Connect to the host and authenticate with the (UI-entered) passphrase —
/// shared by the tunnel loop and one-off remote commands ([`exec_script`]).
async fn ssh_connect(
    cfg: &HostConfig,
    passphrase: Option<&str>,
) -> Result<client::Handle<Client>, Status> {
    // Decrypt the key with the (UI-entered) passphrase.
    let key = load_secret_key(&cfg.identity_path, passphrase).map_err(|_| Status::AuthFailed)?;
    let key = Arc::new(key);

    let config = Arc::new(Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        inactivity_timeout: Some(Duration::from_secs(90)),
        ..Default::default()
    });

    let reject = Arc::new(Mutex::new(None));
    let handler = Client {
        host: cfg.hostname.clone(),
        port: cfg.port,
        known_hosts_path: cfg.known_hosts_path.clone(),
        trust_unknown: cfg.trust_unknown_host_key,
        reject: reject.clone(),
    };

    let mut handle = client::connect(config, (cfg.hostname.as_str(), cfg.port), handler)
        .await
        .map_err(|e| {
            reject
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Status::Error(format!("connect: {e:?}")))
        })?;

    // Public-key auth (RSA needs a hash choice; ed25519 etc. don't).
    let hash_alg = if key.algorithm().is_rsa() {
        handle
            .best_supported_rsa_hash()
            .await
            .ok()
            .flatten()
            .flatten()
    } else {
        None
    };
    let auth = handle
        .authenticate_publickey(&cfg.user, PrivateKeyWithHashAlg::new(key, hash_alg))
        .await
        .map_err(|e| Status::Error(format!("auth: {e:?}")))?;
    if !auth.success() {
        return Err(Status::AuthFailed);
    }
    Ok(handle)
}

/// Run a script on the host via `bash -s`, feeding it over the channel and
/// collecting stdout+stderr. Ok(output) on exit 0; the error carries the exit
/// code plus the output tail otherwise. Times out after `limit`.
pub async fn exec_script(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    script: &str,
    limit: Duration,
) -> Result<String, Status> {
    tokio::time::timeout(limit, exec_script_inner(cfg, passphrase, script))
        .await
        .map_err(|_| Status::Error(format!("script timed out after {}s", limit.as_secs())))?
}

async fn exec_script_inner(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    script: &str,
) -> Result<String, Status> {
    let handle = ssh_connect(cfg, passphrase).await?;
    let mut ch = handle
        .channel_open_session()
        .await
        .map_err(|e| Status::Error(format!("channel: {e:?}")))?;
    ch.exec(false, b"bash -s")
        .await
        .map_err(|e| Status::Error(format!("exec: {e:?}")))?;
    ch.data(script.as_bytes())
        .await
        .map_err(|e| Status::Error(format!("stdin: {e:?}")))?;
    ch.eof()
        .await
        .map_err(|e| Status::Error(format!("eof: {e:?}")))?;
    let mut out = String::new();
    let mut code = None;
    // Read until the channel closes (or the stream ends): Eof only means the
    // output is done — exit-status may still be in flight after it.
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => out.push_str(&String::from_utf8_lossy(&data)),
            russh::ChannelMsg::ExtendedData { data, .. } => {
                out.push_str(&String::from_utf8_lossy(&data))
            }
            russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    match code {
        Some(0) => Ok(out),
        Some(c) => {
            let tail: Vec<String> = out.lines().rev().take(5).map(str::to_string).collect();
            let mut tail: Vec<_> = tail.into_iter().rev().collect();
            let _ = &mut tail;
            Err(Status::Error(format!(
                "script exited {c}: {}",
                tail.join(" · ")
            )))
        }
        None => Err(Status::Error("script ended without an exit status".into())),
    }
}

/// One connect → auth → forward cycle. Returns `Err(Status)` describing why it
/// ended (the supervisor decides whether to retry).
async fn connect_and_serve(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    status: &mpsc::Sender<Status>,
) -> Result<(), Status> {
    let handle = ssh_connect(cfg, passphrase).await?;

    // Best-effort: start the remote daemon over a session channel (fire-and-forget).
    if let Ok(ch) = handle.channel_open_session().await {
        let _ = ch
            .exec(false, cfg.remote_daemon_cmd.clone().into_bytes())
            .await;
    }

    // The tunnel is only useful if mymuxd actually answers on the remote
    // port — otherwise "Connected" drops the user into a workspace that can
    // never attach. Probe with a direct-tcpip channel, retrying while the
    // daemon we just exec'd warms up; give up as a FATAL state (user must
    // install/start mymuxd) instead of a silent forever-reconnect.
    let mut daemon_ok = false;
    for _ in 0..14 {
        match tokio::time::timeout(
            Duration::from_secs(3),
            handle.channel_open_direct_tcpip("localhost", cfg.remote_port as u32, "127.0.0.1", 0),
        )
        .await
        {
            Ok(Ok(ch)) => {
                let _ = ch.close().await;
                daemon_ok = true;
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
    if !daemon_ok {
        return Err(Status::DaemonUnreachable);
    }

    let listener = TcpListener::bind(("127.0.0.1", cfg.local_port))
        .await
        .map_err(|e| Status::Error(format!("bind :{}: {e}", cfg.local_port)))?;
    let _ = status.send(Status::Connected).await;

    // Serve the local forward until the ssh session dies. Two concurrent tasks:
    // accept new local conns → direct-tcpip channels; and a periodic health probe
    // so a drop with no active connection is still detected promptly.
    let accept = async {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => continue,
            };
            match handle
                .channel_open_direct_tcpip("localhost", cfg.remote_port as u32, "127.0.0.1", 0)
                .await
            {
                Ok(ch) => {
                    tokio::spawn(async move {
                        let mut stream = ch.into_stream();
                        let _ = copy_bidirectional(&mut sock, &mut stream).await;
                    });
                }
                Err(_) => return Status::Reconnecting, // session gone
            }
        }
    };
    let health = async {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            // Probe liveness with a session channel; the timeout guards against a
            // hang on a half-dead socket (russh may not have noticed the drop yet).
            match tokio::time::timeout(Duration::from_secs(3), handle.channel_open_session()).await
            {
                Ok(Ok(_ch)) => {}                 // healthy (channel closes on drop)
                _ => return Status::Reconnecting, // timed out or errored → session dead
            }
        }
    };

    let reason = tokio::select! {
        r = accept => r,
        r = health => r,
    };
    Err(reason)
}

/// The box-side installer, embedded at build time — the same script that
/// scripts/mymux-bootstrap.sh drives over ssh.
const INSTALL_SCRIPT: &str = include_str!("../../../scripts/mymux-install-remote.sh");

/// Daemon start failed: install mymuxd when it's simply absent. Ok(true) = the
/// installer ran (the supervisor retries the connect); Ok(false) = a binary
/// exists, so the failure is something else (report the original status).
async fn maybe_install(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    status: &mpsc::Sender<Status>,
) -> Result<bool, String> {
    const PROBE: &str =
        "if command -v mymuxd >/dev/null 2>&1 || [ -x ~/.local/bin/mymuxd ]; then echo present; fi";
    let probe = exec_script(cfg, passphrase, PROBE, Duration::from_secs(20))
        .await
        .map_err(|e| format!("probe failed: {e:?}"))?;
    if probe.contains("present") {
        return Ok(false);
    }
    let _ = status.send(Status::Installing).await;
    // A source build can take many minutes; surface the script's own notes.
    let out = exec_script(cfg, passphrase, INSTALL_SCRIPT, Duration::from_secs(1200))
        .await
        .map_err(|e| format!("installer failed: {e:?}"))?;
    for line in out.lines().take(12) {
        eprintln!("mymux-connect install: {line}");
    }
    Ok(true)
}

/// Supervise the russh tunnel: connect, serve, and reconnect with capped backoff.
/// Fatal states (bad auth / unknown or changed host key) stop the loop and are
/// reported so the UI can prompt; transient drops reconnect silently.
pub async fn run_russh_tunnel(
    cfg: HostConfig,
    passphrase: Option<String>,
    status: mpsc::Sender<Status>,
) {
    let min = Duration::from_millis(500);
    let max = Duration::from_secs(30);
    let mut backoff = min;

    loop {
        let _ = status.send(Status::Connecting).await;
        let started = Instant::now();
        let end = connect_and_serve(&cfg, passphrase.as_deref(), &status)
            .await
            .err()
            .unwrap_or(Status::Reconnecting);

        if is_fatal(&end) {
            // A missing daemon is fixable without the user: push the
            // self-contained installer over this same SSH connection, then
            // retry the whole cycle — zero-touch first connect.
            if matches!(end, Status::DaemonUnreachable) {
                match maybe_install(&cfg, passphrase.as_deref(), &status).await {
                    Ok(true) => {
                        backoff = min;
                        continue;
                    }
                    Ok(false) => {} // binary exists; the failure is elsewhere
                    Err(e) => {
                        let _ = status.send(Status::Error(e)).await;
                        return;
                    }
                }
            }
            let _ = status.send(end).await;
            return; // wait for the UI to re-drive (new passphrase / trust host key)
        }
        let _ = status.send(end).await;

        if started.elapsed() >= Duration::from_secs(10) {
            backoff = min; // it was up a while — a transient drop
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(max);
    }
}
