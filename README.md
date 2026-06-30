# mymux

A lightweight, remote-first, **agent-aware** terminal workspace for vibe coding
over SSH. It replaces the `iTerm2 → ssh → tmux → coding-agent` stack with a
single clean layer:

```
xterm.js / dashboard (UI)  ⇄  WebSocket  ⇄  mymuxd (Rust)  ⇄  tmux -CC  ⇄  PTYs
```

- **Native rendering** — terminals render once, in xterm.js. No nested tmux
  redraw, so scrollback and TUIs (Claude Code, Codex) stay clean.
- **tmux is the engine** — sessions/persistence come from `tmux -CC` control
  mode (the same mechanism iTerm2 uses), consumed natively by our client.
- **Agent-aware** — a dashboard shows which agent session is running, waiting
  for approval, or done — no more polling windows.
- **Resilient** — one SSH ControlMaster tunnel, auto-reconnecting; the daemon
  holds state so a dropped link restores instantly.

## Status

**M0 works**: a real shell driven through `tmux -CC`, bridged over WebSocket,
rendered by xterm.js. The end-to-end byte loop is verified and `mux-core` has
unit + fixture tests. Next: M1 (full multiplexer — layouts, splits, resize).

| Milestone | Scope | State |
|-----------|-------|-------|
| **M0** | tmux `-CC` driver + WS + one xterm.js pane | ✅ done |
| M1 | full multiplexer: layouts, splits, resize, copy/paste | next |
| M2 | persistence + auto-reconnect over an SSH tunnel; Tauri app | |
| M3 | agent-status dashboard (output heuristics + agent hooks) | |

## Layout

- `crates/mux-core` — dependency-free tmux control-mode protocol parser + model.
- `crates/mymuxd` — daemon: drives `tmux -CC`, serves a WebSocket + the UI.
- `ui` — Vite + TypeScript + xterm.js client.
- `fixtures` — captured control-mode streams used in tests.

## Develop

```sh
cargo test -p mux-core      # protocol/layout/model unit + fixture tests
cargo build -p mymuxd       # the daemon
npm --prefix ui install     # first time
npm --prefix ui run build   # typecheck + bundle the UI
```

## Run the M0 slice

On the dev box, in two shells:

```sh
cargo run -p mymuxd         # drives tmux, serves ws://127.0.0.1:8088/ws
npm --prefix ui run dev     # Vite dev server on http://127.0.0.1:5173
```

From your Mac, forward both ports and open the UI:

```sh
ssh -L 5173:localhost:5173 -L 8088:localhost:8088 <dev-host>
# then open http://localhost:5173
```

You get a real shell rendered by xterm.js, driven through tmux control mode —
one emulation layer, native scrollback, mouse wheel. Reload the page and the
session persists (tmux holds it on the `mymux` socket). M2 collapses the
two-port forward into the Tauri app over a single auto-reconnecting tunnel.
