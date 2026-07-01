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

#[derive(Serialize)]
struct WinMsg {
    id: u32,
    name: String,
    active: bool,
    /// Aggregated agent state of the window's panes, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<&'static str>,
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

/// Aggregate the most attention-worthy agent state among a window's panes.
fn window_agent(root: &LayoutCell, agents: &BTreeMap<u32, AgentState>) -> Option<&'static str> {
    let mut best: Option<AgentState> = None;
    root.for_each_pane(&mut |pane, _| {
        if let Some(&s) = agents.get(&pane.0) {
            if best.map_or(true, |b| s.priority() > b.priority()) {
                best = Some(s);
            }
        }
    });
    best.map(AgentState::as_str)
}

/// Build the `{"t":"state",...}` snapshot for the active window.
pub fn build_state_json(model: &Model, agents: &BTreeMap<u32, AgentState>) -> String {
    let layout = model
        .active_window
        .and_then(|w| model.windows.get(&w))
        .and_then(|wi| wi.layout.as_ref())
        .map(|l| cell_to_msg(&l.root));

    let windows = model
        .windows
        .iter()
        .map(|(id, wi)| WinMsg {
            id: id.0,
            name: wi.name.clone().unwrap_or_default(),
            active: model.active_window == Some(*id),
            agent: wi.layout.as_ref().and_then(|l| window_agent(&l.root, agents)),
        })
        .collect();

    let msg = StateMsg {
        t: "state",
        active_window: model.active_window.map(|w| w.0),
        active_pane: model.active_pane.map(|p| p.0),
        windows,
        layout,
    };
    serde_json::to_string(&msg).unwrap_or_else(|_| r#"{"t":"state"}"#.to_string())
}
