//! Server-side terminal state for daemon-owned panes — native-engine step ①.
//!
//! Wraps avt's VT emulation: feed raw pty bytes, snapshot faithful escape
//! sequences for reseed (grid + colors + cursor + alternate screen), replacing
//! the old best-effort raw-byte ring replay. Byte-accurate at UTF-8 boundaries:
//! a multibyte sequence split across reads is carried into the next feed — the
//! same lesson as the tmux `%output` parser.

use avt::{Color, Line, Pen, Vt};

/// Kept history beyond the visible screen, replayed into the client on
/// reconnect. 2000 → 4096 after the app-restart user report that shell-pane
/// history felt truncated ("only the current page stayed"). Memory per pane
/// stays trivial; the raw log ptyd keeps (up to 64 MB) remains the deep
/// tier via the terminal-history pager either way.
const SCROLLBACK: usize = 4096;

/// Hard caps on pane dimensions (#4): an unclamped 65535×65535 request
/// reallocates ~137 GB of avt cells and OOM-aborts ptyd, killing every shell
/// it holds. ptyd also clamps at the request entry (main.rs) — this is the
/// defense-in-depth half.
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 500;

pub struct PaneGrid {
    vt: Vt,
    /// Undecoded tail of the previous chunk (an incomplete UTF-8 sequence,
    /// at most 3 bytes).
    carry: Vec<u8>,
    /// Authoritative alt-screen state, tracked over complete `CSI ?1047/1049
    /// h|l` sequences (chunk-split safe via alt_tail). DEC 1048 is NOT an
    /// alt-screen switch — it only saves/restores the cursor (C-30). The
    /// agent heuristics read this instead of hoping their byte-scan catches
    /// them.
    alt: bool,
    alt_tail: Vec<u8>,
    /// Current dims (kept so the deferred primary reflow knows the target).
    cols: u16,
    rows: u16,
    /// A resize landed while the pane was on the alternate screen: avt's
    /// resize reflows only the ACTIVE buffer, so the primary underneath kept
    /// the stale width. Reflow it once, on the flip back to primary —
    /// otherwise the next reseed dumps stale-width rows (wrap-junk frames).
    resized_while_alt: bool,
}

/// The four complete alt-screen sequences we track (all exactly 8 bytes).
/// Only 1047/1049 switch buffers; DEC 1048 (save/restore cursor) must not
/// flip this state (C-30).
const ALT_SEQS: [(&[u8], bool); 4] = [
    (b"\x1b[?1047h", true),
    (b"\x1b[?1047l", false),
    (b"\x1b[?1049h", true),
    (b"\x1b[?1049l", false),
];
/// Sequences are 8 bytes: only the trailing 7 can sit incomplete at a cut.
const ALT_CARRY: usize = 7;

impl PaneGrid {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.clamp(1, MAX_COLS);
        let rows = rows.clamp(1, MAX_ROWS);
        Self {
            vt: Vt::builder()
                .size(cols as usize, rows as usize)
                .scrollback_limit(SCROLLBACK)
                .build(),
            carry: Vec::new(),
            alt: false,
            alt_tail: Vec::new(),
            cols,
            rows,
            resized_while_alt: false,
        }
    }

    /// Current alternate-screen state (0 = primary screen).
    pub fn alt_screen(&self) -> bool {
        self.alt
    }

    /// Fold any complete alt-screen sequences into `alt`. The whole buffer
    /// (tail + chunk) is scanned and matches apply in byte order; keeping
    /// the trailing 7 bytes as the next tail means a boundary-straddling
    /// sequence is re-seen (harmlessly — events are idempotent in order).
    fn track_alt(&mut self, bytes: &[u8]) {
        let mut buf = std::mem::take(&mut self.alt_tail);
        buf.extend_from_slice(bytes);
        let mut events: Vec<(usize, bool)> = Vec::new();
        for (seq, on) in ALT_SEQS {
            let mut pos = 0;
            while let Some(i) = buf[pos..]
                .windows(seq.len())
                .position(|w| w == seq)
                .map(|x| x + pos)
            {
                events.push((i, on));
                pos = i + 1;
            }
        }
        events.sort_unstable_by_key(|e| e.0);
        for (_, on) in events {
            self.alt = on;
        }
        let keep = buf.len().saturating_sub(ALT_CARRY);
        self.alt_tail = buf[keep..].to_vec();
    }

    /// Feed raw pty output. Invalid bytes become U+FFFD; an incomplete trailing
    /// multibyte sequence is carried into the next feed.
    pub fn feed(&mut self, bytes: &[u8]) {
        let was_alt = self.alt;
        self.track_alt(bytes);
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
        // Back on primary after an alt-stint resize: reflow the buffer avt
        // never resized (its primary kept the old width all along).
        if was_alt && !self.alt && self.resized_while_alt {
            self.resized_while_alt = false;
            self.vt
                .resize(self.cols.max(1) as usize, self.rows.max(1) as usize);
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.clamp(1, MAX_COLS);
        let rows = rows.clamp(1, MAX_ROWS);
        self.cols = cols;
        self.rows = rows;
        self.resized_while_alt |= self.alt;
        self.vt.resize(cols as usize, rows as usize);
    }

    /// Escape bytes that reproduce the pane's terminal state on a fresh (or
    /// reset) terminal: styled scrollback history first (it lands in the
    /// client's own scrollback), then avt's full state dump (visible grid,
    /// colors, cursor, alternate screen, modes). The prefix backs out of any
    /// stale client state, so this is also safe mid-stream (lossless resync).
    pub fn snapshot(&self) -> Vec<u8> {
        // avt's dump emits truecolor SGR in colon sub-param form, which
        // xterm.js misparses (RGB shifts to G,B,0) — normalize first (#38).
        let dump = normalize_dump_truecolor(&self.vt.dump());
        let mut out = Vec::new();
        // Back out of either alt-screen flavor (avt's dump uses 1047+DECSC),
        // and of any stale client modes: origin mode (DECOM) and a custom
        // scroll region (DECSTBM) survive `?1049l` on xterm, and a long-lived
        // client reseeding into one would get every CUP clamped/offset by it.
        out.extend_from_slice(b"\x1b[?1049l\x1b[?1047l\x1b[?6l\x1b[r\x1b[0m\x1b[2J\x1b[H");

        // Snapshot byte budget for the styled history replay: a dense
        // truecolor backlog can exceed the 8 MiB frame cap on the ptyd
        // connection and kill the whole native engine for one read error.
        // Newest lines win; the rest stays in the raw history log.
        const HISTORY_BUDGET: usize = 4 * 1024 * 1024;

        // avt's dump covers the screen(s) only; replay the primary buffer's
        // scrolled-off lines ourselves. `lines()` covers only the active
        // VISIBLE page in alt-screen mode (avt 0.18 keeps no alt scrollback),
        // so an alt-screen pane (kimi code & friends) reconnects to just its
        // current page — the TUI session's earlier output is only in the raw
        // ~/.local/state/mymux/history log. Say so, visibly, right over the
        // current page instead of "silently losing" the session.
        if ends_in_alt(&dump) {
            out.extend_from_slice(
                "\x1b[90m┄┄ mymux: alt-screen panes restore only this page — older TUI history lives in the raw log (⇧ older output / termhist) ┄┄\x1b[0m\r\n"
                    .as_bytes(),
            );
            // SU (scroll up): pushes the hint INTO the reconnecting client's
            // scrollback, above the live alt page — visible on demand instead
            // of stealing a row of the user's live frame.
            out.extend_from_slice(b"\x1b[S");
        } else {
            let (_, rows) = self.vt.size();
            let lines: Vec<&Line> = self.vt.lines().collect();
            if lines.len() > rows {
                let hist = &lines[..lines.len() - rows];
                let mut acc: Vec<String> = Vec::new();
                let mut total = 0usize;
                for line in hist.iter().rev() {
                    let s = styled_line(line);
                    total += s.len() + 2;
                    if total > HISTORY_BUDGET && !acc.is_empty() {
                        break;
                    }
                    acc.push(s);
                }
                for s in acc.iter().rev() {
                    out.extend_from_slice(s.as_bytes());
                    out.extend_from_slice(b"\r\n");
                }
                // Push the replayed lines still sitting in the client's
                // VISIBLE region into its scrollback before painting the
                // dump — the `\x1b[2J` here used to erase them instead, so
                // every reseed ate the ≈rows newest history lines (#39).
                // After replaying n lines from home, min(n, rows-1) remain
                // visible (the cursor's own row is blank).
                let leftover = acc.len().min(rows.saturating_sub(1));
                if leftover > 0 {
                    out.extend_from_slice(format!("\x1b[{leftover}S").as_bytes());
                }
                out.extend_from_slice(b"\x1b[0m\x1b[H");
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

/// avt's dump emits truecolor SGR in ITU colon sub-parameter form
/// (`38:2:R:G:B`, no colorspace slot); xterm.js reserves the 3rd colon field
/// for a colorspace id and so parses it as RGB=(G,B,0) — the green→orange
/// shift on every reseed (#38). Rewrite those runs to the universally
/// unambiguous semicolon form (`38;2;R;G;B`). Only SGR sequences are
/// touched: any other colon bytes pass through verbatim.
fn normalize_dump_truecolor(dump: &str) -> String {
    if !dump.contains(':') {
        return dump.to_owned();
    }
    let mut out = String::with_capacity(dump.len());
    let mut rest = dump;
    while let Some(i) = rest.find("\x1b[") {
        out.push_str(&rest[..i]);
        let csi = &rest[i + 2..];
        // A CSI ends at its final byte (0x40..=0x7E); param bytes (incl.
        // ':' and '?') come before it.
        let Some(fin) = csi.find(|c: char| ('\u{40}'..='\u{7e}').contains(&c)) else {
            out.push_str(&rest[i..]); // unterminated tail: verbatim
            return out;
        };
        if csi.as_bytes()[fin] == b'm' {
            out.push_str("\x1b[");
            out.push_str(&normalize_sgr_params(&csi[..fin]));
            out.push('m');
        } else {
            out.push_str(&rest[i..i + 2 + fin + 1]);
        }
        rest = &csi[fin + 1..];
    }
    out.push_str(rest);
    out
}

/// One SGR parameter list with `38:2:R:G:B` / `48:2:...` / `58:2:...` runs
/// (with or without the empty colorspace slot, `38:2::R:G:B`) rewritten to
/// semicolon form. Indexed `38:5:N` is unambiguous in xterm.js and stays;
/// non-color colon params (e.g. `4:3` curly underline) stay too.
fn normalize_sgr_params(params: &str) -> String {
    let mut out = String::with_capacity(params.len());
    for (i, p) in params.split(';').enumerate() {
        if i > 0 {
            out.push(';');
        }
        let sub: Vec<&str> = p.split(':').collect();
        let (head, rgb) = match sub.as_slice() {
            [h, "2", r, g, b] | [h, "2", "", r, g, b] => (*h, [*r, *g, *b]),
            _ => ("", ["", "", ""]),
        };
        let truecolor = matches!(head, "38" | "48" | "58")
            && rgb
                .iter()
                .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if truecolor {
            out.push_str(head);
            out.push_str(";2;");
            out.push_str(&rgb.join(";"));
        } else {
            out.push_str(p);
        }
    }
    out
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
        // Wide-char TAIL cells are occupancy placeholders (width 0, char ' '):
        // emitting them as real spaces breaks grapheme adjacency (👌🏻 comes
        // apart) and shifts every wide char by one column — replayed "你好"
        // used to come back as "你 好 ". Skip them.
        if cell.width() == 0 {
            continue;
        }
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
        // Source content must all still be there; the hint adds a scrollback
        // line on top of it instead of clobbering anything.
        assert!(
            vt2.text().iter().any(|l| l.contains("shell prompt $")),
            "source primary content lost: {:?}",
            vt2.text()
        );
        assert!(
            vt2.text().iter().any(|l| l.contains("termhist")),
            "hint missing from snapshot: {}",
            vt2.text().iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
        );
        // Note: we no longer assert dump() byte-equality HERE — that was a
        // roundtrip-identical contract which the alt-pane hint now breaks
        // INTENTIONALLY (the reconnecting client gains one hint line in
        // scrollback that the source pane never had to keep). This test's
        // real contract: visible frame identical, source content preserved,
        // hint appended on top, cursor preserved. Colors roundtrip equality
        // stays asserted above (no hint involved there).
        assert_eq!(vt2.cursor(), g.vt.cursor());

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
    fn alt_screen_tracked_across_chunk_splits() {
        let mut g = PaneGrid::new(40, 10);
        assert!(!g.alt_screen());
        // A sequence split at every plausible boundary is one event.
        g.feed(b"\x1b[?1");
        assert!(!g.alt_screen());
        g.feed(b"049h");
        assert!(g.alt_screen());
        // Later sequences win in byte order, even packed into one chunk.
        g.feed(b"noise \x1b[?1049l tail \x1b[?1047h");
        assert!(g.alt_screen());
        g.feed(b"\x1b[?1047l");
        assert!(!g.alt_screen());
        // No tail remains to trip a later feed.
        g.feed(b"plain text");
        assert!(!g.alt_screen());
    }

    #[test]
    fn dec_1048_is_cursor_save_not_alt_screen() {
        // C-30: DEC 1048 only saves/restores the cursor; it does NOT switch
        // buffers (that's 1047/1049). Tracking it as alt fed false state to
        // the UI alt indicator and the agent heuristics.
        let mut g = PaneGrid::new(40, 10);
        g.feed(b"\x1b[?1048h");
        assert!(!g.alt_screen());
        g.feed(b"\x1b[?1048l");
        assert!(!g.alt_screen());
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
    fn snapshot_replayed_history_stays_contiguous_into_live() {
        // #39: the reseed used to `\x1b[2J`-erase the ≈rows newest replayed
        // history lines still sitting in the client's visible region instead
        // of scrolling them into its scrollback — a 30×4 grid with L00..L11
        // lost L06..L08 (the band just above the live page) on every switch.
        let mut g = PaneGrid::new(30, 4);
        for i in 0..12 {
            g.feed(format!("L{i:02}\r\n").as_bytes());
        }
        let vt2 = replay(&g, 30, 4);
        let all: Vec<String> = vt2
            .lines()
            .map(|l| l.text().trim_end().to_string())
            .collect();
        let start = all
            .iter()
            .position(|l| l == "L00")
            .unwrap_or_else(|| panic!("L00 missing: {all:?}"));
        for i in 0..12 {
            assert_eq!(
                all.get(start + i).map(String::as_str),
                Some(format!("L{i:02}").as_str()),
                "history/live sequence broke at L{i:02}: {all:?}"
            );
        }
    }

    #[test]
    fn snapshot_normalizes_truecolor_to_semicolon_form() {
        // #38: avt's dump emits truecolor SGR as colon sub-params
        // (`38:2:R:G:B`); xterm.js reads the 3rd colon field as a colorspace
        // id and shifts RGB→(G,B,0). The snapshot must carry the semicolon
        // form and no colon-truecolor runs.
        let mut g = PaneGrid::new(40, 10);
        g.feed(b"\x1b[38;2;10;200;30mgreen\x1b[0m \x1b[48;2;1;2;3mbg\x1b[0m");
        let snap = String::from_utf8(g.snapshot()).unwrap();
        assert!(snap.contains("38;2;10;200;30"), "{snap:?}");
        assert!(snap.contains("48;2;1;2;3"), "{snap:?}");
        assert!(!snap.contains("38:2:"), "{snap:?}");
        assert!(!snap.contains("48:2:"), "{snap:?}");
        assert!(!snap.contains("58:2:"), "{snap:?}");
        // The colors must survive a round trip through avt unchanged.
        let vt2 = replay(&g, 40, 10);
        assert_eq!(vt2.dump(), g.vt.dump());
    }

    #[test]
    fn truecolor_normalizer_rewrites_only_sgr_color_runs() {
        let n = normalize_dump_truecolor;
        assert_eq!(n("\x1b[0;38:2:10:200:30m"), "\x1b[0;38;2;10;200;30m");
        // With the empty colorspace slot the RGB triple is kept as-is.
        assert_eq!(n("\x1b[38:2::1:2:3m"), "\x1b[38;2;1;2;3m");
        assert_eq!(n("\x1b[58:2:1:2:3m"), "\x1b[58;2;1;2;3m");
        // Indexed colon form is unambiguous for xterm.js — untouched.
        assert_eq!(n("\x1b[38:5:196m"), "\x1b[38:5:196m");
        // Non-color colon params (curly underline) stay.
        assert_eq!(n("\x1b[48:2:1:2:3;4:3m"), "\x1b[48;2;1;2;3;4:3m");
        // Non-SGR sequences and plain text pass through.
        assert_eq!(
            n("\x1b[?1049h\x1b[38:2:9:9:9mX"),
            "\x1b[?1049h\x1b[38;2;9;9;9mX"
        );
        assert_eq!(n("plain 38:2:1:2:3 text"), "plain 38:2:1:2:3 text");
        // Unterminated CSI tail: verbatim, no panic.
        assert_eq!(n("tail \x1b[38:2:1:2"), "tail \x1b[38:2:1:2");
    }

    #[test]
    fn pane_size_is_clamped() {
        // #4: an unclamped 65535² would allocate ~137 GB in avt and
        // OOM-abort ptyd, killing every shell it holds.
        let mut g = PaneGrid::new(65535, 65535);
        assert_eq!(g.vt.size(), (MAX_COLS as usize, MAX_ROWS as usize));
        g.resize(0, 65535);
        assert_eq!(g.vt.size(), (1, MAX_ROWS as usize));
        g.feed(b"still alive");
        assert!(g.vt.text().join("\n").contains("still alive"));
    }

    #[test]
    fn wide_chars_replay_without_tail_spaces() {
        // Wide-char tail cells must not leak into the replay as literal
        // spaces: history "你好一" used to come back "你 好 一 " (shifted by
        // one column per wide char, and breaking grapheme adjacency).
        let mut g = PaneGrid::new(20, 3);
        for i in 1..=8 {
            g.feed(format!("你好{i}abc\r\n").as_bytes());
        }
        let snap = String::from_utf8(g.snapshot()).unwrap();
        assert!(snap.contains("你好1abc"), "{snap:?}");
        assert!(!snap.contains("你 好"), "{snap:?}");
        let vt2 = replay(&g, 20, 3);
        let whole = vt2.lines().map(|l| l.text()).collect::<Vec<_>>().join("\n");
        assert!(whole.contains("你好1abc"), "{whole}");
        assert!(!whole.contains("你 好"), "{whole}");
    }

    #[test]
    fn resize_in_alt_reflows_primary_on_exit() {
        // Shrink while a TUI owns the alt screen: avt reflows only the ACTIVE
        // (alt) buffer. On exit the primary must be reflowed by us — else the
        // next snapshot dumps stale-width rows (wrap-junk everywhere).
        let mut g = PaneGrid::new(40, 5);
        g.feed(b"primary-one\r\nprimary-two\r\n");
        g.feed(b"\x1b[?1049h\x1b[2J\x1b[HALTMARK");
        g.resize(20, 5);
        g.feed(b"\x1b[?1049l");
        assert!(!g.resized_while_alt, "flip consumed the flag");
        let vt2 = replay(&g, 20, 5);
        let view = |vt: &Vt| vt.view().map(|l| l.text()).collect::<Vec<_>>();
        assert_eq!(view(&vt2), view(&g.vt));
        let all = vt2.lines().map(|l| l.text()).collect::<Vec<_>>().join("\n");
        assert!(all.contains("primary-one"), "{all}");
        assert!(all.contains("primary-two"), "{all}");
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

#[cfg(test)]
mod alt_probe_repro {
    use super::*;

    /// The user's report: after an app relaunch, an alt-screen pane shows only
    /// its current page. AVT (0.18) structurally KEEPS NO ALT-BUFFER
    /// SCROLLBACK — that engine just doesn't retain TUI history above the
    /// visible page (lines()==visible rows only, probe-proven). The snapshot
    /// therefore cannot replay an alt session past; what we CAN do is tell
    /// the user *where* the history actually lives (ptyd's raw log), so the
    /// "history vanished" experience turns into a pointing hint instead of a
    /// silent cut. Shell (primary) history replay is unchanged and covered by
    /// the pre-existing snapshot tests.
    #[test]
    fn alt_screen_scrolling_has_no_scrollback_by_engine_design() {
        let mut g = PaneGrid::new(40, 5);
        g.feed(b"shell-one\r\nshell-two\r\nshell-three\r\n\x1b[?1049h");
        for i in 1..=12u32 {
            g.feed(format!("alt-line-{i:02}\r\n").as_bytes());
        }
        let lines: Vec<_> = g.vt.lines().collect();
        // Probe-proven in alt mode: lines() IS the visible page only — this is
        // an avt property, not a snapshot bug; see also grid.rs's comment ref.
        assert_eq!(lines.len(), 5);
        let whole_view = lines.iter().map(|l| l.text()).collect::<Vec<_>>().join("\n");
        // Early lines are GONE from the visible page (no alt scrollback
        // exists) — this is the user-visible truncation, web-engine-fatted.
        assert!(!whole_view.contains("alt-line-08"));
        assert!(whole_view.contains("alt-line-12"), "view:\n{whole_view}");

        let snap = String::from_utf8(g.snapshot()).unwrap();
        assert!(
            snap.contains("termhist") && snap.contains("older output"),
            "snapshot should carry the pointer hint for alt panes:\n{}",
            &snap[..snap.len().min(400)]
        );
        // and it must NOT fabricate alt history: no replayed alt-line-08 above.
        assert!(!snap.contains("\x1b[96malt-line-08"));
    }
}
