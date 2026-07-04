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
    /// The window currently shown by the attached client.
    pub active_window: Option<WindowId>,
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
                if self.active_window.is_none() {
                    self.active_window = Some(*window);
                }
                true
            }
            ControlEvent::LayoutChange { window, layout, .. } => {
                self.windows.entry(*window).or_default().layout = layout.clone();
                if self.active_window.is_none() {
                    self.active_window = Some(*window);
                }
                true
            }
            ControlEvent::SessionChanged { name, .. } => {
                self.session_name = Some(name.clone());
                true
            }
            ControlEvent::SessionWindowChanged { window, .. } => {
                self.active_window = Some(*window);
                // Keyboard focus follows the window: adopt its active pane —
                // tmux does not re-announce the pane on a bare window switch.
                if let Some(wi) = self.windows.get(window) {
                    let pane = wi.active_pane.or_else(|| {
                        wi.layout.as_ref().and_then(|l| {
                            let mut first = None;
                            l.root.for_each_pane(&mut |p, _| {
                                if first.is_none() {
                                    first = Some(p);
                                }
                            });
                            first
                        })
                    });
                    if pane.is_some() {
                        self.active_pane = pane;
                    }
                }
                true
            }
            ControlEvent::WindowAdd { window } => {
                self.windows.entry(*window).or_default();
                if self.active_window.is_none() {
                    self.active_window = Some(*window);
                }
                true
            }
            ControlEvent::WindowClose { window } => {
                let removed = self.windows.remove(window).is_some();
                if self.active_window == Some(*window) {
                    self.active_window = self.windows.keys().next().copied();
                }
                removed
            }
            ControlEvent::WindowRenamed { window, name } => {
                self.windows.entry(*window).or_default().name = Some(name.clone());
                true
            }
            _ => false,
        }
    }

    /// Pane ids of the active window, in layout order (empty if unknown).
    pub fn active_window_panes(&self) -> Vec<PaneId> {
        let mut panes = Vec::new();
        if let Some(w) = self.active_window {
            if let Some(layout) = self.windows.get(&w).and_then(|wi| wi.layout.as_ref()) {
                layout.root.for_each_pane(&mut |id, _| panes.push(id));
            }
        }
        panes
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

    #[test]
    fn tracks_active_window_and_panes() {
        let mut m = Model::new();
        m.apply(&ControlEvent::WindowAdd { window: WindowId(0) });
        assert_eq!(m.active_window, Some(WindowId(0)));

        let layout = crate::parse_layout("aaaa,80x24,0,0{40x24,0,0,0,39x24,41,0,1}");
        assert!(layout.is_some());
        m.apply(&ControlEvent::LayoutChange {
            window: WindowId(0),
            raw_layout: String::new(),
            layout,
        });
        assert_eq!(m.active_window_panes(), vec![PaneId(0), PaneId(1)]);

        m.apply(&ControlEvent::SessionWindowChanged {
            session: crate::SessionId(0),
            window: WindowId(1),
        });
        assert_eq!(m.active_window, Some(WindowId(1)));
    }

    #[test]
    fn window_switch_adopts_that_windows_active_pane() {
        let mut m = Model::new();
        m.apply(&ControlEvent::WindowAdd { window: WindowId(0) });
        m.apply(&ControlEvent::WindowPaneChanged { window: WindowId(0), pane: PaneId(3) });
        m.apply(&ControlEvent::WindowAdd { window: WindowId(1) });
        m.apply(&ControlEvent::WindowPaneChanged { window: WindowId(1), pane: PaneId(7) });
        assert_eq!(m.active_pane, Some(PaneId(7)));
        // Switch back to @0: the active pane must follow (tmux won't repeat it).
        m.apply(&ControlEvent::SessionWindowChanged {
            session: crate::SessionId(0),
            window: WindowId(0),
        });
        assert_eq!(m.active_window, Some(WindowId(0)));
        assert_eq!(m.active_pane, Some(PaneId(3)));
    }
}
