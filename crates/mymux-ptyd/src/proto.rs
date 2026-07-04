//! Wire protocol between mymuxd and mymux-ptyd, over a unix socket.
//!
//! Frame: `[u32 LE len][u8 kind][body (len-1 bytes)]`.
//! - kind 0: JSON control — client→server a [`Req`]; server→client a [`Reply`]
//!   (correlated by `rep` == the request's `req`) or an [`Event`].
//! - kind 1: input, client→server — `[u32 LE pane id][bytes]`.
//! - kind 2: output, server→client (after `Subscribe`) — `[u32 LE pane id][bytes]`.
//! - kind 3: snapshot reply, server→client — `[u64 LE req][bytes]`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const KIND_JSON: u8 = 0;
pub const KIND_INPUT: u8 = 1;
pub const KIND_OUTPUT: u8 = 2;
pub const KIND_SNAPSHOT: u8 = 3;

/// Sanity bound; snapshots are the largest frames (tens of KB).
pub const MAX_FRAME: u32 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Req {
    /// The CLIENT proposes the pane id — mymuxd owns the id namespace (its
    /// high-bit scheme), ptyd just stores panes under the given key.
    Spawn {
        req: u64,
        id: u32,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        name: String,
        env: Vec<(String, String)>,
    },
    Resize {
        id: u32,
        cols: u16,
        rows: u16,
    },
    Rename {
        id: u32,
        name: String,
    },
    Kill {
        id: u32,
    },
    Snapshot {
        req: u64,
        id: u32,
    },
    List {
        req: u64,
    },
    Subscribe,
    /// Store an opaque client blob (layout trees etc.). Lives in ptyd memory —
    /// deliberately sharing fate with the panes it describes.
    SetMeta {
        data: String,
    },
    GetMeta {
        req: u64,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PaneInfo {
    pub id: u32,
    pub pid: u32,
    pub name: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Reply {
    pub rep: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panes: Option<Vec<PaneInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Event {
    pub ev: String,
    pub id: u32,
}

pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    w: &mut W,
    kind: u8,
    body: &[u8],
) -> std::io::Result<()> {
    let len = body.len() as u32 + 1;
    w.write_all(&len.to_le_bytes()).await?;
    w.write_all(&[kind]).await?;
    w.write_all(body).await?;
    w.flush().await
}

/// `Ok(None)` on a clean EOF at a frame boundary.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
    r: &mut R,
) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut lb = [0u8; 4];
    match r.read_exact(&mut lb).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(lb);
    if len == 0 || len > MAX_FRAME {
        return Err(std::io::Error::other(format!("bad frame length {len}")));
    }
    let mut kb = [0u8; 1];
    r.read_exact(&mut kb).await?;
    let mut body = vec![0u8; (len - 1) as usize];
    r.read_exact(&mut body).await?;
    Ok(Some((kb[0], body)))
}

/// Where the ptyd socket lives: `$MYMUX_PTYD_SOCK`, else
/// `$XDG_RUNTIME_DIR/mymux/ptyd.sock`, else a /tmp fallback.
pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("MYMUX_PTYD_SOCK") {
        return PathBuf::from(p);
    }
    if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(rt).join("mymux/ptyd.sock");
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".into());
    PathBuf::from(format!("/tmp/mymux-ptyd-{user}.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_roundtrip() {
        let (mut a, mut b) = tokio::io::duplex(4096);
        write_frame(&mut a, KIND_OUTPUT, b"\x01\x00\x00\x00hello")
            .await
            .unwrap();
        write_frame(&mut a, KIND_JSON, br#"{"ev":"exit","id":7}"#)
            .await
            .unwrap();
        drop(a);
        let (k1, b1) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(
            (k1, b1.as_slice()),
            (KIND_OUTPUT, &b"\x01\x00\x00\x00hello"[..])
        );
        let (k2, b2) = read_frame(&mut b).await.unwrap().unwrap();
        assert_eq!(k2, KIND_JSON);
        let ev: Event = serde_json::from_slice(&b2).unwrap();
        assert_eq!((ev.ev.as_str(), ev.id), ("exit", 7));
        assert!(read_frame(&mut b).await.unwrap().is_none()); // clean EOF
    }

    #[test]
    fn req_json_shape() {
        let req = Req::Spawn {
            req: 1,
            id: (1 << 30) | 1,
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            name: "shell".into(),
            env: vec![("MYMUX_PANE".into(), "1073741825".into())],
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(s.contains(r#""op":"spawn""#), "{s}");
        let back: Req = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, Req::Spawn { id, .. } if id == (1 << 30) | 1));
    }
}
