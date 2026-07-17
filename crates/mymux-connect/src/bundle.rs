//! The client-side of the release channel: a pinned bundles.json manifest
//! (embedded at app build time), per-arch download over HTTPS with sha256
//! verification, and the runtime mirror override knob.
//!
//! Model: the app NEVER carries daemon bytes for arches it may never push to
//! (macOS/Windows/mobile clients). First contact with a host whose daemon is
//! missing/outdated downloads exactly that host's arch from the pinned
//! release URL — then uploads it over the existing SSH master, same as the
//! old embedded-bundle flow (which stays as the airgapped/x86_64 fallback).

use std::collections::BTreeMap;
use std::io::Read as _;

#[derive(serde::Deserialize, Debug, Clone)]
pub struct BundleManifest {
    pub channel: String,
    pub version: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub assets: BTreeMap<String, BundleAsset>,
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct BundleAsset {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

impl BundleManifest {
    /// None for an empty/invalid embedded manifest (dev builds).
    pub fn parse(s: &str) -> Option<Self> {
        if s.trim().is_empty() {
            return None;
        }
        let m: Self = serde_json::from_str(s).ok()?;
        if m.assets.is_empty() || m.base_url.is_empty() {
            // A manifest without a base URL was produced outside a release
            // (TAGBASE empty) — treat as absent.
            return None;
        }
        Some(m)
    }
}

/// `uname -sm` → the manifest's asset key. Only Linux hosts are supported by
/// the daemon at all; aarch64/arm64 spellings both count.
pub fn arch_key(uname_sm: &str) -> Option<&'static str> {
    let u = uname_sm.trim().to_ascii_lowercase();
    if !u.starts_with("linux") {
        return None;
    }
    if u.contains("x86_64") {
        Some("linux-x86_64")
    } else if u.contains("aarch64") || u.contains("arm64") {
        Some("linux-aarch64")
    } else {
        None
    }
}

/// Full download URL for an asset, honoring the runtime mirror override:
/// `MYMUX_BUNDLE_MIRROR=https://mirror.example/base` swaps the scheme+host
/// of the manifest's baseUrl, keeping its path (tag directory) intact.
pub fn asset_url(man: &BundleManifest, asset: &BundleAsset) -> String {
    let base = std::env::var("MYMUX_BUNDLE_MIRROR")
        .ok()
        .map(|m| m.trim_end_matches('/').to_string())
        .and_then(|m| {
            // keep the original path: base_url = <scheme>://<host><path>
            let after = man.base_url.splitn(2, "://").nth(1)?;
            let slash = after.find('/')?;
            Some(format!("{}{}", m, &after[slash..]))
        })
        .unwrap_or_else(|| man.base_url.trim_end_matches('/').to_string());
    format!("{}/{}", base, asset.name)
}

/// HTTPS GET (blocking, on the blocking pool) with a size cap.
pub async fn download(url: &str, cap: u64) -> Result<Vec<u8>, String> {
    let url = url.to_string();
    tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .call()
            .map_err(|e| format!("download {url}: {e}"))?;
        let mut bytes = Vec::new();
        resp.into_reader()
            .take(cap + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("download {url}: read: {e}"))?;
        if bytes.len() as u64 > cap {
            return Err(format!("download {url}: exceeds {cap} byte cap"));
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| format!("download worker: {e}"))?
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
      "channel": "gitea",
      "version": "mymuxd 0.1.0 (abcdef0)",
      "baseUrl": "https://gitea.aka.cy/XueHaonan/mymux/releases/download/v0.1.0-abcdef0",
      "assets": {
        "linux-x86_64": {"name": "linux-x86_64.tar.gz", "sha256": "aa11", "size": 100},
        "linux-aarch64": {"name": "linux-aarch64.tar.gz", "sha256": "bb22", "size": 200}
      }
    }"#;

    #[test]
    fn arch_mapping() {
        assert_eq!(arch_key("Linux x86_64"), Some("linux-x86_64"));
        assert_eq!(arch_key("Linux aarch64"), Some("linux-aarch64"));
        assert_eq!(arch_key("Linux arm64"), Some("linux-aarch64"));
        assert_eq!(arch_key("Darwin arm64"), None);
        assert_eq!(arch_key("Linux riscv64"), None);
        assert_eq!(arch_key(""), None);
    }

    #[test]
    fn manifest_parse_and_url() {
        let m = BundleManifest::parse(MANIFEST).expect("manifest parses");
        assert_eq!(m.version, "mymuxd 0.1.0 (abcdef0)");
        let a = m.assets.get("linux-aarch64").unwrap();
        assert_eq!(
            asset_url(&m, a),
            "https://gitea.aka.cy/XueHaonan/mymux/releases/download/v0.1.0-abcdef0/linux-aarch64.tar.gz"
        );
    }

    #[test]
    fn manifest_rejects_manifests_without_base() {
        assert!(BundleManifest::parse("").is_none());
        assert!(BundleManifest::parse("{\"channel\":\"gitea\",\"version\":\"v\",\"baseUrl\":\"\",\"assets\":{\"a\":{\"name\":\"a\",\"sha256\":\"a\",\"size\":1}}}").is_none());
    }

    #[test]
    fn mirror_override_keeps_tag_path() {
        let m = BundleManifest::parse(MANIFEST).unwrap();
        let a = m.assets.get("linux-x86_64").unwrap();
        std::env::set_var("MYMUX_BUNDLE_MIRROR", "https://mirror.internal/gitea");
        let url = asset_url(&m, a);
        std::env::remove_var("MYMUX_BUNDLE_MIRROR");
        assert_eq!(
            url,
            "https://mirror.internal/gitea/XueHaonan/mymux/releases/download/v0.1.0-abcdef0/linux-x86_64.tar.gz"
        );
    }

    #[test]
    fn sha256_known_vector() {
        // sha256("") — the well-known empty-input digest.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// The download path the installer leans on: real HTTPS-over-HTTP against
    /// a spawned python http.server (skips when python3 is unavailable).
    #[tokio::test]
    async fn download_roundtrip_and_cap() {
        let Some(py) = std::process::Command::new("python3")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|_| "python3")
        else {
            eprintln!("python3 unavailable — skipping download roundtrip");
            return;
        };
        let dir = std::env::temp_dir().join(format!("mymux-bdl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake.tar.gz"), b"bundle-bytes").unwrap();
        // Grab a free port the std lib's way, then hand it to the server.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut child = std::process::Command::new(py)
            .args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1"])
            .current_dir(&dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn http.server");
        struct Kill(std::process::Child);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = self.0.kill();
            }
        }
        let _kill = Kill(child);
        let url = format!("http://127.0.0.1:{port}/fake.tar.gz");
        // Poll until the server answers (fsyncs + bind race).
        let mut got = None;
        for _ in 0..40 {
            match super::download(&url, 1_000_000).await {
                Ok(b) => {
                    got = Some(b);
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(150)).await,
            }
        }
        let bytes = got.expect("server never answered");
        assert_eq!(bytes, b"bundle-bytes");
        assert_eq!(super::sha256_hex(&bytes), super::sha256_hex(b"bundle-bytes"));
        // The cap bites: a cap below the payload size is an error.
        let err = super::download(&url, 4).await.expect_err("cap must bite");
        assert!(err.contains("cap"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
