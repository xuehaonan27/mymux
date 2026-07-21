//! Shared throwaway-sshd harness for mymux-connect integration tests.
//! Everything (host key, client key, authorized_keys, known_hosts, logs) lives
//! in a temp dir — the user's real ssh setup is never touched. Callers should
//! skip silently when sshd or ssh-keygen is unavailable (spawn() → None).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use mymux_connect::HostConfig;

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

/// A running throwaway sshd plus the paths needed to inspect it. Killing the
/// server and removing the dir happens on Drop.
pub struct TestSshd {
    pub cfg: HostConfig,
    pub dir: PathBuf,
    /// sshd's -E log (auth lines are only present when spawned verbose).
    // Not every test binary reads it — silence dead-code in those binaries.
    #[allow(dead_code)]
    pub log: PathBuf,
    child: Option<std::process::Child>,
}

impl TestSshd {
    /// Spawn; `verbose_log` selects LogLevel VERBOSE (needed to count
    /// "Accepted publickey" lines) vs ERROR (the default, quiet). Unique dir+port
    /// per call (cargo runs tests of one binary in PARALLEL threads).
    pub fn spawn(verbose_log: bool) -> Option<Self> {
        let sshd = sshd_bin()?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "mymux-sshd-test-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let host_key = dir.join("host_key");
        let client_key = dir.join("client_key");
        keygen(&host_key);
        keygen(&client_key);
        let pubkey = std::fs::read_to_string(dir.join("client_key.pub")).unwrap();
        std::fs::write(dir.join("authorized_keys"), pubkey).unwrap();
        let port = 22222 + ((std::process::id() as u128 + nanos) % 2000) as u16;
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
             LogLevel {}\n",
            host_key.display(),
            dir.join("sshd.pid").display(),
            dir.join("authorized_keys").display(),
            if verbose_log { "VERBOSE" } else { "ERROR" },
        );
        let conf_path = dir.join("sshd_config");
        std::fs::write(&conf_path, &conf).unwrap();

        let log = dir.join("sshd.log");
        let child = std::process::Command::new(sshd)
            .args(["-D", "-f"])
            .arg(&conf_path)
            .arg("-E")
            .arg(&log)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sshd");

        let mut up = false;
        for _ in 0..50 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(up, "throwaway sshd never came up (see {})", log.display());

        Some(Self {
            cfg: HostConfig {
                hostname: "127.0.0.1".into(),
                port,
                user: std::env::var("USER").expect("USER"),
                identity_path: client_key,
                known_hosts_path: dir.join("known_hosts"),
                local_port: 0,
                remote_port: 0,
                remote_daemon_cmd: "true".into(),
                trust_unknown_host_key: true,
            },
            dir,
            log,
            child: Some(child),
        })
    }
}

impl Drop for TestSshd {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
