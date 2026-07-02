//! mymuxd — the mymux daemon.
//!
//! Drives a single `tmux -C` control client and bridges it to the UI over a
//! WebSocket. M0 serves only `/ws`; the UI is served by Vite in dev and by the
//! daemon itself from M2 on.

mod agent;
mod fs;
mod git;
mod proc;
mod pty;
mod state;
mod tmux;
mod ws;

use axum::http::HeaderValue;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    let hub = tmux::Hub::new();
    tokio::spawn(tmux::heuristic_sweep(hub.clone()));

    // The code panel fetches /fs and /git cross-origin. Restrict to the known UI
    // origins (not `*`) so a random website can't read your files via localhost.
    let allowed_origins: Vec<HeaderValue> = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ]
    .iter()
    .filter_map(|o| o.parse().ok())
    .collect();
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/agent", get(agent::agent_handler))
        .route("/fs/list", get(fs::list))
        .route("/fs/read", get(fs::read))
        .route("/fs/write", post(fs::write))
        .route("/git/status", get(git::status))
        .route("/git/diff", get(git::diff))
        .route("/proc/tree", get(proc::tree))
        .route("/proc/kill", post(proc::kill))
        .with_state(hub)
        .layer(cors);

    // Bind address is overridable via MYMUX_ADDR so a test/second instance can
    // run without colliding with the default :8088.
    let addr = std::env::var("MYMUX_ADDR").unwrap_or_else(|_| "127.0.0.1:8088".into());
    let listener = TcpListener::bind(&addr).await.expect("bind mymuxd port");
    eprintln!("mymuxd listening on ws://{addr}/ws");
    axum::serve(listener, app).await.expect("serve mymuxd");
}
