//! mymuxd — the mymux daemon.
//!
//! Drives a single `tmux -C` control client and bridges it to the UI over a
//! WebSocket. M0 serves only `/ws`; the UI is served by Vite in dev and by the
//! daemon itself from M2 on.

mod agent;
mod state;
mod tmux;
mod ws;

use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let hub = tmux::Hub::new();

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/agent", get(agent::agent_handler))
        .with_state(hub);

    let addr = "127.0.0.1:8088";
    let listener = TcpListener::bind(addr).await.expect("bind mymuxd port");
    eprintln!("mymuxd listening on ws://{addr}/ws");
    axum::serve(listener, app).await.expect("serve mymuxd");
}
