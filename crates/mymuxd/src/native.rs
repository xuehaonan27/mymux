//! Layout trees for native persistent windows: grouping ptyd panes into
//! windows with splits, tmux-free.
//!
//! mymuxd owns all layout SEMANTICS (split geometry, collapse, navigation);
//! ptyd only stores the serialized blob (`SetMeta`/`GetMeta`) so the layout
//! shares fate with the panes it describes — a ptyd restart wipes both.
//!
//! Geometry model: same cell-coordinate tree as tmux layouts (`LayoutCell`),
//! but without separator columns — children tile the parent rect exactly.
//! The UI positions panes proportionally, so this needs no frontend change.

use std::collections::BTreeMap;

use mux_core::{CellKind, LayoutCell, PaneId};
use serde::{Deserialize, Serialize};

/// One native window: a layout tree over ptyd panes. `id` is the first pane's
/// id at creation and never changes (pane ids are monotonic, so a live window
/// can't collide with a reissued pane id).
pub struct NativeWindow {
    pub id: u32,
    pub name: String,
    pub active_pane: u32,
    pub root: LayoutCell,
    /// Temporarily maximized pane (tmux zoom). Cleared by any layout change.
    pub zoomed: Option<u32>,
}

/// What removing a pane did to its window.
pub enum Remove {
    /// Pane wasn't in any window.
    None,
    /// The window's last pane: the window is gone.
    WindowGone(u32),
    /// The tree collapsed around the hole; these panes need backend resizes.
    Collapsed {
        /// Which window collapsed (tests assert it; the daemon repaints globally).
        #[allow(dead_code)]
        win: u32,
        resizes: Vec<(u32, u16, u16)>,
    },
}

#[derive(Default)]
pub struct NativeWindows {
    wins: BTreeMap<u32, NativeWindow>,
}

fn leaf(pane: u32, x: u16, y: u16, w: u16, h: u16) -> LayoutCell {
    LayoutCell {
        w,
        h,
        x,
        y,
        kind: CellKind::Leaf(PaneId(pane)),
    }
}

/// Split a length: the existing pane keeps the first (larger on odd) half.
fn halves(len: u16) -> (u16, u16) {
    let second = len / 2;
    (len - second, second)
}

fn leaves_of(root: &LayoutCell) -> Vec<(u32, LayoutCell)> {
    let mut v = Vec::new();
    root.for_each_pane(&mut |p, cell| v.push((p.0, cell.clone())));
    v
}

/// Re-assign `cell` (and its subtree) to the given rect, distributing space
/// among children proportionally to their previous sizes; the last child
/// absorbs rounding remainders so children always tile the rect exactly.
fn scale_to(cell: &mut LayoutCell, x: u16, y: u16, w: u16, h: u16) {
    cell.x = x;
    cell.y = y;
    cell.w = w;
    cell.h = h;
    let (cols, children) = match &mut cell.kind {
        CellKind::Leaf(_) => return,
        CellKind::Cols(c) => (true, c),
        CellKind::Rows(c) => (false, c),
    };
    let total = w_or_h_sum(children, cols).max(1);
    let space = if cols { w } else { h };
    let n = children.len();
    let mut off = if cols { x } else { y };
    let mut remaining = space;
    for (i, c) in children.iter_mut().enumerate() {
        let old = if cols { c.w } else { c.h } as u32;
        let share = if i == n - 1 {
            remaining
        } else {
            let ideal = ((old * space as u32 + total / 2) / total) as u16;
            let others = (n - 1 - i) as u16; // at least 1 cell for each sibling after us
            ideal.clamp(1, remaining.saturating_sub(others).max(1))
        };
        if cols {
            scale_to(c, off, y, share, h);
        } else {
            scale_to(c, x, off, w, share);
        }
        off = off.saturating_add(share);
        remaining = remaining.saturating_sub(share);
    }
}

fn w_or_h_sum(children: &[LayoutCell], cols: bool) -> u32 {
    children
        .iter()
        .map(|c| if cols { c.w as u32 } else { c.h as u32 })
        .sum()
}

/// Replace the target leaf with a split of [old, new]. When the enclosing
/// container already runs in the same direction, splice instead of nesting
/// (tmux-style flattening).
fn split_leaf(cell: &mut LayoutCell, target: u32, horizontal: bool, new_pane: u32) -> bool {
    if matches!(&cell.kind, CellKind::Leaf(p) if p.0 == target) {
        let (x, y, w, h) = (cell.x, cell.y, cell.w, cell.h);
        if horizontal {
            let (ow, nw) = halves(w);
            cell.kind = CellKind::Cols(vec![
                leaf(target, x, y, ow, h),
                leaf(new_pane, x + ow, y, nw, h),
            ]);
        } else {
            let (oh, nh) = halves(h);
            cell.kind = CellKind::Rows(vec![
                leaf(target, x, y, w, oh),
                leaf(new_pane, x, y + oh, w, nh),
            ]);
        }
        return true;
    }
    let (cols, children) = match &mut cell.kind {
        CellKind::Leaf(_) => return false,
        CellKind::Cols(c) => (true, c),
        CellKind::Rows(c) => (false, c),
    };
    let same_dir = cols == horizontal;
    if same_dir {
        if let Some(i) = children
            .iter()
            .position(|c| matches!(&c.kind, CellKind::Leaf(p) if p.0 == target))
        {
            let (x, y, w, h) = {
                let c = &children[i];
                (c.x, c.y, c.w, c.h)
            };
            let (old_cell, new_cell) = if horizontal {
                let (ow, nw) = halves(w);
                (leaf(target, x, y, ow, h), leaf(new_pane, x + ow, y, nw, h))
            } else {
                let (oh, nh) = halves(h);
                (leaf(target, x, y, w, oh), leaf(new_pane, x, y + oh, w, nh))
            };
            children[i] = old_cell;
            children.insert(i + 1, new_cell);
            return true;
        }
    }
    for c in children {
        if split_leaf(c, target, horizontal, new_pane) {
            return true;
        }
    }
    false
}

/// Remove the target leaf; hoist a lone sibling; rescale the container to
/// fill the freed space. Returns whether the leaf was found here.
fn remove_leaf(cell: &mut LayoutCell, target: u32) -> bool {
    let children = match &mut cell.kind {
        CellKind::Leaf(_) => return false,
        CellKind::Cols(c) | CellKind::Rows(c) => c,
    };
    if let Some(i) = children
        .iter()
        .position(|c| matches!(&c.kind, CellKind::Leaf(p) if p.0 == target))
    {
        children.remove(i);
        if children.len() == 1 {
            cell.kind = children.remove(0).kind;
        }
        let (x, y, w, h) = (cell.x, cell.y, cell.w, cell.h);
        scale_to(cell, x, y, w, h);
        return true;
    }
    children.iter_mut().any(|c| remove_leaf(c, target))
}

impl NativeWindows {
    pub fn clear(&mut self) {
        self.wins.clear();
    }

    /// Create a single-pane window (window id == pane id).
    pub fn add_single(&mut self, pane: u32, name: String, cols: u16, rows: u16) {
        self.wins.insert(
            pane,
            NativeWindow {
                id: pane,
                name,
                active_pane: pane,
                root: leaf(pane, 0, 0, cols.max(1), rows.max(1)),
                zoomed: None,
            },
        );
    }

    pub fn contains_window(&self, id: u32) -> bool {
        self.wins.contains_key(&id)
    }

    pub fn window_of(&self, pane: u32) -> Option<u32> {
        self.wins.values().find_map(|w| {
            leaves_of(&w.root)
                .iter()
                .any(|(p, _)| *p == pane)
                .then_some(w.id)
        })
    }

    /// `(window id, name, member panes)` per window, for the state snapshot.
    pub fn tabs(&self) -> Vec<(u32, String, Vec<u32>)> {
        self.wins
            .values()
            .map(|w| {
                (
                    w.id,
                    w.name.clone(),
                    leaves_of(&w.root).into_iter().map(|(p, _)| p).collect(),
                )
            })
            .collect()
    }

    pub fn panes_of(&self, win: u32) -> Vec<u32> {
        self.wins
            .get(&win)
            .map(|w| leaves_of(&w.root).into_iter().map(|(p, _)| p).collect())
            .unwrap_or_default()
    }

    pub fn layout_of(&self, win: u32) -> Option<LayoutCell> {
        self.wins.get(&win).map(|w| w.root.clone())
    }

    pub fn active_pane_of(&self, win: u32) -> Option<u32> {
        self.wins.get(&win).map(|w| w.active_pane)
    }

    pub fn zoomed_of(&self, win: u32) -> Option<u32> {
        self.wins.get(&win).and_then(|w| w.zoomed)
    }

    /// The panes the UI can currently see: the zoomed pane alone, else all.
    pub fn visible_panes_of(&self, win: u32) -> Vec<u32> {
        match self.zoomed_of(win) {
            Some(z) => vec![z],
            None => self.panes_of(win),
        }
    }

    /// Toggle zoom on a member pane; `Some(now_zoomed)` if the pane exists.
    pub fn toggle_zoom(&mut self, pane: u32) -> Option<bool> {
        let win = self.window_of(pane)?;
        let w = self.wins.get_mut(&win)?;
        w.zoomed = if w.zoomed == Some(pane) {
            None
        } else {
            Some(pane)
        };
        Some(w.zoomed.is_some())
    }

    /// Drop any zoom on the window; returns the tree's pane sizes to restore
    /// (the zoomed pane had been resized to the full view).
    pub fn clear_zoom(&mut self, win: u32) -> Option<Vec<(u32, u16, u16)>> {
        let w = self.wins.get_mut(&win)?;
        w.zoomed.take()?;
        Some(
            leaves_of(&w.root)
                .into_iter()
                .map(|(p, c)| (p, c.w, c.h))
                .collect(),
        )
    }

    /// Swap a pane with its next/previous neighbour in layout order; the two
    /// shells trade rectangles, focus follows the moved pane. Returns the two
    /// panes' new sizes.
    pub fn swap(&mut self, pane: u32, next: bool) -> Option<Vec<(u32, u16, u16)>> {
        let win = self.window_of(pane)?;
        let w = self.wins.get_mut(&win)?;
        w.zoomed = None; // layout change
        let order: Vec<u32> = leaves_of(&w.root).into_iter().map(|(p, _)| p).collect();
        if order.len() < 2 {
            return None;
        }
        let i = order.iter().position(|&p| p == pane)?;
        let j = if next {
            (i + 1) % order.len()
        } else {
            (i + order.len() - 1) % order.len()
        };
        let other = order[j];
        swap_leaves(&mut w.root, pane, other);
        w.active_pane = pane;
        let sizes: Vec<(u32, u16, u16)> = leaves_of(&w.root)
            .into_iter()
            .filter(|(p, _)| *p == pane || *p == other)
            .map(|(p, c)| (p, c.w, c.h))
            .collect();
        Some(sizes)
    }

    /// Mark `pane` active within its window; `Some(window)` when it changed.
    pub fn set_active(&mut self, pane: u32) -> Option<u32> {
        let win = self.window_of(pane)?;
        let w = self.wins.get_mut(&win)?;
        if w.active_pane == pane {
            return None;
        }
        w.active_pane = pane;
        Some(win)
    }

    pub fn set_name(&mut self, win: u32, name: &str) -> bool {
        match self.wins.get_mut(&win) {
            Some(w) => {
                w.name = name.to_string();
                true
            }
            None => false,
        }
    }

    /// Sizes a split of `target` would produce: `((old_w,old_h),(new_w,new_h))`.
    /// `None` when the pane is unknown or too small to split.
    pub fn split_sizes(&self, target: u32, horizontal: bool) -> Option<((u16, u16), (u16, u16))> {
        let win = self.window_of(target)?;
        let (_, cell) = leaves_of(&self.wins.get(&win)?.root)
            .into_iter()
            .find(|(p, _)| *p == target)?;
        if horizontal {
            let (ow, nw) = halves(cell.w);
            (nw >= 2 && ow >= 2).then_some(((ow, cell.h), (nw, cell.h)))
        } else {
            let (oh, nh) = halves(cell.h);
            (nh >= 2 && oh >= 2).then_some(((cell.w, oh), (cell.w, nh)))
        }
    }

    /// Insert `new_pane` next to `target` (after spawning it at the size from
    /// [`split_sizes`]). The new pane becomes the window's active pane.
    pub fn split(&mut self, target: u32, horizontal: bool, new_pane: u32) -> bool {
        let Some(win) = self.window_of(target) else {
            return false;
        };
        let w = self
            .wins
            .get_mut(&win)
            .expect("window_of returned a live id");
        if !split_leaf(&mut w.root, target, horizontal, new_pane) {
            return false;
        }
        w.active_pane = new_pane;
        w.zoomed = None; // layout change
        true
    }

    pub fn remove_pane(&mut self, pane: u32) -> Remove {
        let Some(win) = self.window_of(pane) else {
            return Remove::None;
        };
        let w = self
            .wins
            .get_mut(&win)
            .expect("window_of returned a live id");
        if matches!(&w.root.kind, CellKind::Leaf(p) if p.0 == pane) {
            self.wins.remove(&win);
            return Remove::WindowGone(win);
        }
        remove_leaf(&mut w.root, pane);
        w.zoomed = None; // layout change
        let leaves = leaves_of(&w.root);
        if !leaves.iter().any(|(p, _)| *p == w.active_pane) {
            w.active_pane = leaves.first().map(|(p, _)| *p).unwrap_or(w.id);
        }
        Remove::Collapsed {
            win,
            resizes: leaves.into_iter().map(|(p, c)| (p, c.w, c.h)).collect(),
        }
    }

    /// Scale a window to a new total size; returns every pane's new size.
    pub fn resize_window(&mut self, win: u32, cols: u16, rows: u16) -> Vec<(u32, u16, u16)> {
        let Some(w) = self.wins.get_mut(&win) else {
            return Vec::new();
        };
        scale_to(&mut w.root, 0, 0, cols.max(2), rows.max(2));
        leaves_of(&w.root)
            .into_iter()
            .map(|(p, c)| (p, c.w, c.h))
            .collect()
    }

    /// Geometric pane navigation: nearest neighbour with edge overlap.
    pub fn nav(&self, win: u32, from: u32, dir: &str) -> Option<u32> {
        let w = self.wins.get(&win)?;
        let leaves = leaves_of(&w.root);
        let (_, cur) = leaves.iter().find(|(p, _)| *p == from)?;
        let overlap = |a1: u16, a2: u16, b1: u16, b2: u16| -> i32 {
            (a2.min(b2) as i32) - (a1.max(b1) as i32)
        };
        let mut best: Option<(i32, i32, u32)> = None; // (edge distance, -overlap, pane)
        for (p, c) in &leaves {
            if p == &from {
                continue;
            }
            let (dist, ov) = match dir {
                "L" if c.x + c.w <= cur.x => (
                    (cur.x - (c.x + c.w)) as i32,
                    overlap(c.y, c.y + c.h, cur.y, cur.y + cur.h),
                ),
                "R" if c.x >= cur.x + cur.w => (
                    (c.x - (cur.x + cur.w)) as i32,
                    overlap(c.y, c.y + c.h, cur.y, cur.y + cur.h),
                ),
                "U" if c.y + c.h <= cur.y => (
                    (cur.y - (c.y + c.h)) as i32,
                    overlap(c.x, c.x + c.w, cur.x, cur.x + cur.w),
                ),
                "D" if c.y >= cur.y + cur.h => (
                    (c.y - (cur.y + cur.h)) as i32,
                    overlap(c.x, c.x + c.w, cur.x, cur.x + cur.w),
                ),
                _ => continue,
            };
            if ov <= 0 {
                continue;
            }
            let key = (dist, -ov, *p);
            if best.map_or(true, |b| key < b) {
                best = Some(key);
            }
        }
        best.map(|(_, _, p)| p)
    }

    /// Rebuild from a ptyd `List` after (re)connect: drop layout leaves whose
    /// panes are gone, drop emptied windows, and wrap orphan live panes
    /// (`(id, name, cols, rows)`) into fresh single-pane windows.
    pub fn reconcile(&mut self, alive: &[(u32, String, u16, u16)]) {
        let alive_ids: Vec<u32> = alive.iter().map(|(id, ..)| *id).collect();
        let member_panes: Vec<u32> = self
            .wins
            .values()
            .flat_map(|w| leaves_of(&w.root))
            .map(|(p, _)| p)
            .collect();
        for p in member_panes {
            if !alive_ids.contains(&p) {
                self.remove_pane(p);
            }
        }
        for (id, name, cols, rows) in alive {
            if self.window_of(*id).is_none() {
                self.add_single(*id, name.clone(), *cols, *rows);
            }
        }
    }

    // ---- blob (de)serialization -------------------------------------------

    /// `order` is the Hub's global tab order (tmux + native ids) — persisted
    /// so a user's arrangement survives mymuxd restarts alongside the trees.
    pub fn to_blob(&self, order: &[u32]) -> String {
        let root = BlobRoot {
            v: 1,
            order: order.to_vec(),
            windows: self
                .wins
                .values()
                .map(|w| BlobWin {
                    id: w.id,
                    name: w.name.clone(),
                    active: w.active_pane,
                    zoomed: w.zoomed,
                    root: cell_to_blob(&w.root),
                })
                .collect(),
        };
        serde_json::to_string(&root).unwrap_or_else(|_| "{}".into())
    }

    /// Lenient: a missing/corrupt blob yields an empty set (reconcile then
    /// adopts every live pane as its own window).
    pub fn from_blob(s: &str) -> NativeWindows {
        let mut out = NativeWindows::default();
        let Ok(root) = serde_json::from_str::<BlobRoot>(s) else {
            return out;
        };
        for bw in root.windows {
            let Some(cell) = blob_to_cell(&bw.root) else {
                continue;
            };
            let leaves = leaves_of(&cell);
            if leaves.is_empty() {
                continue;
            }
            let member = |p: Option<u32>| p.filter(|p| leaves.iter().any(|(l, _)| l == p));
            let active = member(Some(bw.active)).unwrap_or(leaves[0].0);
            out.wins.insert(
                bw.id,
                NativeWindow {
                    id: bw.id,
                    name: bw.name,
                    active_pane: active,
                    zoomed: member(bw.zoomed),
                    root: cell,
                },
            );
        }
        out
    }

    /// The persisted tab order from a blob (empty on garbage — callers merge
    /// leniently anyway).
    pub fn blob_order(s: &str) -> Vec<u32> {
        serde_json::from_str::<BlobRoot>(s)
            .map(|r| r.order)
            .unwrap_or_default()
    }
}

/// Swap the pane ids of two leaves (rectangles stay put — the shells move).
fn swap_leaves(cell: &mut LayoutCell, a: u32, b: u32) {
    match &mut cell.kind {
        CellKind::Leaf(p) => {
            if p.0 == a {
                *p = PaneId(b);
            } else if p.0 == b {
                *p = PaneId(a);
            }
        }
        CellKind::Cols(children) | CellKind::Rows(children) => {
            for c in children {
                swap_leaves(c, a, b);
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
struct BlobRoot {
    v: u32,
    #[serde(default)]
    order: Vec<u32>,
    windows: Vec<BlobWin>,
}

#[derive(Serialize, Deserialize)]
struct BlobWin {
    id: u32,
    name: String,
    active: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    zoomed: Option<u32>,
    root: BlobCell,
}

#[derive(Serialize, Deserialize)]
struct BlobCell {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pane: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<String>, // "cols" | "rows"
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    children: Vec<BlobCell>,
}

fn cell_to_blob(c: &LayoutCell) -> BlobCell {
    let (pane, dir, children) = match &c.kind {
        CellKind::Leaf(p) => (Some(p.0), None, Vec::new()),
        CellKind::Cols(v) => (
            None,
            Some("cols".into()),
            v.iter().map(cell_to_blob).collect(),
        ),
        CellKind::Rows(v) => (
            None,
            Some("rows".into()),
            v.iter().map(cell_to_blob).collect(),
        ),
    };
    BlobCell {
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        pane,
        dir,
        children,
    }
}

fn blob_to_cell(b: &BlobCell) -> Option<LayoutCell> {
    let kind = match (&b.pane, b.dir.as_deref()) {
        (Some(p), _) => CellKind::Leaf(PaneId(*p)),
        (None, Some("cols")) => {
            CellKind::Cols(b.children.iter().map(blob_to_cell).collect::<Option<_>>()?)
        }
        (None, Some("rows")) => {
            CellKind::Rows(b.children.iter().map(blob_to_cell).collect::<Option<_>>()?)
        }
        _ => return None,
    };
    Some(LayoutCell {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const P1: u32 = (1 << 30) | 1;
    const P2: u32 = (1 << 30) | 2;
    const P3: u32 = (1 << 30) | 3;

    fn rects(nw: &NativeWindows, win: u32) -> BTreeMap<u32, (u16, u16, u16, u16)> {
        leaves_of(&nw.layout_of(win).unwrap())
            .into_iter()
            .map(|(p, c)| (p, (c.x, c.y, c.w, c.h)))
            .collect()
    }

    #[test]
    fn split_halves_the_leaf_and_focuses_the_new_pane() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 81, 24);
        let ((ow, oh), (nw2, nh)) = nw.split_sizes(P1, true).unwrap();
        assert_eq!((ow, oh, nw2, nh), (41, 24, 40, 24));
        assert!(nw.split(P1, true, P2));
        let r = rects(&nw, P1);
        assert_eq!(r[&P1], (0, 0, 41, 24));
        assert_eq!(r[&P2], (41, 0, 40, 24));
        assert_eq!(nw.active_pane_of(P1), Some(P2));
        assert_eq!(nw.window_of(P2), Some(P1));
    }

    #[test]
    fn same_direction_split_flattens_instead_of_nesting() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 90, 24);
        nw.split(P1, true, P2);
        nw.split(P2, true, P3);
        let root = nw.layout_of(P1).unwrap();
        match &root.kind {
            CellKind::Cols(c) => assert_eq!(c.len(), 3, "flattened into one Cols"),
            k => panic!("expected Cols, got {k:?}"),
        }
        // Children tile the width exactly.
        let r = rects(&nw, P1);
        let total: u16 = [P1, P2, P3].iter().map(|p| r[p].2).sum();
        assert_eq!(total, 90);
    }

    #[test]
    fn split_refuses_tiny_panes() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 3, 24);
        assert!(nw.split_sizes(P1, true).is_none());
        assert!(nw.split_sizes(P1, false).is_some()); // tall enough vertically
    }

    #[test]
    fn remove_collapses_and_reclaims_space() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2);
        nw.split(P2, false, P3);
        match nw.remove_pane(P3) {
            Remove::Collapsed { win, resizes } => {
                assert_eq!(win, P1);
                let m: BTreeMap<u32, (u16, u16)> =
                    resizes.into_iter().map(|(p, w, h)| (p, (w, h))).collect();
                assert_eq!(m[&P2], (40, 24), "P2 got P3's rows back");
            }
            _ => panic!("expected collapse"),
        }
        // Last pane out closes the window.
        assert!(matches!(nw.remove_pane(P2), Remove::Collapsed { .. }));
        assert!(matches!(nw.remove_pane(P1), Remove::WindowGone(w) if w == P1));
        assert!(!nw.contains_window(P1));
    }

    #[test]
    fn resize_scales_proportionally_and_tiles_exactly() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2);
        nw.split(P2, false, P3);
        let sizes = nw.resize_window(P1, 120, 40);
        let m: BTreeMap<u32, (u16, u16)> = sizes.into_iter().map(|(p, w, h)| (p, (w, h))).collect();
        assert_eq!(m[&P1].1, 40, "left column spans full height");
        assert_eq!(m[&P1].0 + m[&P2].0, 120, "columns tile the width");
        assert_eq!(m[&P2].1 + m[&P3].1, 40, "right rows tile the height");
        let r = rects(&nw, P1);
        assert_eq!(r[&P2].0, r[&P3].0, "right column x aligned");
    }

    #[test]
    fn nav_is_geometric() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2); // P1 | P2
        nw.split(P2, false, P3); // P2 over P3
        assert_eq!(nw.nav(P1, P1, "R"), Some(P2), "top-right is nearest");
        assert_eq!(nw.nav(P1, P2, "L"), Some(P1));
        assert_eq!(nw.nav(P1, P3, "L"), Some(P1));
        assert_eq!(nw.nav(P1, P2, "D"), Some(P3));
        assert_eq!(nw.nav(P1, P3, "U"), Some(P2));
        assert_eq!(nw.nav(P1, P1, "L"), None);
    }

    #[test]
    fn blob_roundtrip_preserves_tree_name_and_active() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, "work".into(), 80, 24);
        nw.split(P1, true, P2);
        nw.split(P2, false, P3);
        nw.set_active(P3);
        let back = NativeWindows::from_blob(&nw.to_blob(&[]));
        assert_eq!(back.tabs(), nw.tabs());
        assert_eq!(back.active_pane_of(P1), Some(P3));
        assert_eq!(rects(&back, P1), rects(&nw, P1));
    }

    #[test]
    fn from_blob_tolerates_garbage() {
        assert!(NativeWindows::from_blob("").tabs().is_empty());
        assert!(NativeWindows::from_blob("not json").tabs().is_empty());
        assert!(NativeWindows::from_blob(r#"{"v":1,"windows":[{"id":1,"name":"","active":1,"root":{"x":0,"y":0,"w":1,"h":1}}]}"#).tabs().is_empty(), "cell with neither pane nor dir is dropped");
    }

    #[test]
    fn reconcile_drops_dead_leaves_and_adopts_orphans() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2);
        // P2 died while we were away; P3 appeared out of band.
        nw.reconcile(&[(P1, "a".into(), 80, 24), (P3, "b".into(), 80, 24)]);
        assert_eq!(nw.panes_of(P1), vec![P1], "dead leaf dropped, window kept");
        let r = rects(&nw, P1);
        assert_eq!(r[&P1], (0, 0, 80, 24), "survivor reclaimed the full rect");
        assert_eq!(
            nw.window_of(P3),
            Some(P3),
            "orphan wrapped as its own window"
        );
        // A window whose every pane died disappears entirely.
        let mut nw2 = NativeWindows::default();
        nw2.add_single(P1, String::new(), 80, 24);
        nw2.reconcile(&[]);
        assert!(nw2.tabs().is_empty());
    }

    #[test]
    fn zoom_toggles_persists_and_clears_on_layout_change() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2);
        assert_eq!(nw.toggle_zoom(P2), Some(true));
        assert_eq!(nw.zoomed_of(P1), Some(P2));
        assert_eq!(nw.visible_panes_of(P1), vec![P2]);
        // Survives the blob roundtrip.
        let back = NativeWindows::from_blob(&nw.to_blob(&[]));
        assert_eq!(back.zoomed_of(P1), Some(P2));
        // clear_zoom returns the tree sizes to restore.
        let restore = nw.clear_zoom(P1).unwrap();
        assert_eq!(restore.len(), 2);
        assert_eq!(nw.zoomed_of(P1), None);
        assert!(nw.clear_zoom(P1).is_none(), "idempotent");
        // Any layout change drops an active zoom.
        nw.toggle_zoom(P1);
        nw.split(P2, false, P3);
        assert_eq!(nw.zoomed_of(P1), None, "split unzooms");
        // Toggle off works too.
        nw.toggle_zoom(P3);
        assert_eq!(nw.toggle_zoom(P3), Some(false));
    }

    #[test]
    fn swap_trades_rectangles_and_keeps_focus_on_the_moved_pane() {
        let mut nw = NativeWindows::default();
        nw.add_single(P1, String::new(), 80, 24);
        nw.split(P1, true, P2);
        nw.split(P2, false, P3);
        let before = rects(&nw, P1);
        let sizes = nw.swap(P1, true).unwrap();
        assert_eq!(sizes.len(), 2);
        let after = rects(&nw, P1);
        assert_eq!(after[&P1], before[&P2], "P1 took P2's rect");
        assert_eq!(after[&P2], before[&P1], "P2 took P1's rect");
        assert_eq!(nw.active_pane_of(P1), Some(P1), "focus follows the shell");
        // prev wraps around the layout order.
        let order_first = leaves_of(&nw.layout_of(P1).unwrap())[0].0;
        nw.swap(order_first, false); // swaps with the last leaf, no panic
                                     // Single-pane windows can't swap.
        let mut solo = NativeWindows::default();
        solo.add_single(P1, String::new(), 80, 24);
        assert!(solo.swap(P1, true).is_none());
    }
}
