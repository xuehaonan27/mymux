//! Integration test for `exec_script`: drives a THROWAWAY sshd on a high port
//! whose entire world (host key, client key, authorized_keys, known_hosts)
//! lives in a temp dir — the user's real ssh setup is never touched. Skips
//! silently when sshd or ssh-keygen is unavailable.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use mymux_connect::{exec_script, HostConfig};

fn sshd_bin() -> Option<&'static str> {
    ["/usr/sbin/sshd", "/usr/bin/sshd", "/sbin/sshd"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
}

fn keygen(path: &Path) {
    let ok = std::process::Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-f"])
        .arg(path)
        .args(["-N", "", "-q"])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "ssh-keygen failed for {}", path.display());
}

struct Cleanup {
    dir: PathBuf,
    child: Option<std::process::Child>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn exec_script_runs_commands_over_ssh() {
    let Some(sshd) = sshd_bin() else {
        eprintln!("sshd not found — skipping exec_script integration test");
        return;
    };
    let dir = std::env::temp_dir().join(format!("mymux-sshd-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Keys + sshd config (all inside the temp dir).
    let host_key = dir.join("host_key");
    let client_key = dir.join("client_key");
    keygen(&host_key);
    keygen(&client_key);
    let pubkey = std::fs::read_to_string(dir.join("client_key.pub")).unwrap();
    std::fs::write(dir.join("authorized_keys"), pubkey).unwrap();
    let port = 22200 + (std::process::id() % 500) as u16;
    let conf = format!(
        "Port {port}\n\
         ListenAddress 127.0.0.1\n\
         HostKey {}\n\
         PidFile {}\n\
         AuthorizedKeysFile {}\n\
         UsePAM no\n\
         PasswordAuthentication no\n\
         PubkeyAuthentication yes\n\
         StrictModes no\n\
         LogLevel ERROR\n",
        host_key.display(),
        dir.join("sshd.pid").display(),
        dir.join("authorized_keys").display(),
    );
    let conf_path = dir.join("sshd_config");
    std::fs::write(&conf_path, &conf).unwrap();

    let child = std::process::Command::new(sshd)
        .args(["-D", "-f"])
        .arg(&conf_path)
        .arg("-E")
        .arg(dir.join("sshd.log"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sshd");
    let _cleanup = Cleanup {
        dir: dir.clone(),
        child: Some(child),
    };

    // Wait for the port to answer.
    let mut up = false;
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            up = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(up, "throwaway sshd never came up (see {})", dir.join("sshd.log").display());

    let cfg = HostConfig {
        hostname: "127.0.0.1".into(),
        port,
        user: std::env::var("USER").expect("USER"),
        identity_path: client_key,
        known_hosts_path: dir.join("known_hosts"),
        local_port: 0,
        remote_port: 0,
        remote_daemon_cmd: "true".into(),
        trust_unknown_host_key: true,
    };

    // stdout + stderr are both collected; exit 0 → Ok.
    let out = exec_script(
        &cfg,
        None,
        "echo hello-out; echo hello-err >&2; exit 0",
        Duration::from_secs(20),
    )
    .await
    .expect("exec_script should succeed");
    assert!(out.contains("hello-out"), "missing stdout: {out:?}");
    assert!(out.contains("hello-err"), "missing stderr: {out:?}");

    // Non-zero exit → Err carrying the code and the output tail.
    let err = exec_script(&cfg, None, "echo doomed; exit 3", Duration::from_secs(20))
        .await
        .expect_err("exit 3 must be an error");
    let msg = format!("{err:?}");
    assert!(msg.contains("exited 3"), "missing exit code: {msg}");
    assert!(msg.contains("doomed"), "missing output tail: {msg}");

    // Stdin is really piped: the script can read what we send.
    let out = exec_script(&cfg, None, "read x; echo \"got:$x\"", Duration::from_secs(20))
        .await
        .expect("read should succeed");
    assert!(out.contains("got:"), "stdin roundtrip failed: {out:?}");
}
