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

**M1 works** (the multiplexer): multi-pane layouts (splits + windows/tabs),
cell-accurate resize, lossless delivery (resync on backpressure), keybindings (a
`⌘K` leader + direct combos) and copy/paste — on top of the M0 base (agent TUIs
render, reconnect reseeds, respawn, truecolor). **M2.1** adds a resilient,
single-auth SSH tunnel. Next: M2.2 (Tauri desktop app).

| Milestone | Scope | State |
|-----------|-------|-------|
| **M0** | tmux `-CC` driver + WS + one xterm.js pane | ✅ done |
| **M0.1** | byte-accurate parser, screen reseed, respawn, truecolor | ✅ done |
| **M1** | multi-pane layouts, splits, windows, resize, lossless, keys, copy/paste | ✅ done |
| **M2.1** | resilient single-auth SSH tunnel (auto-reconnect) | ✅ done |
| **M2.2** | Tauri desktop app + full iTerm2 keybindings | next |
| M3 | agent-status dashboard (output heuristics + agent hooks) | |

## Layout

- `crates/mux-core` — dependency-free tmux control-mode protocol parser + model.
- `crates/mymuxd` — daemon: drives `tmux -CC`, serves a WebSocket + the UI.
- `crates/mymux-connect` — client-side resilient SSH tunnel (auto-reconnect).
- `ui` — Vite + TypeScript + xterm.js client.
- `scripts/mymux-connect.sh` — no-build resilient tunnel (pure `ssh` loop).
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
session persists (tmux holds it on the `mymux` socket).

## Connect from your Mac (resilient tunnel)

Start the daemon + UI on the dev box (as above), then from your Mac run the
connector instead of a raw `ssh -L` for the daemon port:

```sh
cargo run -p mymux-connect -- <dev-host>     # or, no build: scripts/mymux-connect.sh <dev-host>
```

It forwards `localhost:8088` to the remote mymuxd and **auto-reconnects** on
network drops. Authenticate once (ssh-agent / keychain) and every window rides
that one tunnel; on reconnect the daemon reseeds all panes from tmux, so nothing
is lost. (Forward `5173` for the Vite-served UI too, until M2.2 bundles the UI
into the Tauri app.)

## Run the desktop app (macOS)

The native app (`src-tauri/`) bundles the UI, keeps the resilient tunnel itself,
and unlocks the full iTerm2 keybindings a browser reserves (⌘T / ⌘W / ⌘1–9).
Build it **on your Mac** — it can't build on the headless Linux box (no
webkit2gtk, no display):

```sh
# one-time: Tauri CLI
cargo install tauri-cli --version '^2'      # or: npm i -g @tauri-apps/cli

# tell it which host runs mymuxd (an ~/.ssh/config alias works)
mkdir -p ~/.config/mymux && echo "<dev-host>" > ~/.config/mymux/host
# (or export MYMUX_HOST=<dev-host>)

# from the repo root on your Mac:
cargo tauri dev          # dev run; or `cargo tauri build` for a .app / .dmg
```

The app starts `mymuxd` on the remote if needed, forwards `localhost:8088` with
auto-reconnect, and opens the workspace. Enter your ssh passphrase once
(keychain); drop the network and it restores on its own. For a signed release
bundle, first regenerate the icon set: `cargo tauri icon src-tauri/icons/icon.png`.
