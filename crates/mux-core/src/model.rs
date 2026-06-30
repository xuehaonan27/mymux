//! A minimal session/window/pane model folded from [`ControlEvent`]s.
//!
//! M0 only needs "which panes exist" and "which pane is active"; this grows in
//! M1 (full window↔session bookkeeping) and feeds the M3 agent dashboard.

use std::collections::{BTreeMap, BTreeSet};

use crate::layout::Layout;
use crate::protocol::ControlEvent;
use crate::{PaneId, WindowId};

/// What we currently know about one window.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub name: Option<String>,
    pub layout: Option<Layout>,
    pub active_pane: Option<PaneId>,
}

/// Aggregated state of the attached tmux server.
#[derive(Debug, Default)]
pub struct Model {
    pub session_name: Option<String>,
    pub panes: BTreeSet<PaneId>,
    pub windows: BTreeMap<WindowId, WindowInfo>,
    /// The pane that should currently receive keystrokes.
    pub active_pane: Option<PaneId>,
}

impl Model {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one event into the model. Returns `true` if anything observable
    /// changed (useful later for deciding when to repaint the dashboard).
    pub fn apply(&mut self, ev: &ControlEvent) -> bool {
        match ev {
            ControlEvent::Output { pane, .. } => {
                let is_new = self.panes.insert(*pane);
                if self.active_pane.is_none() {
                    self.active_pane = Some(*pane);
                }
                is_new
            }
            ControlEvent::WindowPaneChanged { window, pane } => {
                self.panes.insert(*pane);
                self.active_pane = Some(*pane);
                self.windows.entry(*window).or_default().active_pane = Some(*pane);
                true
            }
            ControlEvent::LayoutChange { window, layout, .. } => {
                self.windows.entry(*window).or_default().layout = layout.clone();
                true
            }
            ControlEvent::SessionChanged { name, .. } => {
                self.session_name = Some(name.clone());
                true
            }
            ControlEvent::WindowAdd { window } => {
                self.windows.entry(*window).or_default();
                true
            }
            ControlEvent::WindowClose { window } => self.windows.remove(window).is_some(),
            ControlEvent::WindowRenamed { window, name } => {
                self.windows.entry(*window).or_default().name = Some(name.clone());
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_panes_and_active() {
        let mut m = Model::new();
        m.apply(&ControlEvent::Output {
            pane: PaneId(0),
            data: b"hi".to_vec(),
        });
        assert_eq!(m.active_pane, Some(PaneId(0)));
        assert!(m.panes.contains(&PaneId(0)));

        m.apply(&ControlEvent::WindowPaneChanged {
            window: WindowId(0),
            pane: PaneId(1),
        });
        assert_eq!(m.active_pane, Some(PaneId(1)));
        assert_eq!(m.windows[&WindowId(0)].active_pane, Some(PaneId(1)));
    }
}
