//! End-to-end parse of a real captured `tmux -C` stream (`fixtures/basic.ctrl`),
//! exercising %output un-escaping, layout parsing, window lifecycle and command
//! replies together.

use mux_core::{CellKind, ControlEvent, Model, PaneId, Parser, WindowId};

const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/basic.ctrl"));

fn parse_all() -> Vec<ControlEvent> {
    let mut parser = Parser::new();
    let mut events = Vec::new();
    for line in FIXTURE.split('\n') {
        if let Some(ev) = parser.push_line(line.as_bytes()) {
            events.push(ev);
        }
    }
    events
}

#[test]
fn reconstructs_pane_output() {
    // Concatenate everything pane %0 emitted; the `printf` produced "AB\r\nC\r\n".
    let mut pane0 = Vec::new();
    for ev in parse_all() {
        if let ControlEvent::Output { pane, data } = ev {
            if pane == PaneId(0) {
                pane0.extend_from_slice(&data);
            }
        }
    }
    let text = String::from_utf8_lossy(&pane0);
    assert!(text.contains("AB\r\nC\r\n"), "got: {text:?}");
}

#[test]
fn sees_layout_window_and_exit() {
    let events = parse_all();

    // The split produced a two-column layout on window @0.
    let layout = events.iter().find_map(|ev| match ev {
        ControlEvent::LayoutChange {
            window: WindowId(0),
            layout: Some(l),
            ..
        } => Some(l),
        _ => None,
    });
    let layout = layout.expect("expected a layout-change for @0");
    match &layout.root.kind {
        CellKind::Cols(v) => {
            assert_eq!(v[0].kind, CellKind::Leaf(PaneId(0)));
            assert_eq!(v[1].kind, CellKind::Leaf(PaneId(1)));
        }
        other => panic!("expected columns, got {other:?}"),
    }

    // A second window was opened.
    assert!(events
        .iter()
        .any(|ev| matches!(ev, ControlEvent::WindowAdd { window: WindowId(1) })));

    // list-windows reply names both windows.
    let reply = events.iter().find_map(|ev| match ev {
        ControlEvent::CommandReply { lines, .. } if lines.iter().any(|l| l.contains("logs")) => {
            Some(lines)
        }
        _ => None,
    });
    assert!(reply.is_some(), "expected list-windows reply mentioning 'logs'");

    // Stream ends with the control client exiting.
    assert!(matches!(events.last(), Some(ControlEvent::Exit { .. })));
}

#[test]
fn model_folds_fixture() {
    let mut model = Model::new();
    for ev in parse_all() {
        model.apply(&ev);
    }
    assert_eq!(model.session_name.as_deref(), Some("main"));
    // panes %0, %1 (split) and %2 (new window) all produced output.
    for p in [PaneId(0), PaneId(1), PaneId(2)] {
        assert!(model.panes.contains(&p), "missing pane {p}");
    }
    assert!(model.windows.contains_key(&WindowId(0)));
}
