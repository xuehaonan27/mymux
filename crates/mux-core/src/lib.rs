//! Core of mymux: a parser and session model for the tmux **control mode**
//! (`tmux -C` / `-CC`) protocol.
//!
//! tmux control mode turns a tmux server into a line-oriented protocol over a
//! pipe: it emits notifications (`%output`, `%layout-change`, `%window-add`,
//! ...) and command-response blocks (`%begin` ... `%end`). A client writes tmux
//! commands back on the same pipe (`send-keys -H ...`, `refresh-client -C ...`).
//! This is exactly the mechanism iTerm2 uses for its native tmux integration.
//!
//! This crate is deliberately dependency-free and I/O-free: it turns bytes into
//! [`ControlEvent`]s ([`protocol`]) and folds those events into a [`Model`]
//! ([`model`]). Process spawning, sockets and rendering live in `mymuxd`/`ui`.

use std::fmt;

pub mod layout;
pub mod model;
pub mod protocol;

pub use layout::{parse_layout, CellKind, Layout, LayoutCell};
pub use model::Model;
pub use protocol::{unescape_output, ControlEvent, Parser};

/// A tmux pane id, rendered as `%N` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PaneId(pub u32);

/// A tmux window id, rendered as `@N` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WindowId(pub u32);

/// A tmux session id, rendered as `$N` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u32);

impl fmt::Display for PaneId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "%{}", self.0)
    }
}
impl fmt::Display for WindowId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "@{}", self.0)
    }
}
impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "${}", self.0)
    }
}

impl PaneId {
    /// Parse a `%N` token.
    pub fn parse(tok: &str) -> Option<PaneId> {
        tok.strip_prefix('%')?.parse().ok().map(PaneId)
    }
    /// Parse a `%N` token from raw bytes (the id itself is ASCII).
    pub fn parse_bytes(tok: &[u8]) -> Option<PaneId> {
        let n = tok.strip_prefix(b"%")?;
        std::str::from_utf8(n).ok()?.parse().ok().map(PaneId)
    }
}
impl WindowId {
    /// Parse a `@N` token.
    pub fn parse(tok: &str) -> Option<WindowId> {
        tok.strip_prefix('@')?.parse().ok().map(WindowId)
    }
}
impl SessionId {
    /// Parse a `$N` token.
    pub fn parse(tok: &str) -> Option<SessionId> {
        tok.strip_prefix('$')?.parse().ok().map(SessionId)
    }
}
