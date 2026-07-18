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
    /// Local forward port is held at bind time (a crashed instance of ours,
    /// or another app). Made FATAL: retrying forever with the same cached
    /// port — re-sending Connecting over the transient bind error — is how
    /// host cards used to hang on "connecting" indefinitely.
    BindFailed(u16),
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
            | Status::BindFailed(_)
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
        // 2 minutes of silence before russh itself gives up — jittery NATs
        // eat one 45s stretch all the time (3 was far too trigger-happy).
        keepalive_max: 8,
        // No inactivity timeout: the session doubles as the host's persistent
        // MASTER (ControlMaster semantics) — an idle master between forward
        // cycles must survive, or every reconnect costs a fresh auth.
        inactivity_timeout: None,
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

    // No timeout exists inside russh's connect path: a blackholed SYN or a
    // banner-silent listener hangs the supervisor forever. Bound the whole
    // TCP+banner handshake ourselves.
    let mut handle = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(config, (cfg.hostname.as_str(), cfg.port), handler),
    )
    .await
    .map_err(|_| {
        Status::Error(
            "connect timed out (20s) — host unreachable, or a listener that never speaks SSH"
                .to_string(),
        )
    })?
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

/// The persistent per-host SSH master (russh-world ControlMaster): one
/// authenticated connection cached for the app's session. Forward cycles and
/// one-off exec calls lease CHANNELS off it — a forward restart reuses the
/// master (never a fresh auth) until the master's own probe fails; only that
/// case re-authenticates. russh's Handle is !Clone but all channel-opening
/// methods take &self, so one Arc<Handle> multiplexes everything.
pub struct Master {
    cfg: HostConfig,
    passphrase: tokio::sync::Mutex<Option<String>>,
    sess: tokio::sync::Mutex<Option<Arc<client::Handle<Client>>>>,
}

impl Master {
    pub fn new(cfg: HostConfig, passphrase: Option<String>) -> Self {
        Self {
            cfg,
            passphrase: tokio::sync::Mutex::new(passphrase),
            sess: tokio::sync::Mutex::new(None),
        }
    }

    /// The live session, establishing it single-flight on first use (or after
    /// invalidate()). Liveness is proven with a cheap session-channel probe —
    /// is_closed alone misses half-dead sockets the kernel hasn't told us of.
    /// (Module-private: russh's Handle must not leak our public API surface.)
    async fn lease(&self) -> Result<Arc<client::Handle<Client>>, Status> {
        let mut g = self.sess.lock().await;
        if let Some(h) = g.as_ref() {
            if !h.is_closed() {
                if let Ok(Ok(ch)) =
                    tokio::time::timeout(Duration::from_secs(5), h.channel_open_session()).await
                {
                    drop(ch);
                    return Ok(h.clone());
                }
            }
            *g = None; // dead master — fall through to one fresh auth
        }
        let pass = self.passphrase.lock().await;
        let h = ssh_connect(&self.cfg, pass.as_deref()).await?;
        let h = Arc::new(h);
        *g = Some(h.clone());
        Ok(h)
    }

    /// Drop the cached session (a failed channel told us it's dead); the next
    /// lease re-authenticates.
    async fn invalidate(&self) {
        *self.sess.lock().await = None;
    }
}

/// Run `command` over the master with a byte stream on stdin (binary-safe).
/// One retry on channel-open failure: the lease probe may pass right as the
/// socket dies; anything after exec start is NOT retried (not idempotent).
pub async fn master_exec_bytes(
    master: &Master,
    command: &str,
    stdin: &[u8],
    limit: Duration,
) -> Result<String, Status> {
    tokio::time::timeout(limit, master_exec_inner(master, command, stdin))
        .await
        .map_err(|_| Status::Error(format!("command timed out after {}s", limit.as_secs())))?
}

/// `master_exec_bytes` for shell scripts (`bash -s`).
pub async fn master_exec_script(
    master: &Master,
    script: &str,
    limit: Duration,
) -> Result<String, Status> {
    master_exec_bytes(master, "bash -s", script.as_bytes(), limit).await
}

async fn master_exec_inner(master: &Master, command: &str, stdin: &[u8]) -> Result<String, Status> {
    let mut handle = master.lease().await?;
    let mut ch = match handle.channel_open_session().await {
        Ok(ch) => ch,
        Err(e) => {
            master.invalidate().await;
            handle = master.lease().await?;
            handle
                .channel_open_session()
                .await
                .map_err(|_| Status::Error(format!("channel: {e:?}")))?
        }
    };
    ch.exec(false, command.as_bytes())
        .await
        .map_err(|e| Status::Error(format!("exec: {e:?}")))?;
    ch.data(stdin)
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
            let tail: Vec<_> = tail.into_iter().rev().collect();
            Err(Status::Error(format!(
                "script exited {c}: {}",
                tail.join(" · ")
            )))
        }
        None => Err(Status::Error("script ended without an exit status".into())),
    }
}

/// One-shot exec Script (no shared master): kept for the disconnected paths
/// (e.g. uninstall without a live tunnel) and the exec_script harness.
pub async fn exec_script(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    script: &str,
    limit: Duration,
) -> Result<String, Status> {
    let m = Master::new(cfg.clone(), passphrase.map(str::to_string));
    master_exec_script(&m, script, limit).await
}

/// One-shot exec Bytes (no shared master), see [`exec_script`].
pub async fn exec_bytes(
    cfg: &HostConfig,
    passphrase: Option<&str>,
    command: &str,
    stdin: &[u8],
    limit: Duration,
) -> Result<String, Status> {
    let m = Master::new(cfg.clone(), passphrase.map(str::to_string));
    master_exec_bytes(&m, command, stdin, limit).await
}
/// One connect → auth → forward cycle, leasing channels off the host's
/// persistent Master (a reconnect after a transient drop re-auths nothing).
/// Returns `Err(Status)` describing why it ended (the supervisor decides
/// whether to retry).
async fn connect_and_serve(
    cfg: &HostConfig,
    master: &Master,
    status: &mpsc::Sender<Status>,
) -> Result<(), Status> {
    let handle = master.lease().await?;

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
        let _ = status
            .send(Status::Error(format!(
                "mymuxd not answering on remote port {} after 14 probes — running the installer next",
                cfg.remote_port
            )))
            .await;
        return Err(Status::DaemonUnreachable);
    }

    let listener = match TcpListener::bind(("127.0.0.1", cfg.local_port)).await {
        Ok(l) => l,
        Err(e) => {
            let _ = status
                .send(Status::Error(format!(
                    "bind 127.0.0.1:{} failed ({e}) — port is held by an earlier mymux instance or another app",
                    cfg.local_port
                )))
                .await;
            return Err(Status::BindFailed(cfg.local_port));
        }
    };
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
                Err(_) => {
                    master.invalidate().await; // session gone
                    let _ = status
                        .send(Status::Error(
                            "the SSH server dropped our forward channel — reconnecting".to_string(),
                        ))
                        .await;
                    return Status::Reconnecting;
                }
            }
        }
    };
    let health = async {
        // Two-strike rule + 4s budget: one jittery second must never declare
        // a live link dead (that loop is what painted 'connecting' on healthy
        // but lossy NAT paths). russh's own keepalive (15s × 8) keeps the
        // final say on a truly dead socket.
        let mut misses = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            // Probe liveness with a session channel; the timeout guards against a
            // hang on a half-dead socket (russh may not have noticed the drop yet).
            match tokio::time::timeout(Duration::from_secs(4), handle.channel_open_session()).await
            {
                Ok(Ok(_ch)) => {
                    misses = 0; // healthy (channel closes on drop)
                }
                _ => {
                    misses += 1;
                    if misses < 2 {
                        let _ = status
                            .send(Status::Error(
                                "health probe missed once — double-checking before declaring the link dead"
                                    .to_string(),
                            ))
                            .await;
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                    master.invalidate().await;
                    let _ = status
                        .send(Status::Error(
                            "two consecutive health probes timed out — the link is down; reconnecting"
                                .to_string(),
                        ))
                        .await;
                    return Status::Reconnecting;
                }
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

/// The box-side UNinstaller, embedded at build time. Driven two ways (see
/// scripts/mymux-uninstall-remote.sh): `--probe` is a read-only work/artifact
/// report that becomes the UI's "work is running" warning; `--yes` performs
/// the removal after the user confirms.
pub const UNINSTALL_SCRIPT: &str = include_str!("../../../scripts/mymux-uninstall-remote.sh");

/// The probe report, digested for the UI: what WORK dies on uninstall, what
/// FILES get removed, what is deliberately kept.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorkReport {
    /// Human-readable live work lines, e.g. "tmux main:1.0 — zsh (window: code)".
    pub work: Vec<String>,
    /// "mymuxd.service: active" — unit states on the host.
    pub services: Vec<String>,
    /// Paths the uninstall removes (binaries, units, state, history…).
    pub artifacts: Vec<String>,
    /// Paths deliberately left behind (env config, linger).
    pub keeps: Vec<String>,
}

impl WorkReport {
    pub fn has_work(&self) -> bool {
        !self.work.is_empty()
    }
}

/// Parse the TAB-row output of `mymux-uninstall-remote.sh --probe`. Unknown
/// row kinds are ignored so an older app can read a newer script's report.
pub fn parse_probe(out: &str) -> WorkReport {
    let mut r = WorkReport::default();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.as_slice() {
            ["pane", "tmux", ref_, cmd, win] => {
                r.work.push(format!("tmux {ref_} — {cmd} (window: {win})"));
            }
            ["pane", "ptyd", short, kind, name, pid] => {
                let label = if *kind == "∞" {
                    "persistent shell"
                } else {
                    "shell"
                };
                let name = if *name == "-" { "unnamed" } else { name };
                r.work.push(format!("{label} “{name}” ({pid}, id {short})"));
            }
            ["svc", unit, state] => r.services.push(format!("{unit}: {state}")),
            ["proc", name, n] if *n != "0" => {
                r.services.push(format!("{name}: {n} process(es) running"));
            }
            ["bin", p] | ["unit", p] | ["dir", p] | ["file", p] => {
                r.artifacts.push((*p).to_string());
            }
            ["keep", p] => r.keeps.push((*p).to_string()),
            _ => {}
        }
    }
    r
}

/// The self-contained daemon bundle shipped to hosts whose mymuxd is missing
/// or outdated — musl-static linux binaries + manifest, produced by
/// scripts/build-daemon-bundle.sh and embedded at app build time. Empty when
/// the app was built without it (the install path then reports why).
#[cfg(daemon_bundle)]
static DAEMON_BUNDLE: &[u8] =
    include_bytes!("../../../src-tauri/resources/daemon/linux-x86_64.tar.gz");
#[cfg(not(daemon_bundle))]
static DAEMON_BUNDLE: &[u8] = &[];

/// Byte-identical to the bundled mymuxd's `--version` output; a host whose
/// probe differs (or has no mymuxd at all) needs the push.
#[cfg(daemon_bundle)]
static BUNDLE_VERSION: &str =
    include_str!("../../../src-tauri/resources/daemon/linux-x86_64.version");
#[cfg(not(daemon_bundle))]
static BUNDLE_VERSION: &str = "";

/// The release-channel manifest (bundles.json, produced by
/// scripts/ci-build-daemon-matrix.sh at publish time): per-arch asset URLs +
/// sha256 pins. The client downloads host-matched bundles on demand instead
/// of shipping daemon bytes for every arch inside every client platform.
#[cfg(bundle_manifest)]
static BUNDLES_JSON: &str = include_str!("../../../src-tauri/resources/daemon/bundles.json");
#[cfg(not(bundle_manifest))]
static BUNDLES_JSON: &str = "";

/// Expected remote version for THIS host: the manifest's pin when it covers
/// the host's arch; else the embedded x86_64 bundle's version (legacy path).
fn expected_version(uname_sm: &str) -> String {
    if let Some(m) = crate::bundle::BundleManifest::parse(BUNDLES_JSON) {
        if crate::bundle::arch_key(uname_sm)
            .and_then(|k| m.assets.get(k))
            .is_some()
        {
            return m.version;
        }
    }
    BUNDLE_VERSION.trim().to_string()
}

/// Resolve the bytes to push: manifest-host-arch download (sha256-pinned) if
/// a manifest is available; else the embedded x86_64 bundle (legacy/airgap).
async fn resolve_bundle_bytes(master: &Master, uname_sm: &str) -> Result<Vec<u8>, String> {
    let _ = master; // mirror override is env/global today; a per-host knob would ride here
    if let Some(m) = crate::bundle::BundleManifest::parse(BUNDLES_JSON) {
        if let Some(key) = crate::bundle::arch_key(uname_sm) {
            if let Some(asset) = m.assets.get(key) {
                let url = crate::bundle::asset_url(&m, asset);
                let _ = master; // (mirror override is env-scoped, not host-scoped)
                let bytes = crate::bundle::download(&url, 512 * 1024 * 1024).await?;
                let got = crate::bundle::sha256_hex(&bytes);
                if got != asset.sha256 {
                    return Err(format!(
                        "integrity check failed for {key}: expected {}, downloaded {got} — refusing to install",
                        asset.sha256
                    ));
                }
                return Ok(bytes);
            }
            return Err(format!(
                "no daemon bundle published for {key} yet (a future release target) — install mymuxd manually for now"
            ));
        }
        return Err(format!(
            "unsupported host for the mymux daemon (uname: {uname_sm:?}) — Linux x86_64/aarch64 only"
        ));
    }
    if DAEMON_BUNDLE.is_empty() {
        return Err(
            "mymuxd is not installed on the host, and this app has neither a release manifest nor an embedded bundle (publish a release with scripts/ci-publish-release.sh, or run scripts/build-daemon-bundle.sh)".into(),
        );
    }
    match crate::bundle::arch_key(uname_sm) {
        Some("linux-x86_64") | None if uname_sm.trim().is_empty() => Ok(DAEMON_BUNDLE.to_vec()),
        _ => Err("the embedded daemon bundle is x86_64-only and this app has no release manifest — publish one with scripts/ci-publish-release.sh".into()),
    }
}

/// What the post-connect meta check reports about the remote daemon.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DaemonMeta {
    /// Remote `mymuxd --version` output ("" = not installed / not answering).
    pub current: String,
    /// This app's pinned expectation: the manifest's version when it covers
    /// the host's arch, else the embedded x86_64 bundle's ("" in a bundle-less
    /// dev build — nothing to compare against).
    pub expected: String,
    /// The expectation is known and the probe differs — a push brings the
    /// host current. False when either side is unknown or they match.
    pub outdated: bool,
}

const UNAME_PROBE: &str = "uname -sm 2>/dev/null || true";
const VERSION_PROBE: &str = "(timeout 2 ~/.local/bin/mymuxd --version 2>/dev/null || timeout 2 mymuxd --version 2>/dev/null || true) | head -1";
/// Upload atomically (.new → rename) so a half-written push can't poison a
/// later install.
const PUT_BUNDLE: &str = "mkdir -p ~/.local/share/mymux/dist && cat > ~/.local/share/mymux/dist/daemon.tgz.new && mv -f ~/.local/share/mymux/dist/daemon.tgz.new ~/.local/share/mymux/dist/daemon.tgz";

/// Version strings look like "mymuxd 0.1.0 (<sha>[-dirty])".
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let m = v.strip_prefix("mymuxd ")?.split_whitespace().next()?;
    let mut it = m.split('.');
    Some((
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ))
}

/// Outdated = STRICTLY OLDER by semantic version; on equal versions the sha
/// pins the update lane as before (releases share the crate version, so only
/// string-inequality distinguishes them there). A host running a NEWER
/// daemon (e.g. pushed by a newer app pin) is NOT outdated — string
/// inequality used to flag it and one click on Update DOWNGRADED it.
fn daemon_outdated(current: &str, expected: &str) -> bool {
    if current.is_empty() || expected.is_empty() {
        return false;
    }
    match (parse_semver(current), parse_semver(expected)) {
        (Some(c), Some(e)) if c != e => c < e,
        _ => current != expected,
    }
}

/// Remote daemon version vs this app's pin, over one live master — the
/// post-connect AUDIT that runs even when the tunnel came up fine (an old
/// daemon that still answers is exactly the case maybe_install never saw).
pub async fn probe_daemon_meta(master: &Master) -> Result<DaemonMeta, String> {
    let uname = master_exec_script(master, UNAME_PROBE, Duration::from_secs(10))
        .await
        .unwrap_or_default();
    let probe = master_exec_script(master, VERSION_PROBE, Duration::from_secs(20))
        .await
        .map_err(|e| format!("probe failed: {e:?}"))?;
    let expected = expected_version(&uname);
    let current = probe.trim().to_string();
    Ok(DaemonMeta {
        outdated: daemon_outdated(&current, &expected),
        current,
        expected,
    })
}

/// Push this app's daemon bundle and run the installer — the UPDATE path for
/// a live host (maybe_install's first-aid path shares it). The installer
/// swaps binaries atomically and restarts ONLY mymuxd (systemd
/// KillMode=process, tmux sessions survive); ptyd is never restarted here, so
/// persistent panes ride through. Returns the installer's log lines.
pub async fn push_daemon_update(master: &Master) -> Result<String, String> {
    let uname = master_exec_script(master, UNAME_PROBE, Duration::from_secs(10))
        .await
        .unwrap_or_default();
    let bytes = resolve_bundle_bytes(master, &uname).await?;
    master_exec_bytes(master, PUT_BUNDLE, &bytes, Duration::from_secs(600))
        .await
        .map_err(|e| format!("bundle upload failed: {e:?}"))?;
    master_exec_script(master, INSTALL_SCRIPT, Duration::from_secs(300))
        .await
        .map_err(|e| format!("installer failed: {e:?}"))
}

/// Daemon start failed: when the host's mymuxd is missing or outdated, push
/// the embedded bundle and run the installer — all THREE execs (probe,
/// upload, installer) riding the SAME live master, one auth total. Ok(true) =
/// install ran (the supervisor retries the connect); Ok(false) = the host is
/// already current, so the failure is something else (report the original status).
async fn maybe_install(
    _cfg: &HostConfig,
    master: &Master,
    status: &mpsc::Sender<Status>,
) -> Result<bool, String> {
    let meta = probe_daemon_meta(master).await?;
    if !meta.outdated && !meta.expected.is_empty() {
        return Ok(false); // current — the start failure is something else
    }
    if meta.expected.is_empty() && meta.current.is_empty() {
        return Err("mymuxd is not installed on the host, and this app has neither a release manifest nor an embedded bundle (see ci-publish-release.sh / build-daemon-bundle.sh)".into());
    }
    let _ = status.send(Status::Installing).await;
    let out = push_daemon_update(master).await?;
    for line in out.lines().take(12) {
        eprintln!("mymux-connect install: {line}");
    }
    Ok(true)
}

/// Supervise the russh tunnel: connect, serve, and reconnect with capped backoff.
/// The caller owns the host's Master (shared with uninstall/exec paths so a
/// transient drop reconnects WITHOUT a fresh auth; only a dead master
/// re-authenticates). Fatal states (bad auth / unknown or changed host key)
/// stop the loop and are reported so the UI can prompt; transient drops
/// reconnect silently.
pub async fn run_russh_tunnel(cfg: HostConfig, master: &Master, status: mpsc::Sender<Status>) {
    let min = Duration::from_millis(500);
    let max = Duration::from_secs(30);
    let mut backoff = min;
    // Consecutive DaemonUnreachable rounds whose install+probe attempt ran
    // without the daemon coming up. Breaks the
    // install→restart→probe-fails→(rolled back)→install-again oscillation.
    let mut daemon_tries = 0u32;

    loop {
        let _ = status.send(Status::Connecting).await;
        let started = Instant::now();
        let end = connect_and_serve(&cfg, master, &status)
            .await
            .err()
            .unwrap_or(Status::Reconnecting);
        if !matches!(end, Status::DaemonUnreachable) {
            daemon_tries = 0; // any other outcome resets the install-breaker
        }

        if is_fatal(&end) {
            // A missing daemon is fixable without the user: push the
            // self-contained installer over this same SSH connection, then
            // retry the whole cycle — zero-touch first connect.
            if matches!(end, Status::DaemonUnreachable) {
                daemon_tries += 1;
                if daemon_tries > 2 {
                    let _ = status
                        .send(Status::Error(
                            "mymuxd on the host fails to start even after the shipped installer ran (it rolled back). Check journalctl --user -u mymuxd on the host"
                                .to_string(),
                        ))
                        .await;
                    return;
                }
                match maybe_install(&cfg, master, &status).await {
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

#[cfg(test)]
mod tests {
    use super::daemon_outdated;

    #[test]
    fn outdated_semantics() {
        // Older by semver → outdated either side of the sha pins.
        assert!(daemon_outdated(
            "mymuxd 0.1.0 (aaa1111)",
            "mymuxd 0.2.0 (bbb2222)"
        ));
        // Same version: the sha pin drives the lane (string inequality).
        assert!(daemon_outdated(
            "mymuxd 0.1.0 (aaa1111)",
            "mymuxd 0.1.0 (bbb2222)"
        ));
        assert!(!daemon_outdated(
            "mymuxd 0.1.0 (bbb2222)",
            "mymuxd 0.1.0 (bbb2222)"
        ));
        // NEWER on the host is NOT outdated (the old bug downgraded it).
        assert!(!daemon_outdated(
            "mymuxd 0.2.0 (zzz9999)",
            "mymuxd 0.1.0 (aaa1111)"
        ));
        // Unknown anywhere → no verdict.
        assert!(!daemon_outdated("", "mymuxd 0.1.0 (aaa1111)"));
        assert!(!daemon_outdated("mymuxd 0.1.0 (aaa1111)", ""));
        // Unparseable falls back to inequality (never flags equal).
        assert!(!daemon_outdated("dev-build", "dev-build"));
        assert!(daemon_outdated("dev-build", "mymuxd 0.1.0 (aaa1111)"));
    }

    /// expected_version lane choice: a manifest embedded at build time owns
    /// the answer when it covers the arch; the embedded bundle's version is
    /// the lane otherwise (empty in a bundle-less dev build).
    #[test]
    fn install_decision() {
        let v = super::expected_version("Linux x86_64");
        if !super::BUNDLES_JSON.is_empty() {
            assert!(v.contains("mymuxd"), "manifest lane must win: {v}");
        } else if !super::DAEMON_BUNDLE.is_empty() {
            assert_eq!(v, super::BUNDLE_VERSION.trim(), "bundle lane: {v}");
        } else {
            assert!(v.is_empty(), "bundle-less dev build: {v}");
        }
    }

    /// parse_probe digests the box-side script's TAB rows into UI strings,
    /// skips noise (zero process counts) and ignores unknown row kinds.
    #[test]
    fn probe_parsing() {
        let out = "pane\ttmux\tmain:1.0\tzsh\tcode\n\
                   pane\tptyd\t1\t∞\t-\tpid 3907076\n\
                   pane\tptyd\t7\t⌁\tbuild\tpid 42\n\
                   svc\tmymuxd.service\tactive\n\
                   svc\tmymux-ptyd.service\tinactive\n\
                   proc\tmymuxd\t1\n\
                   proc\tmymux-ptyd\t0\n\
                   bin\t/home/u/.local/bin/mymuxd\n\
                   dir\t/home/u/.local/share/mymux\n\
                   keep\t/home/u/.config/mymux/env (your env/proxy settings)\n\
                   future-row\twhatever\n";
        let r = super::parse_probe(out);
        assert!(r.has_work());
        assert_eq!(r.work.len(), 3);
        assert_eq!(r.work[0], "tmux main:1.0 — zsh (window: code)");
        assert!(r.work[1].contains("persistent shell"));
        assert!(r.work[1].contains("unnamed"));
        assert!(r.work[2].contains("shell “build”"));
        assert_eq!(r.services.len(), 3); // 2 units + 1 nonzero proc
        assert!(!r.services.iter().any(|s| s.contains("mymux-ptyd: 0")));
        assert_eq!(r.artifacts.len(), 2);
        assert_eq!(r.keeps.len(), 1);
    }

    /// An empty host (nothing installed) parses to an empty report.
    #[test]
    fn probe_empty() {
        let r = super::parse_probe("svc\tmymuxd.service\tnot-installed\n");
        assert!(!r.has_work());
        assert!(r.artifacts.is_empty());
        assert_eq!(r.services, vec!["mymuxd.service: not-installed"]);
    }
}
