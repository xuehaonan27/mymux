//! Server-side terminal state for daemon-owned panes — native-engine step ①.
//!
//! Wraps avt's VT emulation: feed raw pty bytes, snapshot faithful escape
//! sequences for reseed (grid + colors + cursor + alternate screen), replacing
//! the old best-effort raw-byte ring replay. Byte-accurate at UTF-8 boundaries:
//! a multibyte sequence split across reads is carried into the next feed — the
//! same lesson as the tmux `%output` parser.

use avt::{Color, Line, Pen, Vt};

/// Kept history beyond the visible screen; included in reseeds. Matches
/// tmux's default history-limit.
const SCROLLBACK: usize = 2000;

pub struct PaneGrid {
    vt: Vt,
    /// Undecoded tail of the previous chunk (an incomplete UTF-8 sequence,
    /// at most 3 bytes).
    carry: Vec<u8>,
}

impl PaneGrid {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            vt: Vt::builder()
                .size(cols.max(1) as usize, rows.max(1) as usize)
                .scrollback_limit(SCROLLBACK)
                .build(),
            carry: Vec::new(),
        }
    }

    /// Feed raw pty output. Invalid bytes become U+FFFD; an incomplete trailing
    /// multibyte sequence is carried into the next feed.
    pub fn feed(&mut self, bytes: &[u8]) {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut rest: &[u8] = &buf;
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    self.vt.feed_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        // Safe: validated up to `valid`.
                        self.vt
                            .feed_str(std::str::from_utf8(&rest[..valid]).unwrap());
                    }
                    match e.error_len() {
                        Some(bad) => {
                            self.vt.feed_str("\u{FFFD}");
                            rest = &rest[valid + bad..];
                        }
                        None => {
                            // Incomplete sequence at the end — carry it over.
                            self.carry = rest[valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.vt.resize(cols.max(1) as usize, rows.max(1) as usize);
    }

    /// Escape bytes that reproduce the pane's terminal state on a fresh (or
    /// reset) terminal: styled scrollback history first (it lands in the
    /// client's own scrollback), then avt's full state dump (visible grid,
    /// colors, cursor, alternate screen, modes). The prefix backs out of any
    /// stale client state, so this is also safe mid-stream (lossless resync).
    pub fn snapshot(&self) -> Vec<u8> {
        let dump = self.vt.dump();
        let mut out = Vec::new();
        // Back out of either alt-screen flavor (avt's dump uses 1047+DECSC).
        out.extend_from_slice(b"\x1b[?1049l\x1b[?1047l\x1b[0m\x1b[2J\x1b[H");

        // avt's dump covers the screen(s) only; replay the primary buffer's
        // scrolled-off lines ourselves. `lines()` follows the ACTIVE buffer, so
        // skip this while the alternate screen is live (its history is the
        // primary's, invisible right now anyway).
        if !ends_in_alt(&dump) {
            let (_, rows) = self.vt.size();
            let lines: Vec<&Line> = self.vt.lines().collect();
            if lines.len() > rows {
                for line in &lines[..lines.len() - rows] {
                    out.extend_from_slice(styled_line(line).as_bytes());
                    out.extend_from_slice(b"\r\n");
                }
                // The history scrolled the screen; hand dump a clean one (2J
                // clears the grid but not the client's scrollback).
                out.extend_from_slice(b"\x1b[0m\x1b[2J\x1b[H");
            }
        }

        out.extend_from_slice(dump.as_bytes());
        out
    }
}

/// Whether a dump leaves the terminal on the alternate screen. avt's dump uses
/// the 1047 flavor (with DECSC for the cursor); accept 1049 too for safety.
fn ends_in_alt(dump: &str) -> bool {
    let last = |needles: [&str; 2]| {
        needles
            .iter()
            .filter_map(|n| dump.rfind(n))
            .max()
            .map(|i| i as i64)
            .unwrap_or(-1)
    };
    last(["\x1b[?1047h", "\x1b[?1049h"]) > last(["\x1b[?1047l", "\x1b[?1049l"])
}

/// One history line as escape-styled text (runs grouped by pen), with trailing
/// unstyled blanks trimmed. Default-pen text is emitted bare — no SGR noise —
/// since snapshots always start from a reset state.
fn styled_line(line: &Line) -> String {
    let cells = line.cells();
    let mut end = cells.len();
    while end > 0 && cells[end - 1].char() == ' ' && cells[end - 1].pen().is_default() {
        end -= 1;
    }
    let mut out = String::new();
    let mut cur: Option<&Pen> = None;
    for cell in &cells[..end] {
        let pen = cell.pen();
        let switch = match cur {
            None => !pen.is_default(),
            Some(p) => p != pen,
        };
        if switch {
            out.push_str(&sgr(pen));
            cur = Some(pen);
        }
        out.push(cell.char());
    }
    if cur.is_some_and(|p| !p.is_default()) {
        out.push_str("\x1b[0m");
    }
    out
}

/// The SGR sequence selecting exactly this pen (from a reset state).
fn sgr(pen: &Pen) -> String {
    let mut params: Vec<String> = vec!["0".into()];
    if pen.is_bold() {
        params.push("1".into());
    }
    if pen.is_faint() {
        params.push("2".into());
    }
    if pen.is_italic() {
        params.push("3".into());
    }
    if pen.is_underline() {
        params.push("4".into());
    }
    if pen.is_blink() {
        params.push("5".into());
    }
    if pen.is_inverse() {
        params.push("7".into());
    }
    if pen.is_strikethrough() {
        params.push("9".into());
    }
    if let Some(c) = pen.foreground() {
        params.push(color_params(c, 38));
    }
    if let Some(c) = pen.background() {
        params.push(color_params(c, 48));
    }
    format!("\x1b[{}m", params.join(";"))
}

fn color_params(c: Color, base: u8) -> String {
    match c {
        Color::Indexed(n) => format!("{base};5;{n}"),
        Color::RGB(rgb) => format!("{base};2;{};{};{}", rgb.r, rgb.g, rgb.b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replay a snapshot into a fresh emulator; state must reproduce.
    fn replay(grid: &PaneGrid, cols: u16, rows: u16) -> Vt {
        let mut vt = Vt::builder()
            .size(cols as usize, rows as usize)
            .scrollback_limit(SCROLLBACK)
            .build();
        vt.feed_str(std::str::from_utf8(&grid.snapshot()).expect("snapshot is utf8"));
        vt
    }

    #[test]
    fn snapshot_roundtrips_text_and_cursor() {
        let mut g = PaneGrid::new(40, 10);
        g.feed(b"hello\r\nworld $ ");
        let vt2 = replay(&g, 40, 10);
        assert_eq!(vt2.text(), g.vt.text());
        assert_eq!(vt2.cursor(), g.vt.cursor());
    }

    #[test]
    fn snapshot_roundtrips_colors_stably() {
        let mut g = PaneGrid::new(40, 10);
        g.feed(b"\x1b[1;31mred\x1b[0m plain \x1b[48;5;27mbg\x1b[0m");
        let vt2 = replay(&g, 40, 10);
        assert_eq!(vt2.text(), g.vt.text());
        // Stability: dumping the replayed state again must be identical —
        // colors/attributes survived the round trip.
        assert_eq!(vt2.dump(), g.vt.dump());
    }

    #[test]
    fn snapshot_reproduces_alternate_screen() {
        // avt semantics: `text()` is always the PRIMARY buffer; `view()` is the
        // active buffer's visible lines.
        let visible = |vt: &Vt| vt.view().map(|l| l.text()).collect::<Vec<_>>().join("\n");

        let mut g = PaneGrid::new(40, 10);
        g.feed(b"shell prompt $\x1b[?1049h\x1b[2J\x1b[HALTCONTENT");
        assert!(visible(&g.vt).contains("ALTCONTENT"));

        let vt2 = replay(&g, 40, 10);
        assert_eq!(visible(&vt2), visible(&g.vt)); // alt view reproduced
        assert_eq!(vt2.text(), g.vt.text()); // primary preserved underneath
        assert_eq!(vt2.dump(), g.vt.dump());

        // Leaving the alt screen must restore the primary content.
        g.feed(b"\x1b[?1049l");
        assert!(visible(&g.vt).contains("shell prompt $"));
        let vt3 = replay(&g, 40, 10);
        assert_eq!(vt3.dump(), g.vt.dump());
    }

    #[test]
    fn split_multibyte_utf8_carries_over() {
        let mut g = PaneGrid::new(40, 10);
        let bytes = "中".as_bytes(); // 3 bytes
        g.feed(&bytes[..2]);
        g.feed(&bytes[2..]);
        let text = g.vt.text().join("\n");
        assert!(text.contains('中'), "{text:?}");
        assert!(!text.contains('\u{FFFD}'), "{text:?}");
    }

    #[test]
    fn resize_keeps_working() {
        let mut g = PaneGrid::new(20, 5);
        g.feed(b"before");
        g.resize(60, 20);
        g.feed(b" after");
        let vt2 = replay(&g, 60, 20);
        assert_eq!(vt2.text(), g.vt.text());
    }

    #[test]
    fn scrolled_off_history_is_included_and_styled() {
        let mut g = PaneGrid::new(40, 5);
        g.feed(b"\x1b[1;31mREDMARK\x1b[0m\r\n");
        for i in 1..=20 {
            g.feed(format!("LINE{i}\r\n").as_bytes());
        }
        let snap = String::from_utf8(g.snapshot()).unwrap();
        // REDMARK scrolled off a 5-row screen; the reseed must still carry it,
        // with its color.
        assert!(snap.contains("REDMARK"), "{snap:?}");
        let red_at = snap.find("REDMARK").unwrap();
        let sgr_before = snap[..red_at].rfind("\x1b[").map(|i| &snap[i..red_at]);
        // avt normalizes SGR 31 to indexed color 1 (38;5;1) — same red.
        assert!(
            sgr_before.is_some_and(|s| s.contains("38;5;1")),
            "{sgr_before:?}"
        );
        // And the replayed terminal ends with the same visible screen.
        let vt2 = replay(&g, 40, 5);
        let view = |vt: &Vt| vt.view().map(|l| l.text()).collect::<Vec<_>>();
        assert_eq!(view(&vt2), view(&g.vt));
        // History made it into the replayed terminal's buffer too.
        let all = vt2.lines().map(|l| l.text()).collect::<Vec<_>>().join("\n");
        assert!(all.contains("REDMARK"), "{all}");
        assert!(all.contains("LINE1"), "{all}");
    }

    #[test]
    fn alt_screen_snapshot_skips_history_but_keeps_it_underneath() {
        let mut g = PaneGrid::new(40, 5);
        for i in 1..=20 {
            g.feed(format!("LINE{i}\r\n").as_bytes());
        }
        g.feed(b"\x1b[?1049h\x1b[2J\x1b[HALTMARK");
        let snap = String::from_utf8(g.snapshot()).unwrap();
        assert!(snap.contains("ALTMARK"), "{snap:?}");
        // avt's dump enters the alt screen via the 1047 flavor.
        assert!(
            snap.contains("\x1b[?1047h") || snap.contains("\x1b[?1049h"),
            "{snap:?}"
        );
        // Alt-active reseed paints the alt view; primary history is not replayed
        // into the client scrollback while vim & co. are on screen.
        let vt2 = replay(&g, 40, 5);
        let view = |vt: &Vt| vt.view().map(|l| l.text()).collect::<Vec<_>>();
        assert_eq!(view(&vt2), view(&g.vt));
    }
}
