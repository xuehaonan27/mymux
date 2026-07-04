//! Async client for the ptyd socket, used by mymuxd. One connection carries
//! requests/replies plus (after `Subscribe`) the output/exit event stream.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{ReadHalf, WriteHalf};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use crate::proto::{
    read_frame, write_frame, Event, PaneInfo, Reply, Req, KIND_INPUT, KIND_JSON, KIND_OUTPUT,
    KIND_SNAPSHOT,
};

/// Server-pushed events, delivered to whoever holds the receiver.
#[derive(Debug)]
pub enum PtydEvent {
    Output {
        id: u32,
        data: Vec<u8>,
    },
    Exit {
        id: u32,
    },
    /// The connection died (ptyd stopped or crashed) — all panes are gone.
    Closed,
}

enum Pending {
    Reply(oneshot::Sender<Reply>),
    Snapshot(oneshot::Sender<Vec<u8>>),
}

pub struct Client {
    out: mpsc::UnboundedSender<(u8, Vec<u8>)>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    next: AtomicU64,
}

const TIMEOUT: Duration = Duration::from_secs(5);

impl Client {
    /// Connect and subscribe to the event stream.
    pub async fn connect(
        path: &Path,
    ) -> std::io::Result<(Arc<Client>, mpsc::UnboundedReceiver<PtydEvent>)> {
        let stream = UnixStream::connect(path).await?;
        let (rd, wr) = tokio::io::split(stream);
        let (out_tx, out_rx) = mpsc::unbounded_channel::<(u8, Vec<u8>)>();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<PtydEvent>();
        let pending: Arc<Mutex<HashMap<u64, Pending>>> = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(writer_loop(wr, out_rx));
        tokio::spawn(reader_loop(rd, ev_tx, pending.clone()));

        let client = Arc::new(Client {
            out: out_tx,
            pending,
            next: AtomicU64::new(1),
        });
        client.send_json(&Req::Subscribe);
        Ok((client, ev_rx))
    }

    fn send_json(&self, req: &Req) {
        let body = serde_json::to_vec(req).unwrap_or_default();
        let _ = self.out.send((KIND_JSON, body));
    }

    fn request(
        &self,
        build: impl FnOnce(u64) -> Req,
        want_snapshot: bool,
    ) -> (
        u64,
        oneshot::Receiver<Reply>,
        Option<oneshot::Receiver<Vec<u8>>>,
    ) {
        let req = self.next.fetch_add(1, Ordering::Relaxed);
        let (rtx, rrx) = oneshot::channel();
        let (stx, srx) = oneshot::channel();
        {
            let mut p = self.pending.lock().unwrap();
            if want_snapshot {
                p.insert(req, Pending::Snapshot(stx));
            } else {
                p.insert(req, Pending::Reply(rtx));
            }
        }
        self.send_json(&build(req));
        (req, rrx, want_snapshot.then_some(srx))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn(
        &self,
        id: u32,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        name: String,
        env: Vec<(String, String)>,
        ephemeral: bool,
    ) -> Result<u32, String> {
        let (_r, rx, _) = self.request(
            |req| Req::Spawn {
                req,
                id,
                cwd,
                cols,
                rows,
                name,
                env,
                ephemeral,
            },
            false,
        );
        let rep = tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "ptyd timeout".to_string())?
            .map_err(|_| "ptyd connection lost".to_string())?;
        if rep.ok {
            Ok(rep.pid.unwrap_or(0))
        } else {
            Err(rep.err.unwrap_or_else(|| "spawn failed".into()))
        }
    }

    pub async fn list(&self) -> Result<Vec<PaneInfo>, String> {
        let (_r, rx, _) = self.request(|req| Req::List { req }, false);
        let rep = tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "ptyd timeout".to_string())?
            .map_err(|_| "ptyd connection lost".to_string())?;
        Ok(rep.panes.unwrap_or_default())
    }

    pub async fn snapshot(&self, id: u32) -> Result<Vec<u8>, String> {
        let (_r, _rx, srx) = self.request(|req| Req::Snapshot { req, id }, true);
        tokio::time::timeout(TIMEOUT, srx.expect("snapshot receiver"))
            .await
            .map_err(|_| "ptyd timeout".to_string())?
            .map_err(|_| "ptyd connection lost".to_string())
    }

    pub fn input(&self, id: u32, bytes: &[u8]) {
        let mut body = Vec::with_capacity(4 + bytes.len());
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(bytes);
        let _ = self.out.send((KIND_INPUT, body));
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        self.send_json(&Req::Resize { id, cols, rows });
    }

    pub fn rename(&self, id: u32, name: String) {
        self.send_json(&Req::Rename { id, name });
    }

    pub fn set_ephemeral(&self, id: u32, ephemeral: bool) {
        self.send_json(&Req::SetEphemeral { id, ephemeral });
    }

    pub fn set_meta(&self, data: String) {
        self.send_json(&Req::SetMeta { data });
    }

    pub async fn get_meta(&self) -> Result<String, String> {
        let (_r, rx, _) = self.request(|req| Req::GetMeta { req }, false);
        let rep = tokio::time::timeout(TIMEOUT, rx)
            .await
            .map_err(|_| "ptyd timeout".to_string())?
            .map_err(|_| "ptyd connection lost".to_string())?;
        Ok(rep.meta.unwrap_or_default())
    }

    pub fn kill(&self, id: u32) {
        self.send_json(&Req::Kill { id });
    }
}

async fn writer_loop(
    mut wr: WriteHalf<UnixStream>,
    mut rx: mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
) {
    while let Some((kind, body)) = rx.recv().await {
        if write_frame(&mut wr, kind, &body).await.is_err() {
            break;
        }
    }
}

async fn reader_loop(
    mut rd: ReadHalf<UnixStream>,
    events: mpsc::UnboundedSender<PtydEvent>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
) {
    loop {
        match read_frame(&mut rd).await {
            Ok(Some((KIND_OUTPUT, body))) if body.len() >= 4 => {
                let id = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
                let _ = events.send(PtydEvent::Output {
                    id,
                    data: body[4..].to_vec(),
                });
            }
            Ok(Some((KIND_SNAPSHOT, body))) if body.len() >= 8 => {
                let req = u64::from_le_bytes(body[..8].try_into().unwrap());
                if let Some(Pending::Snapshot(tx)) = pending.lock().unwrap().remove(&req) {
                    let _ = tx.send(body[8..].to_vec());
                }
            }
            Ok(Some((KIND_JSON, body))) => {
                if let Ok(rep) = serde_json::from_slice::<Reply>(&body) {
                    if rep.rep != 0 {
                        if let Some(Pending::Reply(tx)) = pending.lock().unwrap().remove(&rep.rep) {
                            let _ = tx.send(rep);
                        }
                        continue;
                    }
                }
                if let Ok(ev) = serde_json::from_slice::<Event>(&body) {
                    if ev.ev == "exit" {
                        let _ = events.send(PtydEvent::Exit { id: ev.id });
                    }
                }
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    pending.lock().unwrap().clear(); // pending waiters see their senders drop
    let _ = events.send(PtydEvent::Closed);
}
