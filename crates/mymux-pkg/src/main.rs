//! mymux-pkg — the package side of mymux's plugin system.
//!
//! Deliberately decoupled from mymux: the ONLY contract between this CLI and
//! its consumers (mymuxd, the UI) is the on-disk layout documented in
//! docs/PKG-SPEC.md — `<pkg dir>/<name>/pkg.json` plus the files it names.
//! Recipes, channels and future package kinds evolve here without touching
//! the daemon.
//!
//! Ecosystem boundary (docs/PKG-SPEC.md): upstream releases and Open VSX are
//! fair game (pinned versions + sha256); the Visual Studio Marketplace and
//! Microsoft's proprietary extensions are NEVER used.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::Digest;

/// The manifest written next to every installed package (contract v1).
#[derive(Serialize, Deserialize)]
struct PkgManifest {
    v: u32,
    name: String,
    version: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    langs: Vec<String>,
    bin: String,
    source: String,
}

struct Recipe {
    name: &'static str,
    version: &'static str,
    kind: &'static str,
    langs: &'static [&'static str],
    desc: &'static str,
    channel: Channel,
}

enum Channel {
    /// Single gzipped binary from a pinned GitHub release.
    GithubGz {
        url: &'static str,
        sha256: &'static str,
        bin: &'static str,
    },
    /// Zip archive from a pinned GitHub release, extracted whole (some
    /// servers, e.g. clangd, need their resource dirs next to the binary).
    GithubZip {
        url: &'static str,
        sha256: &'static str,
        bin: &'static str,
    },
    /// `go install` a module (version pinning + verification via Go's
    /// checksum database — the module transparency log).
    GoInstall {
        module: &'static str,
        bin: &'static str,
    },
    /// `npm install` a pinned package (integrity from the npm registry
    /// metadata). `bin` is relative to the package dir.
    Npm {
        package: &'static str,
        bin: &'static str,
    },
    /// A pinned extension from Open VSX (open-vsx.org — the OPEN registry;
    /// the VS Marketplace is out of bounds, see PKG-SPEC). A .vsix is a zip;
    /// extracted whole, `bin` points inside it.
    #[allow(dead_code)]
    OpenVsx {
        publisher: &'static str,
        ext: &'static str,
        version: &'static str,
        sha256: &'static str,
        bin: &'static str,
    },
}

/// Pinned recipes. sha256 values are the GitHub release asset digests,
/// recorded at pin time — any later re-upload of the asset fails the install.
fn recipes() -> Vec<Recipe> {
    vec![
        Recipe {
            name: "rust-analyzer",
            version: "2026-06-29",
            kind: "lsp-server",
            langs: &["rust"],
            desc: "Rust language server (hover, completion, diagnostics, cargo check on save)",
            channel: Channel::GithubGz {
                url: "https://github.com/rust-lang/rust-analyzer/releases/download/2026-06-29/rust-analyzer-x86_64-unknown-linux-gnu.gz",
                sha256: "e278cbae972df49cbcead8851aea47478478fc5ef686e2c6a35b44911e3926cf",
                bin: "bin/rust-analyzer",
            },
        },
        Recipe {
            name: "clangd",
            version: "22.1.6",
            kind: "lsp-server",
            langs: &["c", "cpp"],
            desc: "C/C++ language server from the LLVM project",
            channel: Channel::GithubZip {
                url: "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip",
                sha256: "a9c77443af2e447ed467e84771848d3a6ac1c56f84bcfcde717e66318de77cfa",
                bin: "clangd_22.1.6/bin/clangd",
            },
        },
        Recipe {
            name: "gopls",
            version: "latest",
            kind: "lsp-server",
            langs: &["go"],
            desc: "Go language server (needs the Go toolchain for install)",
            channel: Channel::GoInstall { module: "golang.org/x/tools/gopls", bin: "bin/gopls" },
        },
        Recipe {
            name: "pyright",
            version: "1.1.411",
            kind: "lsp-server",
            langs: &["python"],
            desc: "Python language server — the open pyright, not Pylance (needs Node.js)",
            channel: Channel::Npm {
                package: "pyright",
                bin: "node_modules/.bin/pyright-langserver",
            },
        },
    ]
}

/// The contract directory: `$MYMUX_PKG_DIR` → `$XDG_DATA_HOME/mymux/pkgs` →
/// `~/.local/share/mymux/pkgs`. Mirrored by consumers (see PKG-SPEC).
fn pkg_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("MYMUX_PKG_DIR") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(d).join("mymux/pkgs"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/mymux/pkgs"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("install") => cmd_install(&args[1..]),
        Some("list") | Some("ls") => cmd_list(),
        Some("catalog") => cmd_catalog(),
        Some("remove") | Some("rm") => cmd_remove(&args[1..]),
        _ => {
            eprintln!(
                "usage: mymux-pkg install <name> | install --lang <lang> | list | remove <name>\n\
                 packages: {}",
                recipes()
                    .iter()
                    .map(|r| format!("{} ({})", r.name, r.langs.join(",")))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            2
        }
    };
    std::process::exit(code);
}

fn cmd_install(args: &[String]) -> i32 {
    let all = recipes();
    let recipe = match args {
        [flag, lang] if flag == "--lang" => all.iter().find(|r| r.langs.contains(&lang.as_str())),
        [name] => all.iter().find(|r| r.name == name.as_str()),
        _ => None,
    };
    let Some(r) = recipe else {
        eprintln!("mymux-pkg: no recipe for {args:?} (try `mymux-pkg` for the list)");
        return 2;
    };
    if !cfg!(target_arch = "x86_64") {
        // v1 pins x86_64-linux assets; other arches need recipe variants.
        if matches!(
            r.channel,
            Channel::GithubGz { .. } | Channel::GithubZip { .. }
        ) {
            eprintln!("mymux-pkg: {} recipe only has x86_64 assets so far", r.name);
            return 1;
        }
    }
    let Some(base) = pkg_dir() else {
        eprintln!("mymux-pkg: cannot resolve the package dir (HOME unset?)");
        return 1;
    };
    let staging = base.join(format!(".tmp-{}", r.name));
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(e) = std::fs::create_dir_all(&staging) {
        eprintln!("mymux-pkg: create {}: {e}", staging.display());
        return 1;
    }
    eprintln!("installing {} {} …", r.name, r.version);
    let built = match &r.channel {
        Channel::GithubGz { url, sha256, bin } => fetch_gz(url, sha256, &staging, bin),
        Channel::GithubZip { url, sha256, bin } => {
            fetch_zip(url, sha256, &staging, bin, "github-release")
        }
        Channel::GoInstall { module, bin } => go_install(module, r.version, &staging, bin),
        Channel::Npm { package, bin } => npm_install(package, r.version, &staging, bin),
        Channel::OpenVsx {
            publisher,
            ext,
            version,
            sha256,
            bin,
        } => {
            let url = format!(
                "https://open-vsx.org/api/{publisher}/{ext}/{version}/file/{publisher}.{ext}-{version}.vsix"
            );
            fetch_zip(&url, sha256, &staging, bin, "openvsx")
        }
    };
    let (bin, source) = match built {
        Ok(x) => x,
        Err(e) => {
            eprintln!("mymux-pkg: install {} failed: {e}", r.name);
            let _ = std::fs::remove_dir_all(&staging);
            return 1;
        }
    };
    let manifest = PkgManifest {
        v: 1,
        name: r.name.to_string(),
        version: r.version.to_string(),
        kind: r.kind.to_string(),
        langs: r.langs.iter().map(|s| s.to_string()).collect(),
        bin: bin.clone(),
        source,
    };
    let mj = serde_json::to_string_pretty(&manifest).expect("manifest serializes");
    if let Err(e) = std::fs::write(staging.join("pkg.json"), mj) {
        eprintln!("mymux-pkg: write manifest: {e}");
        return 1;
    }
    // Atomic-ish swap: remove any previous install, move staging into place.
    let dest = base.join(r.name);
    let _ = std::fs::remove_dir_all(&dest);
    if let Err(e) = std::fs::rename(&staging, &dest) {
        eprintln!("mymux-pkg: activate {}: {e}", dest.display());
        return 1;
    }
    eprintln!(
        "installed {} {} → {}",
        r.name,
        r.version,
        dest.join(&bin).display()
    );
    0
}

/// `catalog` — the recipe directory as JSON: what CAN be installed, with the
/// installed state merged in. This is the UI's "marketplace" feed; consumers
/// (the daemon) just relay it, keeping recipes in this CLI only.
fn cmd_catalog() -> i32 {
    #[derive(Serialize)]
    struct Item {
        name: &'static str,
        version: &'static str,
        kind: &'static str,
        langs: Vec<&'static str>,
        desc: &'static str,
        installed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        installed_version: Option<String>,
    }
    let installed: std::collections::BTreeMap<String, String> = pkg_dir()
        .and_then(|base| std::fs::read_dir(base).ok())
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let s = std::fs::read_to_string(e.path().join("pkg.json")).ok()?;
                    let m = serde_json::from_str::<PkgManifest>(&s).ok()?;
                    Some((m.name, m.version))
                })
                .collect()
        })
        .unwrap_or_default();
    let items: Vec<Item> = recipes()
        .iter()
        .map(|r| Item {
            name: r.name,
            version: r.version,
            kind: r.kind,
            langs: r.langs.to_vec(),
            desc: r.desc,
            installed: installed.contains_key(r.name),
            installed_version: installed.get(r.name).cloned(),
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string(&items).expect("catalog serializes")
    );
    0
}

fn cmd_list() -> i32 {
    let Some(base) = pkg_dir() else { return 1 };
    let Ok(rd) = std::fs::read_dir(&base) else {
        eprintln!("(no packages — {} is empty)", base.display());
        return 0;
    };
    let mut any = false;
    for e in rd.flatten() {
        let mj = e.path().join("pkg.json");
        let Ok(s) = std::fs::read_to_string(&mj) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<PkgManifest>(&s) else {
            continue;
        };
        any = true;
        println!(
            "{:<16} {:<12} {:<11} [{}]",
            m.name,
            m.version,
            m.kind,
            m.langs.join(",")
        );
    }
    if !any {
        eprintln!("(no packages — {} is empty)", base.display());
    }
    0
}

fn cmd_remove(args: &[String]) -> i32 {
    let [name] = args else {
        eprintln!("usage: mymux-pkg remove <name>");
        return 2;
    };
    let Some(base) = pkg_dir() else { return 1 };
    let dir = base.join(name);
    if !dir.join("pkg.json").exists() {
        eprintln!("mymux-pkg: {name} is not installed");
        return 1;
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {
            eprintln!("removed {name}");
            0
        }
        Err(e) => {
            eprintln!("mymux-pkg: remove {name}: {e}");
            1
        }
    }
}

// ---- channels -----------------------------------------------------------

/// Download `url` (via the system curl — ubiquitous on servers, and TLS just
/// works), verify its sha256, return the bytes.
fn download_verified(url: &str, sha256: &str) -> Result<Vec<u8>, String> {
    eprintln!("  fetching {url}");
    let tmp = std::env::temp_dir().join(format!("mymux-pkg-{}.dl", std::process::id()));
    let st = std::process::Command::new("curl")
        .args(["-fsSL", "--max-time", "600", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .map_err(|_| "`curl` is not installed".to_string())?;
    if !st.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download failed ({url})"));
    }
    let data = std::fs::read(&tmp).map_err(|e| format!("read download: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    let got = hex(&sha2::Sha256::digest(&data));
    if got != sha256 {
        return Err(format!(
            "sha256 MISMATCH — refusing to install (expected {sha256}, got {got}). \
             The pinned asset changed upstream; treat as suspicious."
        ));
    }
    eprintln!("  sha256 verified ({} bytes)", data.len());
    Ok(data)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fetch_gz(
    url: &str,
    sha256: &str,
    staging: &Path,
    bin: &str,
) -> Result<(String, String), String> {
    let data = download_verified(url, sha256)?;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(&data[..])
        .read_to_end(&mut out)
        .map_err(|e| format!("gunzip: {e}"))?;
    let path = staging.join(bin);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    make_executable(&path)?;
    Ok((bin.to_string(), "github-release".into()))
}

fn fetch_zip(
    url: &str,
    sha256: &str,
    staging: &Path,
    bin: &str,
    source: &str,
) -> Result<(String, String), String> {
    let data = download_verified(url, sha256)?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    zip.extract(staging).map_err(|e| format!("unzip: {e}"))?;
    let path = staging.join(bin);
    if !path.exists() {
        return Err(format!("{bin} not found in the archive"));
    }
    make_executable(&path)?;
    Ok((bin.to_string(), source.into()))
}

/// Find a toolchain binary: PATH first, then the usual per-user install spots
/// (we may be spawned by a systemd-run daemon whose PATH lacks nvm/go).
fn find_tool(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let executable = |p: &Path| {
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // nvm keeps node/npm under versioned dirs; take the newest.
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev().take(1));
        }
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("go/bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/local/go/bin"));
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| executable(p))
}

fn go_install(
    module: &str,
    version: &str,
    staging: &Path,
    bin: &str,
) -> Result<(String, String), String> {
    let target = format!("{module}@{version}");
    let gobin = staging.join("bin");
    std::fs::create_dir_all(&gobin).map_err(|e| e.to_string())?;
    let go = find_tool("go").ok_or("`go` is not installed — install the Go toolchain first")?;
    eprintln!("  go install {target} (verified via the Go checksum database)");
    let st = std::process::Command::new(go)
        .args(["install", &target])
        .env("GOBIN", &gobin)
        .status()
        .map_err(|e| format!("run go: {e}"))?;
    if !st.success() {
        return Err("go install failed".into());
    }
    Ok((bin.to_string(), "go-install".into()))
}

fn npm_install(
    package: &str,
    version: &str,
    staging: &Path,
    bin: &str,
) -> Result<(String, String), String> {
    let target = format!("{package}@{version}");
    let npm = find_tool("npm").ok_or("`npm` is not installed — install Node.js first")?;
    // npm needs its sibling `node` on PATH even when invoked by full path.
    let npm_dir = npm.parent().map(Path::to_path_buf).unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();
    eprintln!("  npm install {target} (integrity from the npm registry)");
    let st = std::process::Command::new(&npm)
        .args(["install", "--no-fund", "--no-audit", "--prefix"])
        .arg(staging)
        .arg(&target)
        .env("PATH", format!("{}:{}", npm_dir.display(), path))
        .status()
        .map_err(|e| format!("run npm: {e}"))?;
    if !st.success() {
        return Err("npm install failed".into());
    }
    if !staging.join(bin).exists() {
        return Err(format!("{bin} missing after npm install"));
    }
    Ok((bin.to_string(), "npm".into()))
}

fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip_matches_the_contract() {
        let m = PkgManifest {
            v: 1,
            name: "rust-analyzer".into(),
            version: "2026-06-29".into(),
            kind: "lsp-server".into(),
            langs: vec!["rust".into()],
            bin: "bin/rust-analyzer".into(),
            source: "github-release".into(),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""v":1"#), "{s}");
        assert!(s.contains(r#""kind":"lsp-server""#), "{s}");
        let back: PkgManifest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.bin, "bin/rust-analyzer");
    }

    #[test]
    fn every_recipe_lang_is_unique() {
        let rs = recipes();
        let mut langs: Vec<&str> = rs.iter().flat_map(|r| r.langs.iter().copied()).collect();
        let n = langs.len();
        langs.sort();
        langs.dedup();
        assert_eq!(n, langs.len(), "two recipes claim the same language");
    }

    #[test]
    fn no_forbidden_channels() {
        // The ecosystem boundary: nothing may reference the VS Marketplace.
        // (Needles are assembled from pieces so this test's own source
        // doesn't trip itself.)
        let src = include_str!("main.rs");
        let needles = [
            ["marketplace", ".visualstudio", ".com"].concat(),
            ["vsassets", ".io"].concat(),
        ];
        for needle in &needles {
            let hits = src.matches(needle.as_str()).count();
            assert_eq!(hits, 0, "forbidden channel {needle} referenced");
        }
    }
}
