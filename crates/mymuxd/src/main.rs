//! mymuxd — the mymux daemon.
//!
//! Drives a single `tmux -C` control client and bridges it to the UI over a
//! WebSocket. M0 serves only `/ws`; the UI is served by Vite in dev and by the
//! daemon itself from M2 on.

mod agent;
mod fs;
mod git;
mod lsp;
mod native;
mod persist;
mod pkgs;
mod proc;
mod state;
mod tmux;
mod ws;

use axum::http::HeaderValue;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

fn main() {
    // `mymuxd --version` — the bootstrap/install freshness probe: crate
    // version plus the source revision (matched against the shipped bundle).
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("mymuxd {} ({})", env!("CARGO_PKG_VERSION"), env!("MYMUX_GIT_REV"));
        return;
    }
    // Env defaults (proxy etc.) must land BEFORE the runtime spawns worker
    // threads — set_var is only sound single-threaded.
    load_env_file();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run());
}

/// Load `$MYMUX_CONFIG_DIR|~/.config/mymux/env` as environment DEFAULTS (the
/// process env wins). Mirrors mymux-pkg's loader — the env-file location is
/// part of the shared convention (see PKG-SPEC), not shared code. This keeps
/// a dev-run mymuxd consistent with the systemd unit, whose
/// `EnvironmentFile=` reads the same file.
fn load_env_file() {
    let dir = std::env::var_os("MYMUX_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config/mymux"))
        });
    let Some(path) = dir.map(|d| d.join("env")) else {
        return;
    };
    let Ok(s) = std::fs::read_to_string(path) else {
        return;
    };
    for l in s.lines() {
        let t = l.trim();
        let t = t.strip_prefix("export ").unwrap_or(t).trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some((k, v)) = t.split_once('=') else {
            continue;
        };
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
            .unwrap_or(v);
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
}

async fn run() {
    let hub = tmux::Hub::new();
    fs::init_hub(hub.clone()); // /fs, /git, /lsp roots resolve native panes via the Hub
    tokio::spawn(tmux::heuristic_sweep(hub.clone()));
    // Adopt persistent panes that survived a previous mymuxd, if ptyd is up.
    {
        let hub = hub.clone();
        tokio::spawn(async move { hub.persist.warmup(&hub).await });
    }

    // Browser-origin hardening. CORS only stops cross-origin PAGES from
    // reading responses — it does not stop the requests themselves, and
    // WebSockets have no CORS at all: any web page could otherwise open
    // ws://127.0.0.1:8088/ws and type into your terminals. So: requests that
    // carry an Origin header (i.e. come from a browser) must match the known
    // UI origins; requests without one (local tools, tests) pass — a same-uid
    // local process is outside this threat model anyway.
    const UI_ORIGINS: [&str; 4] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ];
    async fn origin_guard(
        req: axum::extract::Request,
        next: axum::middleware::Next,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        if let Some(origin) = req.headers().get(axum::http::header::ORIGIN) {
            let ok = origin
                .to_str()
                .map(|o| UI_ORIGINS.contains(&o))
                .unwrap_or(false);
            if !ok {
                return axum::http::StatusCode::FORBIDDEN.into_response();
            }
        }
        next.run(req).await
    }

    // The code panel fetches /fs and /git cross-origin. Restrict to the known UI
    // origins (not `*`) so a random website can't read your files via localhost.
    let allowed_origins: Vec<HeaderValue> =
        UI_ORIGINS.iter().filter_map(|o| o.parse().ok()).collect();
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/agent", get(agent::agent_handler))
        .route("/fs/list", get(fs::list))
        .route("/fs/root", get(fs::root))
        .route("/fs/read", get(fs::read))
        .route("/fs/raw", get(fs::raw))
        .route("/fs/write", post(fs::write))
        .route("/git/status", get(git::status))
        .route("/git/diff", get(git::diff))
        .route("/git/files", get(git::files))
        .route("/git/toplevel", get(git::toplevel))
        .route("/git/blob", get(git::blob))
        .route("/git/log", get(git::log))
        .route("/git/show", get(git::show))
        .route("/git/blame", get(git::blame))
        .route("/git/add", post(git::add))
        .route("/git/unstage", post(git::unstage))
        .route("/git/commit", post(git::commit))
        .route("/git/fetch", post(git::fetch))
        .route("/git/pull", post(git::pull))
        .route("/git/push", post(git::push))
        .route("/git/rebase", post(git::rebase))
        .route("/git/cherry-pick", post(git::cherry_pick))
        .route("/git/revert", post(git::revert))
        .route("/git/checkout", post(git::checkout))
        .route("/git/reset", post(git::reset))
        .route("/git/stash/list", get(git::stash_list))
        .route("/git/stash", post(git::stash_push))
        .route("/git/stash/pop", post(git::stash_pop))
        .route("/git/stash/apply", post(git::stash_apply))
        .route("/git/stash/drop", post(git::stash_drop))
        .route("/lsp", get(lsp::ws_handler))
        .route("/lsp/info", get(lsp::info))
        .route("/lsp/install", post(lsp::install))
        .route("/pkgs/catalog", get(pkgs::catalog))
        .route("/pkgs/search", get(pkgs::search))
        .route("/pkgs/install", post(pkgs::install))
        .route("/pkgs/remove", post(pkgs::remove))
        .route("/proc/tree", get(proc::tree))
        .route("/proc/kill", post(proc::kill))
        .with_state(hub)
        .layer(axum::middleware::from_fn(origin_guard))
        .layer(cors);

    // Bind address is overridable via MYMUX_ADDR so a test/second instance can
    // run without colliding with the default :8088.
    let addr = std::env::var("MYMUX_ADDR").unwrap_or_else(|_| "127.0.0.1:8088".into());
    let listener = TcpListener::bind(&addr).await.expect("bind mymuxd port");
    eprintln!("mymuxd listening on ws://{addr}/ws");
    axum::serve(listener, app).await.expect("serve mymuxd");
}
