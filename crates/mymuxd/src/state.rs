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
    /// True for a mymuxd-owned ephemeral (non-tmux) tab.
    #[serde(skip_serializing_if = "is_false")]
    ephemeral: bool,
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
    LayoutMsg { kind, pane, x: c.x, y: c.y, w: c.w, h: c.h, children }
}

/// Aggregate the most attention-worthy agent state among a window's panes, and
/// which pane holds it — attention jumps focus that pane directly.
fn window_agent(
    root: &LayoutCell,
    agents: &BTreeMap<u32, AgentState>,
) -> Option<(&'static str, u32)> {
    let mut best: Option<(AgentState, u32)> = None;
    root.for_each_pane(&mut |pane, _| {
        if let Some(&s) = agents.get(&pane.0) {
            if best.map_or(true, |(b, _)| s.priority() > b.priority()) {
                best = Some((s, pane.0));
            }
        }
    });
    best.map(|(s, p)| (s.as_str(), p))
}

/// Build the `{"t":"state",...}` snapshot: tmux windows plus any ephemeral tabs.
/// When an ephemeral tab is the active view, the layout is a single full-view
/// leaf sized from `size` (tmux does not lay out ephemeral panes).
pub fn build_state_json(
    model: &Model,
    agents: &BTreeMap<u32, AgentState>,
    ephemerals: &[(u32, String)],
    active_ephemeral: Option<u32>,
    size: (u16, u16),
) -> String {
    let layout = if let Some(id) = active_ephemeral {
        Some(LayoutMsg {
            kind: "leaf",
            pane: Some(id),
            x: 0,
            y: 0,
            w: size.0,
            h: size.1,
            children: Vec::new(),
        })
    } else {
        model
            .active_window
            .and_then(|w| model.windows.get(&w))
            .and_then(|wi| wi.layout.as_ref())
            .map(|l| cell_to_msg(&l.root))
    };

    let mut windows: Vec<WinMsg> = model
        .windows
        .iter()
        .map(|(id, wi)| {
            let wa = wi.layout.as_ref().and_then(|l| window_agent(&l.root, agents));
            WinMsg {
                id: id.0,
                name: wi.name.clone().unwrap_or_default(),
                active: active_ephemeral.is_none() && model.active_window == Some(*id),
                agent: wa.map(|(s, _)| s),
                agent_pane: wa.map(|(_, p)| p),
                ephemeral: false,
            }
        })
        .collect();
    // Ephemeral tabs follow the tmux windows (their pane id == the window id).
    for (id, name) in ephemerals {
        windows.push(WinMsg {
            id: *id,
            name: name.clone(),
            active: active_ephemeral == Some(*id),
            agent: agents.get(id).map(|s| s.as_str()),
            agent_pane: agents.get(id).map(|_| *id),
            ephemeral: true,
        });
    }

    let (active_window, active_pane) = match active_ephemeral {
        Some(id) => (Some(id), Some(id)),
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
        agents.insert(1u32, AgentState::Running);
        agents.insert(2u32, AgentState::Waiting); // higher priority than running

        let json = build_state_json(&m, &agents, &[], None, (81, 24));
        assert!(json.contains(r#""agent":"waiting""#), "{json}");
        assert!(json.contains(r#""agent_pane":2"#), "{json}");
    }
}
