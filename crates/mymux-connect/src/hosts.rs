//! Persistent host list for the native host manager. Stored as JSON at
//! `~/.config/mymux/hosts.json`; a tunnel is built from a [`Host`] plus a
//! passphrase entered in the UI (never stored).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::russh_tunnel::HostConfig;

fn default_port() -> u16 {
    22
}
fn default_identity() -> String {
    "~/.ssh/id_ed25519".to_string()
}

/// A saved SSH host.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Host {
    pub id: String,
    pub label: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    #[serde(default = "default_identity")]
    pub identity_path: String,
}

/// The saved host list + which host to offer by default.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HostStore {
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub default_id: Option<String>,
}

/// `~/.config/mymux` (overridable via `MYMUX_CONFIG_DIR`, mainly for tests).
pub fn config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("MYMUX_CONFIG_DIR") {
        return PathBuf::from(d);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".config/mymux")
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

fn whoami_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

impl HostStore {
    /// Load from `<dir>/hosts.json`, migrating a legacy `<dir>/host` file (a bare
    /// hostname or `user@host`) on first run. Missing/unparseable → empty store.
    pub fn load(dir: &Path) -> HostStore {
        if let Ok(text) = std::fs::read_to_string(dir.join("hosts.json")) {
            return serde_json::from_str(&text).unwrap_or_default();
        }
        if let Ok(old) = std::fs::read_to_string(dir.join("host")) {
            let raw = old.trim();
            if !raw.is_empty() {
                let store = HostStore::from_legacy(raw);
                let _ = store.save(dir);
                return store;
            }
        }
        HostStore::default()
    }

    fn from_legacy(raw: &str) -> HostStore {
        let (user, hostname) = match raw.split_once('@') {
            Some((u, h)) => (u.to_string(), h.to_string()),
            None => (whoami_user(), raw.to_string()),
        };
        let host = Host {
            id: "default".to_string(),
            label: hostname.clone(),
            hostname,
            port: 22,
            user,
            identity_path: default_identity(),
        };
        HostStore {
            default_id: Some(host.id.clone()),
            hosts: vec![host],
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let json = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into());
        std::fs::write(dir.join("hosts.json"), json)
    }

    pub fn get(&self, id: &str) -> Option<&Host> {
        self.hosts.iter().find(|h| h.id == id)
    }

    /// Insert or replace a host by id.
    pub fn upsert(&mut self, host: Host) {
        match self.hosts.iter_mut().find(|h| h.id == host.id) {
            Some(existing) => *existing = host,
            None => self.hosts.push(host),
        }
    }

    /// Remove a host (and clear it as default if it was).
    pub fn remove(&mut self, id: &str) {
        self.hosts.retain(|h| h.id != id);
        if self.default_id.as_deref() == Some(id) {
            self.default_id = None;
        }
    }
}

impl Host {
    /// Build the russh tunnel config for this host.
    pub fn to_tunnel_config(
        &self,
        local_port: u16,
        remote_port: u16,
        remote_daemon_cmd: String,
        trust_unknown_host_key: bool,
    ) -> HostConfig {
        let known_hosts_path = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(".ssh/known_hosts");
        HostConfig {
            hostname: self.hostname.clone(),
            port: self.port,
            user: self.user.clone(),
            identity_path: expand_tilde(&self.identity_path),
            known_hosts_path,
            local_port,
            remote_port,
            remote_daemon_cmd,
            trust_unknown_host_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mymux-hosts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn host(id: &str, label: &str, hostname: &str, port: u16) -> Host {
        Host {
            id: id.into(),
            label: label.into(),
            hostname: hostname.into(),
            port,
            user: "u".into(),
            identity_path: "~/.ssh/id".into(),
        }
    }

    #[test]
    fn roundtrip_upsert_delete() {
        let dir = tmp("rt");
        let mut s = HostStore::load(&dir);
        assert!(s.hosts.is_empty());
        s.upsert(host("a", "A", "h", 22));
        s.upsert(host("a", "A2", "h2", 2222)); // replace by id
        s.upsert(host("b", "B", "hb", 22));
        s.default_id = Some("a".into());
        s.save(&dir).unwrap();

        let s2 = HostStore::load(&dir);
        assert_eq!(s2.hosts.len(), 2);
        assert_eq!(s2.get("a").unwrap().label, "A2");
        assert_eq!(s2.get("a").unwrap().port, 2222);
        assert_eq!(s2.default_id.as_deref(), Some("a"));

        let mut s3 = s2;
        s3.remove("a");
        assert!(s3.get("a").is_none());
        assert!(s3.default_id.is_none());
        assert_eq!(s3.hosts.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrates_legacy_host_file() {
        let dir = tmp("mig");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("host"), "me@example.com\n").unwrap();
        let s = HostStore::load(&dir);
        assert_eq!(s.hosts.len(), 1);
        assert_eq!(s.hosts[0].hostname, "example.com");
        assert_eq!(s.hosts[0].user, "me");
        assert_eq!(s.default_id.as_deref(), Some("default"));
        assert!(dir.join("hosts.json").exists()); // migration persisted
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tunnel_config_expands_tilde() {
        let cfg = host("x", "x", "hh", 22).to_tunnel_config(8088, 8088, "true".into(), false);
        assert_eq!(cfg.hostname, "hh");
        assert!(!cfg.identity_path.to_string_lossy().starts_with('~'));
    }
}
