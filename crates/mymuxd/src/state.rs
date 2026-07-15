//! Serialization of the [`mux_core::Model`] into the JSON state snapshot the UI
//! consumes. Lives here (not in `mux-core`) so the core stays dependency-free.

use std::collections::BTreeMap;

use mux_core::{CellKind, LayoutCell, Model};
use serde::Serialize;

use crate::agent::AgentState;

#[derive(Serialize)]
struct StateMsg {
    t: &'static str,
    active_window: Option<u32>,
    active_pane: Option<u32>,
    windows: Vec<WinMsg>,
    layout: Option<LayoutMsg>,
    /// True while the active native window has a zoomed (maximized) pane.
    #[serde(skip_serializing_if = "is_false")]
    zoomed: bool,
}

/// `skip_serializing_if` helper: omit a bool when it's false.
fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Serialize)]
struct WinMsg {
    id: u32,
    name: String,
    active: bool,
    /// Aggregated agent state of the window's panes, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'static str>,
    /// The pane holding that agent state (attention jumps focus it directly).
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_pane: Option<u32>,
    /// When the window first became attention-worthy (epoch ms) — the
    /// attention queue's authoritative ordering.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_since: Option<u64>,
    /// True for a mymuxd-native ephemeral (raw shell) tab.
    #[serde(skip_serializing_if = "is_false")]
    ephemeral: bool,
    /// True for a ptyd-held persistent native tab (survives mymuxd restarts).
    #[serde(skip_serializing_if = "is_false")]
    persistent: bool,
}

/// The layout tree, mirroring `mux_core::LayoutCell` for the UI.
#[derive(Serialize)]
struct LayoutMsg {
    kind: &'static str, // "leaf" | "cols" | "rows"
    #[serde(skip_serializing_if = "Option::is_none")]
    pane: Option<u32>,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<LayoutMsg>,
}

fn cell_to_msg(c: &LayoutCell) -> LayoutMsg {
    let (kind, pane, children) = match &c.kind {
        CellKind::Leaf(p) => ("leaf", Some(p.0), Vec::new()),
        CellKind::Cols(v) => ("cols", None, v.iter().map(cell_to_msg).collect()),
        CellKind::Rows(v) => ("rows", None, v.iter().map(cell_to_msg).collect()),
    };
    LayoutMsg {
        kind,
        pane,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        children,
    }
}

/// A pane's badge for aggregation: state + when it first became needy (epoch
/// ms) — the authoritative attention-queue ordering.
pub type AgentView = (AgentState, Option<u64>);

/// Aggregate the most attention-worthy agent state among a window's panes, and
/// which pane holds it — attention jumps focus that pane directly.
fn window_agent(
    root: &LayoutCell,
    agents: &BTreeMap<u32, AgentView>,
) -> Option<(&'static str, u32, Option<u64>)> {
    let mut best: Option<(AgentState, u32, Option<u64>)> = None;
    root.for_each_pane(&mut |pane, _| {
        if let Some(&(s, since)) = agents.get(&pane.0) {
            if best.is_none_or(|(b, _, _)| s.priority() > b.priority()) {
                best = Some((s, pane.0, since));
            }
        }
    });
    best.map(|(s, p, since)| (s.as_str(), p, since))
}

/// A native (non-tmux) tab for the state snapshot: ephemeral tabs are always
/// single-pane; persistent windows may hold several panes under a layout tree.
pub struct NativeTab {
    pub id: u32,
    pub name: String,
    pub panes: Vec<u32>,
    /// The window's CURRENT kind (flag truth — a promoted ⌁ reports false).
    pub ephemeral: bool,
}

/// The active native view: which window, its focused pane, and the real
/// layout tree (single full-view leaf for ephemeral tabs).
pub struct ActiveNative {
    pub window: u32,
    pub pane: u32,
    pub layout: LayoutCell,
    /// True while one pane is temporarily maximized (the layout is then a
    /// single full leaf of that pane).
    pub zoomed: bool,
}

/// Aggregate the most attention-worthy agent state among a set of panes, and
/// which pane holds it — attention jumps focus that pane directly.
fn panes_agent(
    panes: &[u32],
    agents: &BTreeMap<u32, AgentView>,
) -> Option<(&'static str, u32, Option<u64>)> {
    let mut best: Option<(AgentState, u32, Option<u64>)> = None;
    for &pane in panes {
        if let Some(&(s, since)) = agents.get(&pane) {
            if best.is_none_or(|(b, _, _)| s.priority() > b.priority()) {
                best = Some((s, pane, since));
            }
        }
    }
    best.map(|(s, p, since)| (s.as_str(), p, since))
}

/// Build the `{"t":"state",...}` snapshot: tmux windows plus any native tabs
/// (ephemeral or persistent, told apart by their id's high bits). When a
/// native view is active, `active_native` carries its real layout tree.
/// `tab_order` is the persistent first-seen ordering — new windows of either
/// engine append to it, and the emitted list follows it.
pub fn build_state_json(
    model: &Model,
    agents: &BTreeMap<u32, AgentView>,
    natives: &[NativeTab],
    active_native: Option<&ActiveNative>,
    tab_order: &mut Vec<u32>,
) -> String {
    let layout = if let Some(a) = active_native {
        Some(cell_to_msg(&a.layout))
    } else {
        model
            .active_window
            .and_then(|w| model.windows.get(&w))
            .and_then(|wi| wi.layout.as_ref())
            .map(|l| cell_to_msg(&l.root))
    };

    let active_win = active_native.map(|a| a.window);
    let mut windows: Vec<WinMsg> = model
        .windows
        .iter()
        .map(|(id, wi)| {
            let wa = wi
                .layout
                .as_ref()
                .and_then(|l| window_agent(&l.root, agents));
            WinMsg {
                id: id.0,
                name: wi.name.clone().unwrap_or_default(),
                active: active_native.is_none() && model.active_window == Some(*id),
                agent: wa.map(|(s, _, _)| s),
                agent_pane: wa.map(|(_, p, _)| p),
                agent_since: wa.and_then(|(_, _, since)| since),
                ephemeral: false,
                persistent: false,
            }
        })
        .collect();
    // Native tabs follow the tmux windows.
    for tab in natives {
        let wa = panes_agent(&tab.panes, agents);
        windows.push(WinMsg {
            id: tab.id,
            name: tab.name.clone(),
            active: active_win == Some(tab.id),
            agent: wa.map(|(s, _, _)| s),
            agent_pane: wa.map(|(_, p, _)| p),
            agent_since: wa.and_then(|(_, _, since)| since),
            ephemeral: tab.ephemeral,
            persistent: !tab.ephemeral,
        });
    }

    // Display order = first-seen order across both engines (new tabs land on
    // the right); drop ids that no longer exist.
    let live: std::collections::BTreeSet<u32> = windows.iter().map(|w| w.id).collect();
    tab_order.retain(|id| live.contains(id));
    for w in &windows {
        if !tab_order.contains(&w.id) {
            tab_order.push(w.id);
        }
    }
    windows.sort_by_key(|w| {
        tab_order
            .iter()
            .position(|x| *x == w.id)
            .unwrap_or(usize::MAX)
    });

    let (active_window, active_pane) = match active_native {
        Some(a) => (Some(a.window), Some(a.pane)),
        None => (
            model.active_window.map(|w| w.0),
            model.active_pane.map(|p| p.0),
        ),
    };

    let msg = StateMsg {
        t: "state",
        active_window,
        active_pane,
        windows,
        layout,
        zoomed: active_native.map(|a| a.zoomed).unwrap_or(false),
    };
    serde_json::to_string(&msg).unwrap_or_else(|_| r#"{"t":"state"}"#.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mux_core::{Layout, PaneId, WindowId};

    #[test]
    fn window_agent_reports_priority_state_and_its_pane() {
        let mut m = Model::new();
        let wid = WindowId(1);
        let leaf = |p: u32, x: u16| LayoutCell {
            w: 40,
            h: 24,
            x,
            y: 0,
            kind: CellKind::Leaf(PaneId(p)),
        };
        let root = LayoutCell {
            w: 81,
            h: 24,
            x: 0,
            y: 0,
            kind: CellKind::Cols(vec![leaf(1, 0), leaf(2, 41)]),
        };
        {
            let info = m.windows.entry(wid).or_default();
            info.name = Some("w".into());
            info.layout = Some(Layout { checksum: 0, root });
        }
        m.active_window = Some(wid);
        m.active_pane = Some(PaneId(1));

        let mut agents = BTreeMap::new();
        agents.insert(1u32, (AgentState::Running, None));
        agents.insert(2u32, (AgentState::Waiting, Some(1000))); // higher priority than running

        let json = build_state_json(&m, &agents, &[], None, &mut Vec::new());
        assert!(json.contains(r#""agent":"waiting""#), "{json}");
        assert!(json.contains(r#""agent_pane":2"#), "{json}");
    }

    #[test]
    fn native_tab_aggregates_agents_over_member_panes() {
        let m = Model::new();
        let mut agents = BTreeMap::new();
        let p1 = (1u32 << 30) | 1;
        let p2 = (1u32 << 30) | 2;
        agents.insert(p2, (AgentState::Waiting, Some(2000)));
        let tab = NativeTab {
            id: p1,
            name: String::new(),
            panes: vec![p1, p2],
            ephemeral: false,
        };
        let active = ActiveNative {
            window: p1,
            pane: p2,
            zoomed: false,
            layout: LayoutCell {
                x: 0,
                y: 0,
                w: 80,
                h: 24,
                kind: CellKind::Cols(vec![
                    LayoutCell {
                        x: 0,
                        y: 0,
                        w: 40,
                        h: 24,
                        kind: CellKind::Leaf(PaneId(p1)),
                    },
                    LayoutCell {
                        x: 40,
                        y: 0,
                        w: 40,
                        h: 24,
                        kind: CellKind::Leaf(PaneId(p2)),
                    },
                ]),
            },
        };
        let json = build_state_json(&m, &agents, &[tab], Some(&active), &mut Vec::new());
        assert!(json.contains(r#""agent":"waiting""#), "{json}");
        assert!(json.contains(&format!(r#""agent_pane":{p2}"#)), "{json}");
        assert!(json.contains(&format!(r#""active_pane":{p2}"#)), "{json}");
        assert!(json.contains(r#""kind":"cols""#), "{json}");
        assert!(json.contains(r#""persistent":true"#), "{json}");
    }
}
