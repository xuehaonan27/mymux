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
    /// Extra argv for launching `bin` (e.g. bash-language-server needs
    /// `start`). Set via `mymux-pkg lang <pkg> <langs…> -- <args…>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    source: String,
    /// The install spec for dynamically-installed packages
    /// (`openvsx:ns.name` / `npm:pkg`) — curated recipes omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spec: Option<String>,
    /// sha256 of a dynamically-downloaded artifact, recorded at install time
    /// (dynamic sources have no pre-pinned digest; this is the audit trail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

struct Recipe {
    name: &'static str,
    version: &'static str,
    kind: &'static str,
    langs: &'static [&'static str],
    /// Launch arguments the server needs (recorded into the manifest so the
    /// daemon can spawn it without a hardcoded table).
    args: &'static [&'static str],
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
            args: &[],
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
            args: &[],
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
            args: &[],
            desc: "Go language server (needs the Go toolchain for install)",
            channel: Channel::GoInstall { module: "golang.org/x/tools/gopls", bin: "bin/gopls" },
        },
        Recipe {
            name: "pyright",
            version: "1.1.411",
            kind: "lsp-server",
            langs: &["python"],
            args: &["--stdio"],
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

// ---- environment / proxy ---------------------------------------------------

/// Load `$MYMUX_CONFIG_DIR|~/.config/mymux/env` as environment DEFAULTS —
/// the process env always wins, the file only fills gaps. This is how a
/// systemd-spawned daemon (scrubbed env, no proxy vars) relays installs that
/// still reach the registries: mymuxd's unit reads the same file via
/// `EnvironmentFile=`, and mymux-pkg self-loads it so a bare invocation
/// behaves identically. Call before spawning any thread.
fn load_env_file() {
    let dir = std::env::var_os("MYMUX_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/mymux")));
    let Some(path) = dir.map(|d| d.join("env")) else {
        return;
    };
    let Ok(s) = std::fs::read_to_string(path) else {
        return;
    };
    for (k, v) in parse_env_lines(&s) {
        if std::env::var_os(&k).is_none() {
            std::env::set_var(&k, &v);
        }
    }
}

/// `KEY=VALUE` lines; `export ` prefix and simple quotes tolerated, `#`
/// comments and malformed keys skipped.
fn parse_env_lines(s: &str) -> Vec<(String, String)> {
    s.lines()
        .filter_map(|l| {
            let t = l.trim();
            let t = t.strip_prefix("export ").unwrap_or(t).trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            let (k, v) = t.split_once('=')?;
            let k = k.trim();
            if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return None;
            }
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|x| x.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
                .unwrap_or(v);
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// The proxy for outbound registry traffic: `MYMUX_PROXY` (mymux-only knob)
/// wins, then the standard variables. Empty values count as unset (the
/// `export https_proxy=` disable idiom). `no_proxy` exclusions keep working —
/// curl honors that env even when the proxy comes via --proxy.
fn proxy_setting() -> Option<String> {
    [
        "MYMUX_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
        "http_proxy",
        "HTTP_PROXY",
    ]
    .iter()
    .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
}

/// A curl invocation with the proxy applied. Passing --proxy explicitly (vs
/// letting curl read the env itself) keeps behavior identical no matter how
/// the value arrived (MYMUX_PROXY has no meaning to curl). The connect
/// timeout fails blackholed egress in seconds instead of waiting out the
/// full transfer budget — 15s because with a proxy it also covers the
/// CONNECT handshake (proxy dials upstream before answering 200); slow
/// TRANSFERS stay allowed via per-call --max-time.
fn curl_cmd() -> std::process::Command {
    let mut c = std::process::Command::new("curl");
    c.args(["--connect-timeout", "15"]);
    if let Some(p) = proxy_setting() {
        c.arg("--proxy").arg(p);
    }
    c
}

/// Export the resolved proxy to a child that reads the standard vars itself
/// (npm, go). No-op without a proxy.
fn proxy_env(c: &mut std::process::Command) {
    if let Some(p) = proxy_setting() {
        c.env("HTTPS_PROXY", &p)
            .env("https_proxy", &p)
            .env("HTTP_PROXY", &p)
            .env("http_proxy", &p);
    }
}

/// Actionable suffix for network-class curl failures (resolve/connect/
/// timeout/TLS — exit codes 5/6/7/28/35).
fn net_hint(code: Option<i32>) -> String {
    if !matches!(code, Some(5 | 6 | 7 | 28 | 35)) {
        return String::new();
    }
    match proxy_setting() {
        None => " — network blocked? if this host needs a proxy, set https_proxy \
                 (or MYMUX_PROXY) in ~/.config/mymux/env"
            .into(),
        Some(p) => format!(" — is the proxy reachable? (using {p})"),
    }
}

fn main() {
    load_env_file();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("install") => cmd_install(&args[1..]),
        Some("list") | Some("ls") => cmd_list(),
        Some("catalog") => cmd_catalog(),
        Some("search") => cmd_search(&args[1..]),
        Some("lang") => cmd_lang(&args[1..]),
        Some("remove") | Some("rm") => cmd_remove(&args[1..]),
        _ => {
            eprintln!(
                "usage: mymux-pkg install <name | openvsx:ns.name[@ver] | npm:pkg[@ver]>\n\
                 \x20      mymux-pkg install --lang <lang>\n\
                 \x20      mymux-pkg search <query>      (Open VSX + npm + curated)\n\
                 \x20      mymux-pkg lang <pkg> <lang..> (bind an installed server to languages)\n\
                 \x20      mymux-pkg list | catalog | remove <pkg>\n\
                 curated: {}",
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

/// Prepare (and clean) the staging dir for an install.
fn staging_for(base: &Path, name: &str) -> Result<PathBuf, String> {
    let staging = base.join(format!(".tmp-{name}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("create {}: {e}", staging.display()))?;
    Ok(staging)
}

/// Swap staging into place under `pkgs/<name>` after writing the manifest.
fn activate(base: &Path, staging: &Path, name: &str, manifest: &PkgManifest) -> Result<(), String> {
    let mj = serde_json::to_string_pretty(manifest).expect("manifest serializes");
    std::fs::write(staging.join("pkg.json"), mj).map_err(|e| format!("write manifest: {e}"))?;
    let dest = base.join(name);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(staging, &dest).map_err(|e| format!("activate {}: {e}", dest.display()))?;
    eprintln!(
        "installed {} {} → {}",
        name,
        manifest.version,
        dest.display()
    );
    Ok(())
}

/// Directory-safe package name (dynamic specs may carry @ / etc.).
fn safe_dir(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn cmd_install(args: &[String]) -> i32 {
    let Some(base) = pkg_dir() else {
        eprintln!("mymux-pkg: cannot resolve the package dir (HOME unset?)");
        return 1;
    };
    // Dynamic specs first: openvsx:ns.name[@ver] / npm:pkg[@ver].
    if let [spec] = args {
        if let Some(rest) = spec.strip_prefix("openvsx:") {
            return run_dynamic(install_openvsx(&base, rest));
        }
        if let Some(rest) = spec.strip_prefix("npm:") {
            return run_dynamic(install_npm_dynamic(&base, rest));
        }
    }
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
    let staging = match staging_for(&base, r.name) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("mymux-pkg: {e}");
            return 1;
        }
    };
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
        args: r.args.iter().map(|s| s.to_string()).collect(),
        bin: bin.clone(),
        source,
        spec: None,
        sha256: None,
    };
    match activate(&base, &staging, r.name, &manifest) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("mymux-pkg: {e}");
            1
        }
    }
}

fn run_dynamic(r: Result<(), String>) -> i32 {
    match r {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("mymux-pkg: {e}");
            1
        }
    }
}

/// `catalog` — the recipe directory as JSON: what CAN be installed, with the
/// installed state merged in. This is the UI's "marketplace" feed; consumers
/// (the daemon) just relay it, keeping recipes in this CLI only.
fn cmd_catalog() -> i32 {
    #[derive(Serialize)]
    struct Item {
        name: String,
        version: String,
        kind: String,
        langs: Vec<String>,
        desc: String,
        installed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        installed_version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spec: Option<String>,
    }
    let installed: std::collections::BTreeMap<String, PkgManifest> = pkg_dir()
        .and_then(|base| std::fs::read_dir(base).ok())
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let s = std::fs::read_to_string(e.path().join("pkg.json")).ok()?;
                    let m = serde_json::from_str::<PkgManifest>(&s).ok()?;
                    Some((m.name.clone(), m))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut items: Vec<Item> = recipes()
        .iter()
        .map(|r| Item {
            name: r.name.to_string(),
            version: r.version.to_string(),
            kind: r.kind.to_string(),
            langs: r.langs.iter().map(|s| s.to_string()).collect(),
            desc: r.desc.to_string(),
            installed: installed.contains_key(r.name),
            installed_version: installed.get(r.name).map(|m| m.version.clone()),
            spec: None,
        })
        .collect();
    // Dynamically-installed packages (search-driven) join the catalog too —
    // one place to see and manage everything.
    let curated: std::collections::BTreeSet<&str> = recipes().iter().map(|r| r.name).collect();
    for (name, m) in &installed {
        if curated.contains(name.as_str()) {
            continue;
        }
        items.push(Item {
            name: name.clone(),
            version: m.version.clone(),
            kind: m.kind.clone(),
            langs: m.langs.clone(),
            desc: match m.spec.as_deref() {
                Some(s) => format!("installed from {s}"),
                None => "installed manually".to_string(),
            },
            installed: true,
            installed_version: Some(m.version.clone()),
            spec: m.spec.clone(),
        });
    }
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
        eprintln!("usage: mymux-pkg remove <name | openvsx:… | npm:…>");
        return 2;
    };
    let Some(base) = pkg_dir() else { return 1 };
    // Accept the same specs `install` does, mapping them to the directory the
    // install created; safe_dir also keeps arbitrary input inside `base`.
    let dir_name = match name.split_once(':') {
        Some(("openvsx" | "npm", rest)) => {
            let bare = match rest.rfind('@') {
                Some(i) if i > 0 => &rest[..i],
                _ => rest,
            };
            safe_dir(bare)
        }
        _ => safe_dir(name),
    };
    // safe_dir keeps dots, so "." / ".." would still traverse — reject them.
    if dir_name.is_empty() || dir_name == "." || dir_name == ".." {
        eprintln!("mymux-pkg: invalid package name");
        return 2;
    }
    let dir = base.join(&dir_name);
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

// ---- dynamic sources (search + install without a curated recipe) ----------

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Fetch a URL (system curl) and parse the body as JSON.
fn http_json(url: &str) -> Result<serde_json::Value, String> {
    http_json_t(url, 30)
}

/// Same with an explicit transfer budget — interactive callers (search) use
/// a short one so a slow registry can't stall the whole panel.
fn http_json_t(url: &str, max_secs: u32) -> Result<serde_json::Value, String> {
    let out = curl_cmd()
        .args(["-fsSL", "--max-time", &max_secs.to_string()])
        .arg(url)
        .output()
        .map_err(|_| "`curl` is not installed".to_string())?;
    if !out.status.success() {
        return Err(format!(
            "request failed ({url}){}",
            net_hint(out.status.code())
        ));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("bad JSON from {url}: {e}"))
}

/// Download without a pre-pinned digest (dynamic sources); returns the bytes
/// and their sha256 for the manifest's audit trail.
fn download_unpinned(url: &str) -> Result<(Vec<u8>, String), String> {
    eprintln!("  fetching {url}");
    let tmp = std::env::temp_dir().join(format!("mymux-pkg-{}.dl", std::process::id()));
    let st = curl_cmd()
        .args(["-fsSL", "--max-time", "600", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .map_err(|_| "`curl` is not installed".to_string())?;
    if !st.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download failed ({url}){}", net_hint(st.code())));
    }
    let data = std::fs::read(&tmp).map_err(|e| format!("read download: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    let sha = hex(&sha2::Sha256::digest(&data));
    eprintln!(
        "  sha256 {sha} ({} bytes, recorded in the manifest)",
        data.len()
    );
    Ok((data, sha))
}

/// `install openvsx:ns.name[@ver]` — download a VSIX from Open VSX (the OPEN
/// registry; the VS Marketplace is never used) and unpack it as an asset
/// package. mymux cannot RUN VS Code extension code — this is for extensions
/// whose value is in their FILES (grammars, themes, bundled binaries).
fn install_openvsx(base: &Path, spec: &str) -> Result<(), String> {
    let (id, ver) = match spec.split_once('@') {
        Some((i, v)) => (i, Some(v.to_string())),
        None => (spec, None),
    };
    let (ns, name) = id
        .split_once('.')
        .ok_or("openvsx spec must be namespace.name")?;
    let version = match ver {
        Some(v) => v,
        None => http_json(&format!(
            "https://open-vsx.org/api/{}/{}",
            urlenc(ns),
            urlenc(name)
        ))?["version"]
            .as_str()
            .ok_or("could not resolve the latest version")?
            .to_string(),
    };
    let dir = safe_dir(&format!("{ns}.{name}"));
    let staging = staging_for(base, &dir)?;
    eprintln!("installing openvsx:{ns}.{name} {version} …");
    let url =
        format!("https://open-vsx.org/api/{ns}/{name}/{version}/file/{ns}.{name}-{version}.vsix");
    let (data, sha) = download_unpinned(&url)?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
    zip.extract(&staging).map_err(|e| format!("unzip: {e}"))?;
    let manifest = PkgManifest {
        v: 1,
        name: dir.clone(),
        version,
        kind: "vsix-assets".into(),
        langs: vec![],
        args: vec![],
        bin: String::new(),
        source: "openvsx".into(),
        spec: Some(format!("openvsx:{ns}.{name}")),
        sha256: Some(sha),
    };
    activate(base, &staging, &dir, &manifest)
}

/// `install npm:pkg[@ver]` — install any npm package. When the package
/// declares a `bin`, it's registered as a runnable server (bind languages
/// with `mymux-pkg lang <pkg> <langs…>`); otherwise it's an asset package.
fn install_npm_dynamic(base: &Path, spec: &str) -> Result<(), String> {
    // Careful with scoped names: `@scope/pkg@ver` — the version separator is
    // the LAST '@' that isn't the leading one.
    let (name, ver) = match spec.rfind('@') {
        Some(i) if i > 0 => (&spec[..i], Some(spec[i + 1..].to_string())),
        _ => (spec, None),
    };
    let version = match ver {
        Some(v) => v,
        None => http_json(&format!(
            "https://registry.npmjs.org/{}/latest",
            urlenc(name).replace("%2F", "/")
        ))?["version"]
            .as_str()
            .ok_or("could not resolve the latest version")?
            .to_string(),
    };
    let dir = safe_dir(name);
    let staging = staging_for(base, &dir)?;
    eprintln!("installing npm:{name} {version} …");
    let (bin, _) = npm_install(name, &version, &staging, "")
        .map_err(|e| e)
        .and_then(|_| Ok((detect_npm_bin(&staging, name), String::new())))?;
    let manifest = PkgManifest {
        v: 1,
        name: dir.clone(),
        version,
        kind: if bin.is_empty() {
            "npm-assets".into()
        } else {
            "lsp-server".into() // runnable; bind langs to wire it to the editor
        },
        langs: vec![],
        args: vec![],
        bin: bin.clone(),
        source: "npm".into(),
        spec: Some(format!("npm:{name}")),
        sha256: None, // npm's registry integrity covers the artifact
    };
    if !bin.is_empty() {
        eprintln!("  found executable `{bin}` — bind languages with: mymux-pkg lang {dir} <lang…>");
    }
    activate(base, &staging, &dir, &manifest)
}

/// The first executable an npm package exposes via its `bin` field, as a
/// package-relative path (empty when it has none).
fn detect_npm_bin(staging: &Path, pkg: &str) -> String {
    let pj = staging.join("node_modules").join(pkg).join("package.json");
    let Ok(s) = std::fs::read_to_string(pj) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
        return String::new();
    };
    let bin_name = match &v["bin"] {
        serde_json::Value::String(_) => pkg.rsplit('/').next().unwrap_or(pkg).to_string(),
        serde_json::Value::Object(m) => match m.keys().next() {
            Some(k) => k.clone(),
            None => return String::new(),
        },
        _ => return String::new(),
    };
    let rel = format!("node_modules/.bin/{bin_name}");
    if staging.join(&rel).exists() {
        rel
    } else {
        String::new()
    }
}

/// `search <query>` — curated recipes + Open VSX + npm, merged as JSON.
/// All network from wherever mymux-pkg runs (the daemon host).
fn cmd_search(args: &[String]) -> i32 {
    let query = args.join(" ");
    if query.trim().is_empty() {
        eprintln!("usage: mymux-pkg search <query>");
        return 2;
    }
    #[derive(Serialize)]
    struct Hit {
        source: &'static str,
        /// What `install` accepts for this hit.
        spec: String,
        name: String,
        version: String,
        desc: String,
        installed: bool,
    }
    let installed_dirs: std::collections::BTreeSet<String> = pkg_dir()
        .and_then(|b| std::fs::read_dir(b).ok())
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("pkg.json").exists())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let mut hits: Vec<Hit> = Vec::new();
    let q = query.to_lowercase();
    for r in recipes() {
        if r.name.contains(&q) || r.desc.to_lowercase().contains(&q) {
            hits.push(Hit {
                source: "curated",
                spec: r.name.to_string(),
                name: r.name.to_string(),
                version: r.version.to_string(),
                desc: r.desc.to_string(),
                installed: installed_dirs.contains(r.name),
            });
        }
    }
    // Registry failures must be VISIBLE (a proxy-blocked cluster would
    // otherwise look like "nothing found") — collected as warnings, search
    // degrades to whatever sources answered.
    let mut warnings: Vec<String> = Vec::new();
    match http_json_t(
        &format!(
            "https://open-vsx.org/api/-/search?query={}&size=10",
            urlenc(&query)
        ),
        12,
    ) {
        Ok(v) => {
            for e in v["extensions"].as_array().unwrap_or(&vec![]) {
                let (Some(ns), Some(name)) = (e["namespace"].as_str(), e["name"].as_str()) else {
                    continue;
                };
                hits.push(Hit {
                    source: "openvsx",
                    spec: format!("openvsx:{ns}.{name}"),
                    name: format!("{ns}.{name}"),
                    version: e["version"].as_str().unwrap_or("?").to_string(),
                    desc: e["description"].as_str().unwrap_or("").to_string(),
                    installed: installed_dirs.contains(&safe_dir(&format!("{ns}.{name}"))),
                });
            }
        }
        Err(e) => warnings.push(format!("open-vsx.org: {e}")),
    }
    match http_json_t(
        &format!(
            "https://registry.npmjs.org/-/v1/search?text={}&size=10",
            urlenc(&query)
        ),
        12,
    ) {
        Ok(v) => {
            for o in v["objects"].as_array().unwrap_or(&vec![]) {
                let p = &o["package"];
                let Some(name) = p["name"].as_str() else {
                    continue;
                };
                hits.push(Hit {
                    source: "npm",
                    spec: format!("npm:{name}"),
                    name: name.to_string(),
                    version: p["version"].as_str().unwrap_or("?").to_string(),
                    desc: p["description"].as_str().unwrap_or("").to_string(),
                    installed: installed_dirs.contains(&safe_dir(name)),
                });
            }
        }
        Err(e) => warnings.push(format!("registry.npmjs.org: {e}")),
    }
    let out = serde_json::json!({ "hits": hits, "warnings": warnings });
    println!("{}", serde_json::to_string(&out).expect("hits serialize"));
    0
}

/// `lang <pkg> <langs…> [-- <args…>]` — bind an installed package's
/// executable to languages (and optionally its launch args) so the editor
/// wires it up as an LSP server.
fn cmd_lang(args: &[String]) -> i32 {
    let (spec, extra): (&[String], &[String]) = match args.iter().position(|a| a == "--") {
        Some(i) => (&args[..i], &args[i + 1..]),
        None => (args, &[]),
    };
    let [name, langs @ ..] = spec else {
        eprintln!("usage: mymux-pkg lang <pkg> <lang…> [-- <launch args…>]");
        return 2;
    };
    if langs.is_empty() {
        eprintln!("usage: mymux-pkg lang <pkg> <lang…> [-- <launch args…>]");
        return 2;
    }
    let Some(base) = pkg_dir() else { return 1 };
    let mj = base.join(name).join("pkg.json");
    let Ok(s) = std::fs::read_to_string(&mj) else {
        eprintln!("mymux-pkg: {name} is not installed");
        return 1;
    };
    let Ok(mut m) = serde_json::from_str::<PkgManifest>(&s) else {
        eprintln!("mymux-pkg: {name} has a bad manifest");
        return 1;
    };
    if m.bin.is_empty() {
        eprintln!("mymux-pkg: {name} has no executable to bind (asset package)");
        return 1;
    }
    m.langs = langs.to_vec();
    if !extra.is_empty() {
        m.args = extra.to_vec();
    }
    m.kind = "lsp-server".into();
    match std::fs::write(&mj, serde_json::to_string_pretty(&m).expect("serializes")) {
        Ok(()) => {
            eprintln!(
                "bound {name} to [{}]{}",
                m.langs.join(", "),
                if m.args.is_empty() {
                    String::new()
                } else {
                    format!(" (launch: {} {})", m.bin, m.args.join(" "))
                }
            );
            0
        }
        Err(e) => {
            eprintln!("mymux-pkg: write manifest: {e}");
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
    let st = curl_cmd()
        .args(["-fsSL", "--max-time", "600", "-o"])
        .arg(&tmp)
        .arg(url)
        .status()
        .map_err(|_| "`curl` is not installed".to_string())?;
    if !st.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("download failed ({url}){}", net_hint(st.code())));
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
    let mut cmd = std::process::Command::new(go);
    cmd.args(["install", &target]).env("GOBIN", &gobin);
    proxy_env(&mut cmd);
    let st = cmd.status().map_err(|e| format!("run go: {e}"))?;
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
    let mut cmd = std::process::Command::new(&npm);
    cmd.args(["install", "--no-fund", "--no-audit", "--prefix"])
        .arg(staging)
        .arg(&target)
        .env("PATH", format!("{}:{}", npm_dir.display(), path));
    proxy_env(&mut cmd);
    let st = cmd.status().map_err(|e| format!("run npm: {e}"))?;
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
            args: vec![],
            bin: "bin/rust-analyzer".into(),
            source: "github-release".into(),
            spec: None,
            sha256: None,
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains(r#""v":1"#), "{s}");
        assert!(s.contains(r#""kind":"lsp-server""#), "{s}");
        // Pre-`args`/`spec` manifests on disk must still deserialize.
        let back: PkgManifest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.bin, "bin/rust-analyzer");
        let legacy = r#"{"v":1,"name":"x","version":"1","kind":"lsp-server","langs":[],"bin":"b","source":"npm"}"#;
        let old: PkgManifest = serde_json::from_str(legacy).unwrap();
        assert!(old.args.is_empty() && old.spec.is_none());
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
    fn env_file_parsing_is_forgiving() {
        let got = parse_env_lines(
            "# proxy for the cluster\n\
             https_proxy=http://proxy.corp:3128\n\
             export MYMUX_PROXY=\"http://user:pw@p:8080\"\n\
             NO_PROXY='internal.corp,10.0.0.0/8'\n\
             \n\
             not a pair\n\
             bad key=x\n\
             =empty\n",
        );
        assert_eq!(
            got,
            vec![
                ("https_proxy".into(), "http://proxy.corp:3128".into()),
                ("MYMUX_PROXY".into(), "http://user:pw@p:8080".into()),
                ("NO_PROXY".into(), "internal.corp,10.0.0.0/8".into()),
            ]
        );
    }

    #[test]
    fn proxy_precedence_mymux_knob_wins() {
        // Serialized in ONE test: env is process-global.
        let clear = || {
            for k in [
                "MYMUX_PROXY",
                "https_proxy",
                "HTTPS_PROXY",
                "all_proxy",
                "ALL_PROXY",
                "http_proxy",
                "HTTP_PROXY",
            ] {
                std::env::remove_var(k);
            }
        };
        clear();
        assert_eq!(proxy_setting(), None);
        std::env::set_var("http_proxy", "http://std:1");
        assert_eq!(proxy_setting().as_deref(), Some("http://std:1"));
        std::env::set_var("https_proxy", "http://https:1");
        assert_eq!(proxy_setting().as_deref(), Some("http://https:1"));
        std::env::set_var("MYMUX_PROXY", "http://mymux:1");
        assert_eq!(proxy_setting().as_deref(), Some("http://mymux:1"));
        std::env::set_var("MYMUX_PROXY", ""); // empty = unset idiom
        assert_eq!(proxy_setting().as_deref(), Some("http://https:1"));
        clear();
        // net_hint branches (still serialized with the env mutations above).
        assert!(net_hint(Some(7)).contains("~/.config/mymux/env"));
        assert_eq!(net_hint(Some(22)), ""); // HTTP-level error, not network-class
        std::env::set_var("MYMUX_PROXY", "http://p:1");
        assert!(net_hint(Some(7)).contains("http://p:1"));
        clear();
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
