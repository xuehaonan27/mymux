//! Client-side connector: keep a resilient SSH port-forward to a remote
//! `mymuxd` alive so the UI's WebSocket (which auto-reconnects) always has a
//! local endpoint to reach.
//!
//! The heavy lifting is tmux + `mymuxd` on the server (they persist across
//! disconnects). This side supervises **one** ssh connection: the port-forward
//! doubles as an SSH ControlMaster, and the remote daemon is started over that
//! same multiplexed connection — so ssh authenticates at most once per tunnel,
//! not once per operation.
//!
//! Authentication must be non-interactive (ssh-agent / macOS keychain): the
//! packaged desktop app has no terminal to type a passphrase into. When it
//! isn't, we say exactly how to fix it and wait — connecting automatically once
//! the key is loaded.

use std::io::IsTerminal;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

/// In-process SSH tunnel (russh) for the native host manager — the ssh-binary
/// path below stays as a fallback until this is proven end-to-end.
pub mod russh_tunnel;
pub use russh_tunnel::{
    exec_bytes, exec_script, master_exec_bytes, master_exec_script, parse_probe, run_russh_tunnel,
    HostConfig, Master, Status, WorkReport, UNINSTALL_SCRIPT,
};
pub mod hosts;
pub use hosts::{config_dir, Host, HostStore};

/// One control socket per (user, host, port) tunnel. ssh expands the `%r@%h:%p`
/// tokens and the leading `~`.
const CONTROL_PATH: &str = "~/.ssh/mymux-%r@%h:%p";

pub struct TunnelConfig {
    /// ssh destination (a host or a `~/.ssh/config` alias).
    pub host: String,
    /// Local port the UI connects to.
    pub local_port: u16,
    /// Remote port `mymuxd` listens on.
    pub remote_port: u16,
    /// Try to start `mymuxd` on the remote if it isn't running.
    pub ensure_daemon: bool,
    /// Command run over ssh to (idempotently) start the remote daemon.
    pub remote_daemon_cmd: String,
    /// Testing hook: run this instead of ssh (e.g. a mock forwarder).
    pub forward_command: Option<Vec<String>>,
}

impl TunnelConfig {
    pub fn new(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            local_port: 8088,
            remote_port: 8088,
            ensure_daemon: false,
            // Prefer the systemd --user service (persistent, restart-safe); fall
            // back to a detached setsid launch if it isn't installed. Only checks
            // + starts; never kills anything by name.
            remote_daemon_cmd:
                "systemctl --user start mymuxd.service 2>/dev/null || pgrep -x mymuxd >/dev/null 2>&1 || setsid mymuxd >/tmp/mymuxd.log 2>&1 </dev/null &"
                    .to_string(),
            forward_command: None,
        }
    }

    /// The `-o ControlPath=…` argument shared by the forward and the control
    /// commands (`-O check`, multiplexed daemon start) so they hit one socket.
    fn control_path_opt() -> String {
        format!("ControlPath={CONTROL_PATH}")
    }

    /// The forward, which also acts as the ControlMaster for this tunnel.
    fn ssh_forward_args(&self) -> Vec<String> {
        vec![
            "-N".to_string(),
            "-o".into(),
            "ExitOnForwardFailure=yes".into(),
            "-o".into(),
            "ServerAliveInterval=15".into(),
            "-o".into(),
            "ServerAliveCountMax=3".into(),
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            Self::control_path_opt(),
            "-o".into(),
            "ControlPersist=60".into(),
            "-L".into(),
            format!("{}:localhost:{}", self.local_port, self.remote_port),
            self.host.clone(),
        ]
    }

    /// The (program, args) to run for the forward — ssh in production, or the
    /// testing override.
    pub fn forward_program_args(&self) -> (String, Vec<String>) {
        match &self.forward_command {
            Some(cmd) if !cmd.is_empty() => (cmd[0].clone(), cmd[1..].to_vec()),
            _ => ("ssh".to_string(), self.ssh_forward_args()),
        }
    }
}

/// Is the tunnel's ControlMaster live? (`ssh -O check`.)
async fn master_alive(host: &str) -> bool {
    Command::new("ssh")
        .args(["-O", "check", "-o", &TunnelConfig::control_path_opt(), host])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Can ssh reach the host **without** prompting for a passphrase — via an
/// ssh-agent / keychain, or an existing master? If so, we'll never block on a
/// prompt (which the packaged GUI app can't answer anyway).
async fn can_auth_noninteractive(host: &str) -> bool {
    Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            &TunnelConfig::control_path_opt(),
            host,
            "true",
        ])
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

fn print_agent_guidance(host: &str) {
    eprintln!(
        "mymux-connect: can't reach {host} without a passphrase prompt, and there is\n\
         no terminal to prompt on. Load your key into an agent once so mymux (and\n\
         the packaged app) connect silently:\n\
         \n\
         \x20 macOS:  ssh-add --apple-use-keychain ~/.ssh/id_ed25519\n\
         \x20         # then in ~/.ssh/config, under `Host {host}`:\n\
         \x20         #   AddKeysToAgent yes\n\
         \x20         #   UseKeychain yes\n\
         \x20 Linux:  eval \"$(ssh-agent -s)\" && ssh-add ~/.ssh/id_ed25519\n\
         \n\
         Waiting — this connects on its own once the key is loaded."
    );
}

/// Once the ControlMaster is up, start the remote daemon over the **same**
/// multiplexed connection (no second authentication). Bails quietly if the
/// forward died first or the master never appeared; the supervisor backs off.
async fn start_daemon_multiplexed(cfg: &TunnelConfig, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return; // forward already gone
        }
        if master_alive(&cfg.host).await {
            break;
        }
        if Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = Command::new("ssh")
        .args([
            "-o",
            &TunnelConfig::control_path_opt(),
            &cfg.host,
            &cfg.remote_daemon_cmd,
        ])
        .status()
        .await;
}

/// Supervise the forward forever, restarting with capped exponential backoff.
/// A forward that stayed up a while resets the backoff (it was a transient drop).
pub async fn run_tunnel(cfg: TunnelConfig) {
    let min_backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(30);
    let mut backoff = min_backoff;

    // The auth/daemon logic only applies to real ssh; the test override is a
    // bare forwarder with no remote side.
    let real_ssh = cfg.forward_command.is_none();

    loop {
        // Preflight: make sure ssh can authenticate without a prompt. In a
        // terminal (dev) we still allow one interactive prompt; headless (the
        // packaged app) we can't prompt, so guide the user and wait instead of
        // spawning an ssh that fails invisibly.
        if real_ssh && !can_auth_noninteractive(&cfg.host).await {
            if std::io::stdin().is_terminal() {
                eprintln!(
                    "mymux-connect: no agent key for {} — you'll be asked for your \
                     passphrase once.",
                    cfg.host
                );
            } else {
                print_agent_guidance(&cfg.host);
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        }

        let (program, args) = cfg.forward_program_args();
        eprintln!("mymux-connect: forward up ({program})");
        let started = Instant::now();

        let mut child = match Command::new(&program)
            .args(&args)
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("mymux-connect: could not spawn forward: {e}");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        // Start the remote daemon over the now-established master connection.
        if real_ssh && cfg.ensure_daemon {
            start_daemon_multiplexed(&cfg, &mut child).await;
        }

        let status = child.wait().await;
        let ran = started.elapsed();
        match status {
            Ok(s) => eprintln!("mymux-connect: forward exited ({s}) after {ran:?}"),
            Err(e) => eprintln!("mymux-connect: forward wait error: {e}"),
        }

        if ran >= Duration::from_secs(10) {
            backoff = min_backoff;
        }
        eprintln!("mymux-connect: reconnecting in {backoff:?}");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_forward_args_have_forward_and_host() {
        let cfg = TunnelConfig::new("dev");
        let (prog, args) = cfg.forward_program_args();
        assert_eq!(prog, "ssh");
        assert!(args.iter().any(|a| a == "-N"));
        assert!(args.contains(&"8088:localhost:8088".to_string()));
        assert!(args.contains(&"dev".to_string()));
        assert!(args.iter().any(|a| a == "ExitOnForwardFailure=yes"));
    }

    #[test]
    fn custom_ports_render() {
        let mut cfg = TunnelConfig::new("dev");
        cfg.local_port = 9000;
        cfg.remote_port = 8088;
        let (_, args) = cfg.forward_program_args();
        assert!(args.contains(&"9000:localhost:8088".to_string()));
    }

    #[test]
    fn forward_is_the_control_master() {
        // The forward must carry the ControlMaster + a stable ControlPath so the
        // daemon-start and `-O check` reuse the same connection (one auth).
        let cfg = TunnelConfig::new("dev");
        let (_, args) = cfg.forward_program_args();
        assert!(args.iter().any(|a| a == "ControlMaster=auto"));
        assert!(args.contains(&TunnelConfig::control_path_opt()));
        assert_eq!(
            TunnelConfig::control_path_opt(),
            format!("ControlPath={CONTROL_PATH}")
        );
    }

    #[test]
    fn override_command_used_for_testing() {
        let mut cfg = TunnelConfig::new("dev");
        cfg.forward_command = Some(vec!["node".into(), "mock.mjs".into()]);
        let (prog, args) = cfg.forward_program_args();
        assert_eq!(prog, "node");
        assert_eq!(args, vec!["mock.mjs".to_string()]);
    }
}
