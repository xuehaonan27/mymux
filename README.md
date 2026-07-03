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

**M4 works** (code panel): ⌘E opens a lightweight file tree + editor + git-diff
over the terminal — browse, edit, and review changes without leaving mymux. On
top of agent-status badges (M3), the multiplexer (M1), and the Tauri app +
resilient single-auth tunnel (M2).

| Milestone | Scope | State |
|-----------|-------|-------|
| **M0 / M0.1** | tmux `-CC` driver, byte-accurate parser, reseed, respawn, truecolor | ✅ done |
| **M1** | multi-pane layouts, splits, windows, resize, lossless, keys, copy/paste | ✅ done |
| **M2** | Tauri desktop app + resilient single-auth SSH tunnel (auto-reconnect) | ✅ done |
| **M3** | agent-status tab badges (hooks + heuristics) | ✅ done |
| **M4** | ⌘E code panel: file tree, editor (edit/save), git diff | ✅ done |
| **M5** | process tree (⌘K t) + ephemeral non-tmux shells (⌘K s) | ✅ daemon verified · GUI pending |

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

## One-time SSH setup (do this first)

mymux authenticates over SSH **non-interactively** — the packaged desktop app
has no terminal to type a passphrase into, so your key must be loaded in an
agent. Do this once:

```sh
# macOS — store the passphrase in the Keychain and auto-load the key:
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Then in `~/.ssh/config`, under the host you connect to:

```
Host <dev-host>
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

(Linux client: `eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519`.)

After this, both `cargo tauri dev` and the built `.app` connect with **no**
passphrase prompt. The connector reuses a single SSH ControlMaster — it
authenticates at most once and reconnects silently. If the key isn't loaded it
prints these exact steps and waits, connecting the moment you run `ssh-add`.

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
auto-reconnect, and opens the workspace. With your key in an agent (see
[One-time SSH setup](#one-time-ssh-setup-do-this-first)) it connects with no
passphrase prompt — essential here, since a Finder-launched app has no terminal
to prompt on. Drop the network and it restores on its own. For a signed release
bundle, first regenerate the icon set: `cargo tauri icon src-tauri/icons/icon.png`.

## Run mymuxd as a service (remote, systemd)

For a daemon that survives SSH logout and restarts cleanly, install it as a
`systemd --user` service on the dev box:

```sh
scripts/install-systemd.sh     # builds release, installs the unit, enables linger
```

This runs mymuxd under your user manager (not an ephemeral SSH-session scope) and
enables lingering, so the daemon — and your tmux sessions — survive a disconnect.
The unit uses **`KillMode=process`**, so `systemctl --user restart mymuxd` reloads
the daemon **without killing the tmux server** (sessions persist across restarts;
ephemeral `⌁` shells are dropped by design). Logs: `journalctl --user -u mymuxd -f`.
The connector prefers this service and falls back to a detached `setsid` launch if
it isn't installed, so nothing breaks without it.

## Agent status

Window tabs are badged by each agent's state, so you glance instead of polling:
🔵 running · 🟡 waiting for you · 🟢 done. The bar summarizes too (`⏳ 2 waiting`).

Wire your agents to report state (one-time, on the dev box where they run):

```sh
scripts/install-claude-hooks.sh     # Claude Code: merges hooks non-destructively
scripts/install-codex-notify.sh     # Codex: points `notify` at the reporter
```

Under the hood the hooks run `scripts/mymux-agent-report.sh <state>`, which `GET`s
`/agent?pane=…&state=…`, resolving the pane from `$TMUX_PANE` (tmux) or `$MYMUX_PANE`
(a raw `⌁` shell) — so agents in **either** pane type badge their tab. Codex's
`notify` only fires on turn-complete, so it reports *done* and leaves *running* to
the heuristic (a stale *done* clears the moment the pane emits output again).

Panes **without** hooks fall back to output heuristics: a backgrounded full-screen
app badges *running* while active, *done* when it goes quiet, *waiting* if it rang
the bell — and focusing a window clears its *done*.

## Code & git (⌘E)

Press **⌘E** (or the `code` button) for a lightweight overlay: a file tree and
git-changes list on the left, a CodeMirror editor / unified diff on the right.
Open a file to read or edit it (⌘S saves); click a changed file to see its diff.
It's a "quick look," not an IDE — no LSP yet (the last open pain point), just
fast browse/edit/diff without opening VSCode.

The daemon serves `/fs/*` and `/git/*` confined to a root (`MYMUX_ROOT` or its
cwd) — rejecting path escapes, with a CORS allowlist so only the mymux UI can
reach them.

## Processes (⌘K t)

Press **⌘K t** (or the `ps` button) for a scoped mini-htop: every window → pane →
its process subtree (rooted at each pane's shell pid), with live %CPU, memory and
state. Hover a row and click **✕** to kill that process — **⇧✕** for SIGKILL.
Kills are **scoped**: the daemon only signals a pid it can prove is inside a
pane's subtree (never by name), so the dashboard can't take down arbitrary
processes. It reads `/proc` directly (Linux) and serves `/proc/tree` + `/proc/kill`
behind the same CORS allowlist as the code panel.

Two env knobs let a throwaway/second daemon run without colliding with your main
one: **`MYMUX_SOCKET`** (tmux control socket, default `mymux`) and **`MYMUX_ADDR`**
(listen address, default `127.0.0.1:8088`).

## Ephemeral shells (⌘K s)

Not everything needs tmux. Press **⌘K s** (or the `+sh` button) for a raw,
non-tmux shell in its own top-level tab (marked `⌁`, dashed) — ideal for quick
throwaway commands without nesting inside a persistent agent session. It's a
mymuxd-owned pty: it inherits the focused pane's cwd and **survives a disconnect**
(the daemon holds it), but is intentionally ephemeral — it dies with the daemon
and reseeds best-effort (a raw byte replay, not a reconstructed screen, so a
full-screen TUI may look rough on reconnect). Close it like any pane. Persistent
(agent) work stays on tmux windows.
