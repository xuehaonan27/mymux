//! Throwaway probe for verifying the russh tunnel against an isolated sshd.
//! Reads config from env, prints each `Status` as `STATUS <..>` on its own line.
//! Not part of the shipped product.

use std::path::PathBuf;

use mymux_connect::{run_russh_tunnel, HostConfig};
use tokio::sync::mpsc;

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

#[tokio::main]
async fn main() {
    let cfg = HostConfig {
        hostname: env("HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: env("PORT").and_then(|v| v.parse().ok()).unwrap_or(2222),
        user: env("SSH_USER").unwrap_or_else(|| "root".into()),
        identity_path: PathBuf::from(env("KEY").expect("KEY")),
        known_hosts_path: PathBuf::from(env("KNOWN_HOSTS").expect("KNOWN_HOSTS")),
        local_port: env("LOCAL_PORT")
            .and_then(|v| v.parse().ok())
            .unwrap_or(9099),
        remote_port: env("REMOTE_PORT")
            .and_then(|v| v.parse().ok())
            .unwrap_or(9098),
        remote_daemon_cmd: env("DAEMON_CMD").unwrap_or_else(|| "true".into()),
        trust_unknown_host_key: env("TRUST").as_deref() == Some("1"),
    };
    let passphrase = env("PASSPHRASE");
    let (tx, mut rx) = mpsc::channel(32);
    tokio::spawn(run_russh_tunnel(cfg, passphrase, tx));
    while let Some(s) = rx.recv().await {
        println!("STATUS {s:?}");
    }
    println!("STATUS ChannelClosed");
}
