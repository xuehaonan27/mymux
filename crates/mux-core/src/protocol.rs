//! Streaming parser for the tmux control-mode line protocol.
//!
//! Feed it one line at a time (the server's stdout split on `\n`, newline
//! stripped) via [`Parser::push_line`]; get back zero or one [`ControlEvent`].
//!
//! Control framing is always 7-bit ASCII. Pane payloads in `%output` carry
//! arbitrary bytes, but non-printable/high bytes are octal-escaped (`\033`,
//! `\015`, ...), so a line never contains a literal newline and is always valid
//! ASCII; [`unescape_output`] turns the escaped form back into raw bytes.

use crate::layout::{parse_layout, Layout};
use crate::{PaneId, SessionId, WindowId};

/// One decoded control-mode message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlEvent {
    /// Raw bytes produced by a pane (already un-escaped).
    Output { pane: PaneId, data: Vec<u8> },
    /// A window's layout changed; `layout` is the parsed form of `raw_layout`.
    LayoutChange {
        window: WindowId,
        raw_layout: String,
        layout: Option<Layout>,
    },
    /// The attached session changed (also fired on initial attach).
    SessionChanged { session: SessionId, name: String },
    /// The active window within a session changed.
    SessionWindowChanged {
        session: SessionId,
        window: WindowId,
    },
    /// A window was created.
    WindowAdd { window: WindowId },
    /// A window was closed.
    WindowClose { window: WindowId },
    /// A window was renamed.
    WindowRenamed { window: WindowId, name: String },
    /// The active pane within a window changed.
    WindowPaneChanged { window: WindowId, pane: PaneId },
    /// Collected output of a `%begin`..`%end`/`%error` command response block.
    CommandReply {
        num: u64,
        lines: Vec<String>,
        error: bool,
    },
    /// The control client is detaching/exiting.
    Exit { reason: Option<String> },
    /// A recognized-syntax but unhandled `%notification`.
    Other { verb: String, rest: String },
}

struct Block {
    num: u64,
    lines: Vec<String>,
}

/// Incremental control-mode parser. Cheap to create; holds only the state of an
/// in-flight `%begin`..`%end` block.
#[derive(Default)]
pub struct Parser {
    block: Option<Block>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one line (without its trailing `\n`). Returns an event if the line
    /// completed one. Lines inside a `%begin`..`%end` block are buffered and
    /// surface together as a single [`ControlEvent::CommandReply`].
    pub fn push_line(&mut self, line: &[u8]) -> Option<ControlEvent> {
        // Control framing is ASCII; tolerate stray bytes without panicking.
        let s = std::str::from_utf8(line).ok()?;
        let s = s.strip_suffix('\r').unwrap_or(s); // defensive against CRLF

        // Inside a command-response block, everything up to %end/%error is reply text.
        if self.block.is_some() {
            if s.starts_with("%end") || s.starts_with("%error") {
                let error = s.starts_with("%error");
                let block = self.block.take().unwrap();
                return Some(ControlEvent::CommandReply {
                    num: block.num,
                    lines: block.lines,
                    error,
                });
            }
            self.block.as_mut().unwrap().lines.push(s.to_string());
            return None;
        }

        if s.is_empty() {
            return None;
        }

        let (verb, rest) = match s.split_once(' ') {
            Some((v, r)) => (v, r),
            None => (s, ""),
        };

        match verb {
            "%begin" => {
                // %begin <ts> <num> <flags>
                let num = rest.split(' ').nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
                self.block = Some(Block {
                    num,
                    lines: Vec::new(),
                });
                None
            }
            "%output" => {
                // %output %<pane> <escaped-payload>
                let (pane_tok, payload) = match rest.split_once(' ') {
                    Some((p, d)) => (p, d),
                    None => (rest, ""),
                };
                Some(ControlEvent::Output {
                    pane: PaneId::parse(pane_tok)?,
                    data: unescape_output(payload),
                })
            }
            "%layout-change" => {
                // %layout-change @<win> <layout> <visible-layout> <flags>
                let mut it = rest.split(' ');
                let window = WindowId::parse(it.next()?)?;
                let raw = it.next().unwrap_or("").to_string();
                let layout = parse_layout(&raw);
                Some(ControlEvent::LayoutChange {
                    window,
                    raw_layout: raw,
                    layout,
                })
            }
            "%session-changed" => {
                let (sess, name) = rest.split_once(' ').unwrap_or((rest, ""));
                Some(ControlEvent::SessionChanged {
                    session: SessionId::parse(sess)?,
                    name: name.to_string(),
                })
            }
            "%session-window-changed" => {
                let mut it = rest.split(' ');
                Some(ControlEvent::SessionWindowChanged {
                    session: SessionId::parse(it.next()?)?,
                    window: WindowId::parse(it.next()?)?,
                })
            }
            "%window-add" => Some(ControlEvent::WindowAdd {
                window: WindowId::parse(rest.trim())?,
            }),
            "%window-close" | "%unlinked-window-close" => Some(ControlEvent::WindowClose {
                window: WindowId::parse(rest.trim())?,
            }),
            "%window-renamed" => {
                let (win, name) = rest.split_once(' ').unwrap_or((rest, ""));
                Some(ControlEvent::WindowRenamed {
                    window: WindowId::parse(win)?,
                    name: name.to_string(),
                })
            }
            "%window-pane-changed" => {
                let mut it = rest.split(' ');
                Some(ControlEvent::WindowPaneChanged {
                    window: WindowId::parse(it.next()?)?,
                    pane: PaneId::parse(it.next()?)?,
                })
            }
            "%exit" => Some(ControlEvent::Exit {
                reason: (!rest.is_empty()).then(|| rest.to_string()),
            }),
            _ => Some(ControlEvent::Other {
                verb: verb.to_string(),
                rest: rest.to_string(),
            }),
        }
    }
}

/// Decode a tmux `%output` payload: `\ooo` (three octal digits) becomes one
/// byte; every other character is literal. tmux escapes control bytes, high
/// bytes and `\` itself, so this round-trips arbitrary binary pane output.
pub fn unescape_output(payload: &str) -> Vec<u8> {
    let b = payload.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 4 <= b.len()
            && (b'0'..=b'7').contains(&b[i + 1])
            && (b'0'..=b'7').contains(&b[i + 2])
            && (b'0'..=b'7').contains(&b[i + 3])
        {
            let v = (b[i + 1] - b'0') as u32 * 64
                + (b[i + 2] - b'0') as u32 * 8
                + (b[i + 3] - b'0') as u32;
            out.push(v as u8);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_control_and_printable() {
        assert_eq!(unescape_output("AB\\015\\012"), b"AB\r\n");
        assert_eq!(unescape_output("\\033[?2004l"), b"\x1b[?2004l");
        assert_eq!(unescape_output("plain text"), b"plain text");
        assert_eq!(unescape_output("\\007"), b"\x07");
    }

    #[test]
    fn unescape_backslash_and_trailing() {
        // tmux escapes '\' as \134
        assert_eq!(unescape_output("a\\134b"), b"a\\b");
        // a lone backslash with too few octal digits stays literal
        assert_eq!(unescape_output("end\\"), b"end\\");
        assert_eq!(unescape_output("\\01"), b"\\01");
    }

    #[test]
    fn parse_output_line() {
        let mut p = Parser::new();
        let ev = p.push_line(b"%output %3 hi\\012").unwrap();
        assert_eq!(
            ev,
            ControlEvent::Output {
                pane: PaneId(3),
                data: b"hi\n".to_vec(),
            }
        );
    }

    #[test]
    fn output_payload_with_spaces() {
        let mut p = Parser::new();
        let ev = p.push_line(b"%output %0 printf 'A").unwrap();
        assert_eq!(
            ev,
            ControlEvent::Output {
                pane: PaneId(0),
                data: b"printf 'A".to_vec(),
            }
        );
    }

    #[test]
    fn command_reply_block_is_buffered() {
        let mut p = Parser::new();
        assert!(p.push_line(b"%begin 1782 262 0").is_none());
        assert!(p.push_line(b"@0 bash 6b8b,100x30,0,0,0").is_none());
        assert!(p.push_line(b"@1 logs b25f,80x24,0,0,2").is_none());
        let ev = p.push_line(b"%end 1782 262 0").unwrap();
        assert_eq!(
            ev,
            ControlEvent::CommandReply {
                num: 262,
                lines: vec![
                    "@0 bash 6b8b,100x30,0,0,0".to_string(),
                    "@1 logs b25f,80x24,0,0,2".to_string(),
                ],
                error: false,
            }
        );
    }

    #[test]
    fn lifecycle_notifications() {
        let mut p = Parser::new();
        assert_eq!(
            p.push_line(b"%session-changed $0 main"),
            Some(ControlEvent::SessionChanged {
                session: SessionId(0),
                name: "main".to_string(),
            })
        );
        assert_eq!(
            p.push_line(b"%window-pane-changed @0 %1"),
            Some(ControlEvent::WindowPaneChanged {
                window: WindowId(0),
                pane: PaneId(1),
            })
        );
        assert_eq!(
            p.push_line(b"%window-add @1"),
            Some(ControlEvent::WindowAdd { window: WindowId(1) })
        );
        assert_eq!(
            p.push_line(b"%exit"),
            Some(ControlEvent::Exit { reason: None })
        );
    }
}
