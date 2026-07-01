//! Client-side connector: keep a resilient SSH port-forward to a remote
//! `mymuxd` alive so the UI's WebSocket (which auto-reconnects) always has a
//! local endpoint to reach.
//!
//! The heavy lifting is tmux + `mymuxd` on the server (they persist across
//! disconnects). This side just supervises one `ssh -N -L …` forward and
//! restarts it with capped backoff when the network drops. Authentication is
//! whatever ssh already uses (ssh-agent / macOS keychain), so the passphrase is
//! entered once — not once per window.

use std::time::{Duration, Instant};

use tokio::process::Command;

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
            // Only checks + starts; never kills anything by name.
            remote_daemon_cmd:
                "pgrep -x mymuxd >/dev/null 2>&1 || setsid mymuxd >/tmp/mymuxd.log 2>&1 </dev/null &"
                    .to_string(),
            forward_command: None,
        }
    }

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
            "ControlPath=~/.ssh/mymux-%r@%h:%p".into(),
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

async fn ensure_remote_daemon(cfg: &TunnelConfig) {
    // Skip when using a test override (there's no real remote then).
    if !cfg.ensure_daemon || cfg.forward_command.is_some() {
        return;
    }
    let _ = Command::new("ssh")
        .arg(&cfg.host)
        .arg(&cfg.remote_daemon_cmd)
        .status()
        .await;
}

/// Supervise the forward forever, restarting with capped exponential backoff.
/// A forward that stayed up a while resets the backoff (it was a transient drop).
pub async fn run_tunnel(cfg: TunnelConfig) {
    let min_backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(30);
    let mut backoff = min_backoff;

    loop {
        ensure_remote_daemon(&cfg).await;

        let (program, args) = cfg.forward_program_args();
        eprintln!("mymux-connect: forward up: {program} {}", args.join(" "));
        let started = Instant::now();

        let status = Command::new(&program)
            .args(&args)
            .kill_on_drop(true)
            .status()
            .await;

        let ran = started.elapsed();
        match status {
            Ok(s) => eprintln!("mymux-connect: forward exited ({s}) after {ran:?}"),
            Err(e) => eprintln!("mymux-connect: could not spawn forward: {e}"),
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
    fn override_command_used_for_testing() {
        let mut cfg = TunnelConfig::new("dev");
        cfg.forward_command = Some(vec!["node".into(), "mock.mjs".into()]);
        let (prog, args) = cfg.forward_program_args();
        assert_eq!(prog, "node");
        assert_eq!(args, vec!["mock.mjs".to_string()]);
    }
}
