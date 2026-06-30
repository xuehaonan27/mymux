//! WebSocket bridge to the UI.
//!
//! Frame convention (M0):
//! - **binary** server→client = raw pane output bytes (feed straight to xterm.js)
//! - **binary** client→server = raw keystroke bytes (→ `send-keys -H`)
//! - **text** client→server   = JSON control messages ([`ClientMsg`])

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::tmux::Hub;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    Resize { cols: u16, rows: u16 },
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<Arc<Hub>>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, hub))
}

async fn handle(socket: WebSocket, hub: Arc<Hub>) {
    // Subscribe before tmux can produce anything, then make sure it's running.
    let mut rx = hub.subscribe();
    hub.ensure_started();

    let (mut sender, mut receiver) = socket.split();

    // Pane output → client.
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(bytes) => {
                    if sender.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                // We dropped behind the ring buffer; keep going with newest data.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Paint the current screen for this freshly-attached client.
    hub.repaint().await;

    // Client → tmux.
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Binary(b))) => hub.send_input(b.as_ref()).await,
                Some(Ok(Message::Text(t))) => {
                    if let Ok(ClientMsg::Resize { cols, rows }) = serde_json::from_str(t.as_str()) {
                        hub.resize(cols, rows).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {} // ping/pong handled by axum
                Some(Err(_)) => break,
            },
            _ = &mut send_task => break,
        }
    }

    send_task.abort();
}
