//! mymux-pkg — the package side of mymux's plugin system.
//!
//! Deliberately decoupled from mymux: the ONLY contract between this CLI and
//! its consumers (mymuxd, the UI) is the on-disk layout documented in
//! docs/PKG-SPEC.md — `<pkg dir>/<name>/pkg.json` plus the files it names.
//! Recipes, channels and future package kinds evolve here without touching
//! the daemon.
//!
//! Ecosystem boundary (docs/PKG-SPEC.md): pinned upstream releases and the
//! npm/go registries are fair game; the Visual Studio Marketplace and
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
    /// The install spec for dynamically-installed packages (`npm:pkg`) —
    /// index entries omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spec: Option<String>,
    /// sha256 of a dynamically-downloaded artifact, recorded at install time
    /// (dynamic sources have no pre-pinned digest; this is the audit trail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

// ---- the package index ------------------------------------------------------

/// The index shipped with this build — `index/index.json` at the repo root,
/// embedded at compile time so a bare binary works offline. The FILE is the
/// source of truth (data, not code): version bumps and new entries are JSON
/// edits, and community contributions arrive as PRs against it.
const EMBEDDED_INDEX: &str = include_str!("../../../index/index.json");

#[derive(Deserialize)]
struct Index {
    v: u32,
    packages: std::collections::BTreeMap<String, IndexEntry>,
}

/// One index entry: a friendly, PREWIRED package — install it and the
/// capability config (langs/args) lands in the manifest with no extra step.
#[derive(Deserialize, Clone)]
struct IndexEntry {
    title: String,
    #[serde(default)]
    desc: String,
    kind: String,
    #[serde(default)]
    langs: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    version: String,
    channel: ChannelSpec,
}

/// How the bytes arrive. Pins (sha256 / versions) live HERE, in reviewed
/// index data — the ecosystem boundary (no VS Marketplace, no MS-proprietary)
/// is enforced by unit tests over the index file.
#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ChannelSpec {
    /// Single gzipped binary from a pinned release URL.
    GithubGz {
        url: String,
        sha256: String,
        bin: String,
    },
    /// Zip archive extracted whole (clangd needs its resource dirs).
    GithubZip {
        url: String,
        sha256: String,
        bin: String,
    },
    /// A raw executable published as-is (marksman-style single binaries).
    GithubBin {
        url: String,
        sha256: String,
        bin: String,
    },
    /// `go install` — version pinning + verification via Go's checksum db.
    Go { module: String, bin: String },
    /// `npm install` at the entry's pinned version; `extras` are additional
    /// argv specs installed alongside (e.g. typescript for its language
    /// server). Empty `bin` = auto-detect from the package's bin field.
    Npm {
        package: String,
        #[serde(default)]
        extras: Vec<String>,
        #[serde(default)]
        bin: String,
    },
}

/// The effective index: embedded snapshot + an optional user overlay
/// (`$MYMUX_INDEX` path, else `<config>/index.json`) merged over it — overlay
/// entries win on name collision, so users can pin different versions or add
/// private entries without forking the base.
fn index() -> std::collections::BTreeMap<String, IndexEntry> {
    let mut map = match serde_json::from_str::<Index>(EMBEDDED_INDEX) {
        Ok(i) if i.v == 1 => i.packages,
        _ => {
            eprintln!("mymux-pkg: embedded index is invalid (build problem)");
            Default::default()
        }
    };
    let overlay = std::env::var_os("MYMUX_INDEX")
        .map(PathBuf::from)
        .or_else(|| config_dir().map(|d| d.join("index.json")))
        .filter(|p| p.is_file());
    if let Some(path) = overlay {
        match std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Index>(&s).ok())
        {
            Some(i) if i.v == 1 => map.extend(i.packages),
            _ => eprintln!(
                "mymux-pkg: ignoring invalid index overlay {}",
                path.display()
            ),
        }
    }
    map
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

/// `$MYMUX_CONFIG_DIR` → `~/.config/mymux` (shared convention with mymuxd).
fn config_dir() -> Option<PathBuf> {
    std::env::var_os("MYMUX_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/mymux")))
}

// ---- environment / proxy ---------------------------------------------------

/// Load `$MYMUX_CONFIG_DIR|~/.config/mymux/env` as environment DEFAULTS —
/// the process env always wins, the file only fills gaps. This is how a
/// systemd-spawned daemon (scrubbed env, no proxy vars) relays installs that
/// still reach the registries: mymuxd's unit reads the same file via
/// `EnvironmentFile=`, and mymux-pkg self-loads it so a bare invocation
/// behaves identically. Call before spawning any thread.
fn load_env_file() {
    let Some(path) = config_dir().map(|d| d.join("env")) else {
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
                "usage: mymux-pkg install <name | npm:pkg[@ver]>\n\
                 \x20      mymux-pkg install --lang <lang>\n\
                 \x20      mymux-pkg search <query>      (curated index)\n\
                 \x20      mymux-pkg lang <pkg> <lang..> (bind an installed server to languages)\n\
                 \x20      mymux-pkg list | catalog | remove <pkg>\n\
                 index: {}",
                index()
                    .iter()
                    .map(|(n, e)| format!("{n} ({})", e.langs.join(",")))
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
    // Dynamic specs first: npm:pkg[@ver].
    if let [spec] = args {
        if let Some(rest) = spec.strip_prefix("npm:") {
            return run_dynamic(install_npm_dynamic(&base, rest));
        }
    }
    let idx = index();
    let found = match args {
        [flag, lang] if flag == "--lang" => idx
            .iter()
            .find(|(_, e)| e.langs.iter().any(|l| l == lang))
            .map(|(n, e)| (n.clone(), e.clone())),
        [name] => idx.get(name.as_str()).map(|e| (name.clone(), e.clone())),
        _ => None,
    };
    let Some((name, entry)) = found else {
        eprintln!("mymux-pkg: {args:?} is not in the index (try `mymux-pkg` for the list)");
        return 2;
    };
    match install_from_index(&base, &name, &entry) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("mymux-pkg: install {name} failed: {e}");
            1
        }
    }
}

/// Install an index entry: fetch via its channel, then write a manifest that
/// carries the PREWIRED capability config (langs/args) — no separate binding
/// step, which is the point of the index.
fn install_from_index(base: &Path, name: &str, entry: &IndexEntry) -> Result<(), String> {
    if !cfg!(target_arch = "x86_64") {
        // v1 pins x86_64-linux assets; other arches need index variants.
        if matches!(
            entry.channel,
            ChannelSpec::GithubGz { .. }
                | ChannelSpec::GithubZip { .. }
                | ChannelSpec::GithubBin { .. }
        ) {
            return Err(format!("the {name} entry only has x86_64 assets so far"));
        }
    }
    let staging = staging_for(base, name)?;
    eprintln!("installing {name} {} …", entry.version);
    let built = match &entry.channel {
        ChannelSpec::GithubGz { url, sha256, bin } => fetch_gz(url, sha256, &staging, bin),
        ChannelSpec::GithubZip { url, sha256, bin } => {
            fetch_zip(url, sha256, &staging, bin, "github-release")
        }
        ChannelSpec::GithubBin { url, sha256, bin } => fetch_raw_bin(url, sha256, &staging, bin),
        ChannelSpec::Go { module, bin } => go_install(module, &entry.version, &staging, bin),
        ChannelSpec::Npm {
            package,
            extras,
            bin,
        } => npm_install(package, &entry.version, extras, &staging, bin).map(|(b, s)| {
            let b = if b.is_empty() {
                detect_npm_bin(&staging, package)
            } else {
                b
            };
            (b, s)
        }),
    };
    let (bin, source) = built.inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    let manifest = PkgManifest {
        v: 1,
        name: name.to_string(),
        version: entry.version.clone(),
        kind: entry.kind.clone(),
        langs: entry.langs.clone(),
        args: entry.args.clone(),
        bin,
        source,
        spec: None,
        sha256: None, // index installs are PINNED there; manifests record only unpinned digests
    };
    activate(base, &staging, name, &manifest)
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
        #[serde(skip_serializing_if = "String::is_empty")]
        title: String,
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
    let idx = index();
    let mut items: Vec<Item> = idx
        .iter()
        .map(|(n, e)| Item {
            name: n.clone(),
            title: e.title.clone(),
            version: e.version.clone(),
            kind: e.kind.clone(),
            langs: e.langs.clone(),
            desc: e.desc.clone(),
            installed: installed.contains_key(n),
            installed_version: installed.get(n).map(|m| m.version.clone()),
            spec: None,
        })
        .collect();
    // Dynamically-installed packages (search-driven) join the catalog too —
    // one place to see and manage everything.
    for (name, m) in &installed {
        if idx.contains_key(name) {
            continue;
        }
        items.push(Item {
            name: name.clone(),
            title: String::new(),
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
        eprintln!("usage: mymux-pkg remove <name | npm:…>");
        return 2;
    };
    let Some(base) = pkg_dir() else { return 1 };
    // Accept the same specs `install` does, mapping them to the directory the
    // install created; safe_dir also keeps arbitrary input inside `base`.
    let dir_name = match name.split_once(':') {
        Some(("npm", rest)) => {
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
    npm_install(name, &version, &[], &staging, "")?;
    let bin = detect_npm_bin(&staging, name);
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

/// `search <query>` — the curated index only, as JSON. mymux's package
/// ecosystem is its own catalog: the panel never lists registry odds and
/// ends (npm remains an install *channel* for pinned entries and the
/// explicit `npm:pkg` escape hatch, never a browse source).
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
        /// Friendly display name (index title).
        #[serde(skip_serializing_if = "String::is_empty")]
        title: String,
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
    for (n, e) in index() {
        if n.contains(&q)
            || e.title.to_lowercase().contains(&q)
            || e.desc.to_lowercase().contains(&q)
            || e.langs.iter().any(|l| l == &q)
        {
            hits.push(Hit {
                source: "curated",
                spec: n.clone(),
                name: n.clone(),
                title: e.title.clone(),
                version: e.version.clone(),
                desc: e.desc.clone(),
                installed: installed_dirs.contains(&n),
            });
        }
    }
    let out = serde_json::json!({ "hits": hits });
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
    extras: &[String],
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
        .args(extras) // companion packages, e.g. typescript for its server
        .env("PATH", format!("{}:{}", npm_dir.display(), path));
    proxy_env(&mut cmd);
    let st = cmd.status().map_err(|e| format!("run npm: {e}"))?;
    if !st.success() {
        return Err("npm install failed".into());
    }
    if !bin.is_empty() && !staging.join(bin).exists() {
        return Err(format!("{bin} missing after npm install"));
    }
    Ok((bin.to_string(), "npm".into()))
}

/// A raw executable published as a bare release asset (no archive) —
/// verified, written to `bin`, chmod +x.
fn fetch_raw_bin(
    url: &str,
    sha256: &str,
    staging: &Path,
    bin: &str,
) -> Result<(String, String), String> {
    let data = download_verified(url, sha256)?;
    let path = staging.join(bin);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    make_executable(&path)?;
    Ok((bin.to_string(), "github-release".into()))
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

    /// The embedded index is DATA reviewed by tests, not code reviewed by the
    /// compiler — so validate every field a bad PR could break.
    #[test]
    fn embedded_index_is_valid() {
        let idx: Index = serde_json::from_str(EMBEDDED_INDEX).expect("index/index.json parses");
        assert_eq!(idx.v, 1);
        assert!(!idx.packages.is_empty());
        let mut langs_seen: Vec<&str> = Vec::new();
        for (name, e) in &idx.packages {
            assert!(
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)),
                "bad package name {name:?}"
            );
            assert!(!e.title.is_empty(), "{name}: title required");
            assert!(!e.version.is_empty(), "{name}: version required");
            if e.kind == "lsp-server" {
                assert!(!e.langs.is_empty(), "{name}: lsp-server needs langs");
            }
            langs_seen.extend(e.langs.iter().map(String::as_str));
            let (url, sha, bin) = match &e.channel {
                ChannelSpec::GithubGz { url, sha256, bin }
                | ChannelSpec::GithubZip { url, sha256, bin }
                | ChannelSpec::GithubBin { url, sha256, bin } => (
                    Some(url.as_str()),
                    Some(sha256.as_str()),
                    Some(bin.as_str()),
                ),
                ChannelSpec::Go { bin, .. } => (None, None, Some(bin.as_str())),
                ChannelSpec::Npm { .. } => (None, None, None),
            };
            if let Some(u) = url {
                // Ecosystem boundary: release assets come from GitHub only
                // (npm / go have their own channel types).
                assert!(
                    u.starts_with("https://github.com/"),
                    "{name}: url must be a github release ({u})"
                );
            }
            if let Some(s) = sha {
                assert!(
                    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()),
                    "{name}: sha256 must be 64 hex chars"
                );
            }
            if let Some(b) = bin {
                assert!(
                    !b.is_empty() && !b.starts_with('/'),
                    "{name}: bin must be relative"
                );
            }
        }
        let n = langs_seen.len();
        langs_seen.sort();
        langs_seen.dedup();
        assert_eq!(
            n,
            langs_seen.len(),
            "two index entries claim the same language"
        );
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
        // The ecosystem boundary: nothing may reference the VS Marketplace,
        // and the index must not carry MS-proprietary extensions (their
        // EULAs bind them to official VS Code wherever the file came from).
        // (Needles are assembled from pieces so this test's own source
        // doesn't trip itself.)
        let needles = [
            ["marketplace", ".visualstudio", ".com"].concat(),
            ["vsassets", ".io"].concat(),
        ];
        for haystack in [include_str!("main.rs"), EMBEDDED_INDEX] {
            for needle in &needles {
                let hits = haystack.matches(needle.as_str()).count();
                assert_eq!(hits, 0, "forbidden channel {needle} referenced");
            }
        }
        let proprietary = [
            ["ms-", "python.python"].concat(),
            ["ms-", "vscode.cpptools"].concat(),
            ["ms-", "toolsai"].concat(),
            ["github", ".copilot"].concat(),
        ];
        for needle in &proprietary {
            assert_eq!(
                EMBEDDED_INDEX.matches(needle.as_str()).count(),
                0,
                "MS-proprietary extension {needle} in the index"
            );
        }
    }
}
