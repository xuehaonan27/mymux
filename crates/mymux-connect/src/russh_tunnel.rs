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
    Error(String),
}

/// Terminal states that shouldn't be retried in a tight loop (need user action).
fn is_fatal(s: &Status) -> bool {
    matches!(
        s,
        Status::AuthFailed | Status::HostKeyUnknown { .. } | Status::HostKeyMismatch
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

/// One connect → auth → forward cycle. Returns `Err(Status)` describing why it
/// ended (the supervisor decides whether to retry).
async fn connect_and_serve(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    status: &mpsc::Sender<Status>,
) -> Result<(), Status> {
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

    // Best-effort: start the remote daemon over a session channel (fire-and-forget).
    if let Ok(ch) = handle.channel_open_session().await {
        let _ = ch
            .exec(false, cfg.remote_daemon_cmd.clone().into_bytes())
            .await;
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
