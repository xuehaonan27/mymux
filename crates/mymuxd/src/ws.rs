//! WebSocket bridge to the UI (protocol v2).
//!
//! Server→client:
//! - **binary** `[u32 LE paneId][raw bytes]` — pane output (and screen reseeds).
//! - **text** JSON `{"t":"state",...}` — window/pane/layout snapshot.
//!
//! Client→server:
//! - **binary** `[u32 LE paneId][key bytes]` — keystrokes for that pane.
//! - **text** JSON — resize/focus/window/split commands ([`ClientMsg`]).

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::tmux::{Hub, ServerEvent};

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum ClientMsg {
    Resize { cols: u16, rows: u16 },
    Focus { pane: u32 },
    SelectPane { dir: String },
    Split { pane: u32, dir: String },
    NewWindow,
    SelectWindow { id: u32 },
    ClosePane { pane: u32 },
}

/// Prepend the pane id as a 4-byte LE header to a payload.
fn frame(pane: u32, data: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(4 + data.len());
    f.extend_from_slice(&pane.to_le_bytes());
    f.extend_from_slice(data);
    f
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<Arc<Hub>>) -> Response {
    ws.on_upgrade(move |socket| handle(socket, hub))
}

async fn handle(socket: WebSocket, hub: Arc<Hub>) {
    let mut rx = hub.subscribe();
    hub.ensure_started();

    let (mut sender, mut receiver) = socket.split();

    // Initial sync: current structure, then a screen reseed for each visible pane.
    let _ = sender.send(Message::Text(hub.state_json().into())).await;
    for (pane, seed) in hub.snapshot_visible().await {
        let _ = sender.send(Message::Binary(frame(pane, &seed).into())).await;
    }

    // Server events → client.
    let mut send_task = tokio::spawn({
        let hub = hub.clone();
        async move {
            loop {
                match rx.recv().await {
                    Ok(ServerEvent::Output { pane, data }) => {
                        if sender
                            .send(Message::Binary(frame(pane, &data).into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(ServerEvent::State(json)) => {
                        if sender.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    // P2 lossless: we fell behind. Rather than drop bytes and
                    // corrupt the stream, resync from tmux's authoritative state.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if sender
                            .send(Message::Text(hub.state_json().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        for (pane, seed) in hub.snapshot_visible().await {
                            if sender
                                .send(Message::Binary(frame(pane, &seed).into()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    });

    // Client → tmux.
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Binary(b))) => {
                    if b.len() >= 4 {
                        let pane = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                        hub.send_input(pane, &b[4..]).await;
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if let Ok(msg) = serde_json::from_str::<ClientMsg>(t.as_str()) {
                        match msg {
                            ClientMsg::Resize { cols, rows } => hub.resize(cols, rows).await,
                            ClientMsg::Focus { pane } => hub.focus(pane).await,
                            ClientMsg::SelectPane { dir } => hub.select_pane_dir(&dir).await,
                            ClientMsg::Split { pane, dir } => hub.split(pane, dir == "h").await,
                            ClientMsg::NewWindow => hub.new_window().await,
                            ClientMsg::SelectWindow { id } => hub.select_window(id).await,
                            ClientMsg::ClosePane { pane } => hub.close_pane(pane).await,
                        }
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
