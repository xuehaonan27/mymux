//! `mymux-connect <ssh-host>` — keep a resilient tunnel to a remote mymuxd.

use mymux_connect::{run_tunnel, TunnelConfig};

fn help() {
    eprintln!(
        "usage: mymux-connect <ssh-host> [--local-port N] [--remote-port N] [--ensure-daemon]\n\
         \n\
         Keeps localhost:<local-port> forwarded to the remote mymuxd, reconnecting\n\
         automatically. Point the UI at http://localhost:<local-port>."
    );
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut host: Option<String> = None;
    let mut cfg_local = 8088u16;
    let mut cfg_remote = 8088u16;
    let mut ensure = false;

    while let Some(a) = args.next() {
        match a.as_str() {
            "--local-port" => {
                cfg_local = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(cfg_local)
            }
            "--remote-port" => {
                cfg_remote = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(cfg_remote)
            }
            "--ensure-daemon" => ensure = true,
            "-h" | "--help" => {
                help();
                return;
            }
            other if !other.starts_with('-') && host.is_none() => host = Some(other.to_string()),
            other => {
                eprintln!("mymux-connect: unexpected argument '{other}'");
                help();
                std::process::exit(2);
            }
        }
    }

    let Some(host) = host else {
        help();
        std::process::exit(2);
    };

    let mut cfg = TunnelConfig::new(host);
    cfg.local_port = cfg_local;
    cfg.remote_port = cfg_remote;
    cfg.ensure_daemon = ensure;

    // Testing / advanced hook: override the forward process (e.g. a mock).
    if let Ok(cmd) = std::env::var("MYMUX_FORWARD_CMD") {
        if !cmd.trim().is_empty() {
            cfg.forward_command = Some(cmd.split_whitespace().map(String::from).collect());
        }
    }

    eprintln!(
        "mymux-connect: localhost:{} → {}:{}  —  open the UI against localhost:{}",
        cfg.local_port, cfg.host, cfg.remote_port, cfg.local_port
    );

    tokio::select! {
        _ = run_tunnel(cfg) => {}
        _ = tokio::signal::ctrl_c() => eprintln!("\nmymux-connect: stopped"),
    }
}
