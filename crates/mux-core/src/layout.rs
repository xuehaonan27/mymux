//! Parser for tmux pane-layout strings, e.g.
//! `6b8b,100x30,0,0{50x30,0,0,0,49x30,51,0,1}`.
//!
//! Grammar (after the leading 4-hex-digit checksum):
//! ```text
//! cell  := W 'x' H ',' X ',' Y ( ',' paneid          // leaf
//!                              | '{' cell (',' cell)* '}'   // left/right split (columns)
//!                              | '[' cell (',' cell)* ']' ) // top/bottom split (rows)
//! ```

use crate::PaneId;

/// A fully parsed window layout: a geometry tree plus tmux's checksum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub checksum: u16,
    pub root: LayoutCell,
}

/// One node of the layout tree. Coordinates and sizes are in terminal cells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutCell {
    pub w: u16,
    pub h: u16,
    pub x: u16,
    pub y: u16,
    pub kind: CellKind,
}

/// Whether a cell is a single pane or a split containing child cells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CellKind {
    /// A single pane.
    Leaf(PaneId),
    /// Children arranged left-to-right (`{}` in tmux).
    Cols(Vec<LayoutCell>),
    /// Children arranged top-to-bottom (`[]` in tmux).
    Rows(Vec<LayoutCell>),
}

impl LayoutCell {
    /// Visit every leaf pane in the tree, in layout order.
    pub fn for_each_pane(&self, f: &mut impl FnMut(PaneId, &LayoutCell)) {
        match &self.kind {
            CellKind::Leaf(id) => f(*id, self),
            CellKind::Cols(children) | CellKind::Rows(children) => {
                for c in children {
                    c.for_each_pane(f);
                }
            }
        }
    }
}

struct Cur<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cur<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn try_eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, c: u8) -> Option<()> {
        self.try_eat(c).then_some(())
    }
    fn num(&mut self) -> Option<u32> {
        let start = self.i;
        while matches!(self.peek(), Some(d) if d.is_ascii_digit()) {
            self.i += 1;
        }
        if self.i == start {
            return None;
        }
        std::str::from_utf8(&self.b[start..self.i])
            .ok()?
            .parse()
            .ok()
    }
}

fn parse_cell(c: &mut Cur) -> Option<LayoutCell> {
    let w = c.num()?;
    c.expect(b'x')?;
    let h = c.num()?;
    c.expect(b',')?;
    let x = c.num()?;
    c.expect(b',')?;
    let y = c.num()?;

    let kind = match c.peek() {
        Some(b'{') => {
            c.i += 1;
            let children = parse_children(c, b'}')?;
            CellKind::Cols(children)
        }
        Some(b'[') => {
            c.i += 1;
            let children = parse_children(c, b']')?;
            CellKind::Rows(children)
        }
        Some(b',') => {
            c.i += 1;
            CellKind::Leaf(PaneId(c.num()?))
        }
        _ => return None,
    };

    Some(LayoutCell {
        w: w as u16,
        h: h as u16,
        x: x as u16,
        y: y as u16,
        kind,
    })
}

fn parse_children(c: &mut Cur, close: u8) -> Option<Vec<LayoutCell>> {
    let mut children = vec![parse_cell(c)?];
    while c.try_eat(b',') {
        children.push(parse_cell(c)?);
    }
    c.expect(close)?;
    Some(children)
}

/// Parse a full layout string (checksum + tree). Returns `None` on malformed
/// input rather than panicking — callers keep the last good layout.
pub fn parse_layout(s: &str) -> Option<Layout> {
    let (cs, rest) = s.split_once(',')?;
    let checksum = u16::from_str_radix(cs, 16).ok()?;
    let mut c = Cur {
        b: rest.as_bytes(),
        i: 0,
    };
    let root = parse_cell(&mut c)?;
    Some(Layout { checksum, root })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_pane() {
        let l = parse_layout("b25f,80x24,0,0,2").unwrap();
        assert_eq!(l.checksum, 0xb25f);
        assert_eq!((l.root.w, l.root.h, l.root.x, l.root.y), (80, 24, 0, 0));
        assert_eq!(l.root.kind, CellKind::Leaf(PaneId(2)));
    }

    #[test]
    fn horizontal_split_two_columns() {
        let l = parse_layout("6b8b,100x30,0,0{50x30,0,0,0,49x30,51,0,1}").unwrap();
        match &l.root.kind {
            CellKind::Cols(v) => {
                assert_eq!(v.len(), 2);
                assert_eq!(v[0].kind, CellKind::Leaf(PaneId(0)));
                assert_eq!((v[0].w, v[0].x), (50, 0));
                assert_eq!(v[1].kind, CellKind::Leaf(PaneId(1)));
                assert_eq!((v[1].w, v[1].x), (49, 51));
            }
            other => panic!("expected columns, got {other:?}"),
        }
    }

    #[test]
    fn nested_split() {
        // left column is a single pane; right column is split top/bottom.
        let l = parse_layout("aaaa,100x30,0,0{50x30,0,0,0,49x30,51,0[49x15,51,0,1,49x14,51,16,2]}")
            .unwrap();
        let mut panes = Vec::new();
        l.root.for_each_pane(&mut |id, _| panes.push(id));
        assert_eq!(panes, vec![PaneId(0), PaneId(1), PaneId(2)]);
    }

    #[test]
    fn malformed_returns_none() {
        assert!(parse_layout("not-a-layout").is_none());
        assert!(parse_layout("6b8b,100x30,0").is_none());
    }
}
