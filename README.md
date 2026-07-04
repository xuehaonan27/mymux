# mymux

A lightweight, remote-first, **agent-aware** terminal workspace for vibe coding
over SSH. It replaces the `iTerm2 → ssh → tmux → coding-agent` stack with a
single clean layer:

```
Tauri app / browser (xterm.js UI)
   ⇄  SSH tunnel (in-process russh, auto-reconnect)
   ⇄  mymuxd (Rust daemon)  ⇄  tmux -CC (persistent sessions)  +  ⌁ raw shells (ephemeral PTYs)
```

- **Native rendering** — terminals render once, in xterm.js. No nested tmux
  redraw, so scrollback and TUIs (Claude Code, Codex) stay clean.
- **tmux is the engine** — sessions/persistence come from `tmux -CC` control
  mode (the same mechanism iTerm2 uses), consumed natively by our client.
- **Agent-aware** — tab badges show which agent is running, waiting for your
  approval, or done — no more polling windows.
- **Resilient** — an in-process SSH tunnel with auto-reconnect; you pick a host
  and type its key passphrase **in the app**. The daemon holds state, so a
  dropped link restores instantly.

## Quick start (desktop app)

**On the dev box (remote Linux, once).** Requires `tmux` installed:

```sh
scripts/install-systemd.sh          # build + install mymuxd as a systemd --user service
scripts/install-claude-hooks.sh     # optional: Claude Code agent-status hooks
scripts/install-codex-notify.sh     # optional: Codex agent-status (turn-complete)
```

**On your Mac:**

```sh
cargo install tauri-cli --version '^2'      # one-time
cargo tauri dev                             # or `cargo tauri build` for a .app/.dmg
```

The app opens on the **host manager**: add your dev box (hostname, user,
identity file), click it, type the key's passphrase, **Connect**. On first use
it asks you to trust the server's host key; then you land in the workspace —
⌘E code panel, ⌘K t processes, ⌘K s raw shells, agent badges, all live.

## Status

**Latest: the native host manager (M6)** — the app owns its SSH client
in-process (russh): per-host in-app passphrase entry, `known_hosts` TOFU, no
dependency on the `ssh` binary or an agent. On top of ephemeral shells + the
process tree (M5), the code panel (M4), agent badges (M3), the desktop app (M2),
and the multiplexer core (M0/M1).

| Milestone | Scope | State |
|-----------|-------|-------|
| **M0 / M0.1** | tmux `-CC` driver, byte-accurate parser, reseed, respawn, truecolor | ✅ done |
| **M1** | multi-pane layouts, splits, windows, resize, lossless, keys, copy/paste | ✅ done |
| **M2** | Tauri desktop app + resilient SSH tunnel (auto-reconnect) | ✅ done |
| **M3** | agent-status tab badges (hooks: Claude + Codex; heuristics) | ✅ done |
| **M4** | ⌘E code panel: file tree, editor (edit/save), git diff | ✅ done |
| **M5** | process tree (⌘K t) + ephemeral non-tmux shells (⌘K s) | ✅ done |
| **M6** | native host manager: in-process SSH (russh), in-app passphrase, TOFU host keys | ✅ done |
| **M7** | multi-host: several hosts at once, host chips, cross-host agent counts | ✅ built · Mac verify pending |

Remaining original pain point: LSP (deferred until an editor/plugin story
exists). Smaller items live in `docs/BACKLOG.md`.

## Layout

- `crates/mux-core` — dependency-free tmux control-mode protocol parser + model.
- `crates/mymuxd` — the daemon: drives `tmux -CC` and the ephemeral PTYs; serves
  the WebSocket plus the `/fs`, `/git`, `/proc`, `/agent` HTTP endpoints.
- `crates/mymux-connect` — SSH tunnels: the in-process russh client (host
  manager) and the ssh-binary CLI connector (browser workflow).
- `src-tauri` — the macOS desktop app (Tauri 2; its own workspace so the root
  builds on headless boxes).
- `ui` — Vite + TypeScript + xterm.js + CodeMirror client.
- `systemd/mymuxd.service` — the user-service unit (note `KillMode=process`).
- `scripts/` — installers (systemd, agent hooks) + the no-build shell tunnel.
- `docs/BACKLOG.md` — deferred polish.
- `fixtures` — captured control-mode streams used in tests.

## Develop

```sh
cargo test                  # workspace: parser/model fixtures, /proc, tunnel, host store
cargo build -p mymuxd       # the daemon
npm --prefix ui install     # first time
npm --prefix ui run build   # typecheck + bundle the UI
```

Two env knobs let a throwaway/second daemon run without colliding with your main
one: **`MYMUX_SOCKET`** (tmux control socket, default `mymux`) and **`MYMUX_ADDR`**
(listen address, default `127.0.0.1:8088`).

## Run the desktop app (macOS)

The native app (`src-tauri/`) bundles the UI, owns the SSH tunnel
**in-process** (russh — no `ssh` binary, no ssh-agent, no config files to
prepare), and unlocks the full iTerm2 keybindings a browser reserves
(⌘T / ⌘W / ⌘1–9). Build it **on your Mac** — it can't build on the headless
Linux box (no webkit2gtk, no display):

```sh
cargo install tauri-cli --version '^2'      # one-time; or: npm i -g @tauri-apps/cli
cargo tauri dev                             # dev run; or `cargo tauri build` for a .app/.dmg
```

On launch the **host manager** lists your saved hosts
(`~/.config/mymux/hosts.json`; an old single-host `~/.config/mymux/host` file is
migrated automatically). Pick one, enter the key's passphrase, **Connect**:

- The passphrase decrypts your key **in-app** and is held only in memory —
  reconnects are silent, nothing is written to disk. A Finder-launched `.app`
  works fine (no terminal needed to prompt).
- The **first** connection to a host shows its key fingerprint and asks to
  trust it (then records it in `~/.ssh/known_hosts`). A **changed** host key is
  refused outright — MITM protection.
- The app starts `mymuxd` on the remote if needed (the systemd service, else a
  detached fallback), keeps a local forward with auto-reconnect, and reveals the
  workspace. **Exiting the last pane ends the session and returns you to the
  host manager.**
- **Several hosts at once**: connect more hosts from the manager (`host`
  button) — each gets its own tunnel port and workspace. Host chips appear in
  the bar (click or **⌘⇧1–9** to switch), the agent counter sums ⏳/✓ across
  *all* hosts, and each chip carries its host's most attention-worthy agent
  dot — one glance over every machine's agents.

For a signed release bundle, first regenerate the icon set:
`cargo tauri icon src-tauri/icons/icon.png`.

## Run in a browser (dev workflow)

No Tauri needed for hacking on mymux itself. On the dev box:

```sh
cargo run -p mymuxd         # drives tmux, serves ws://127.0.0.1:8088/ws
npm --prefix ui run dev     # Vite dev server on http://127.0.0.1:5173
```

From your Mac, forward both ports and open <http://localhost:5173>:

```sh
ssh -L 5173:localhost:5173 -L 8088:localhost:8088 <dev-host>
```

Or replace the raw `ssh -L` for the daemon port with the resilient CLI
connector, which auto-reconnects on drops and can start the remote daemon:

```sh
cargo run -p mymux-connect -- <dev-host> --ensure-daemon
# no-build equivalent: scripts/mymux-connect.sh <dev-host>
```

The CLI connector uses the `ssh` binary (one ControlMaster, one auth), so it
authenticates via your ssh-agent/keychain — load the key once with
`ssh-add --apple-use-keychain ~/.ssh/id_ed25519` (plus `AddKeysToAgent yes` /
`UseKeychain yes` in `~/.ssh/config`); if it can't auth silently it prints
exactly that and waits. **The desktop app needs none of this** — its russh
client prompts in-app.

Reload the page or drop the link and the session persists — the daemon reseeds
every pane from tmux on reconnect.

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
Both the app and the CLI connector prefer this service and fall back to a
detached `setsid` launch if it isn't installed, so nothing breaks without it —
but the service is the reliable path (the fallback needs `mymuxd` on the PATH of
a non-interactive shell).

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

**The attention queue**: every window that needs a human (waiting for approval /
input, or finished) is queued across **all** connected hosts, ordered by when it
first needed you. Press **⌘J** (or ⌘K `a`, or click the ⏳/✓ summary) to jump to
the oldest one — keyboard focus lands **directly on the agent's pane**. Deal
with it and press again for the next. Entries clear themselves — answering flips
*waiting* back to *running*, and focusing clears *done*. When nothing is pending
you get a small "All clear — no agent needs you right now."

## Code & git (⌘E)

Press **⌘E** (or the `code` button) for a lightweight overlay: a file tree and
git-changes list on the left, a CodeMirror editor / unified diff on the right
(loaded on first use, so the app itself stays small). **⌘P** fuzzy-opens any
file in the repo. Open a file to read or edit it (⌘S saves); click a changed
file to see its diff. Each pane gets its own session rooted at that pane's cwd,
preserved across switches.

**Language smarts (LSP)**: opening a `.rs` file inside a Cargo project wires the
editor to a daemon-managed **rust-analyzer** — live diagnostics (squiggles),
hover docs, completion and signature help, with rename (F2) / go-to-definition
(F12) bound where the server supports them. Nothing to configure: install
rust-analyzer on the dev box (`rustup component add rust-analyzer`) and it's
picked up; without it the editor simply opens plain. The daemon speaks raw LSP
over `/lsp` on the existing port — see `docs/LSP-PLAN.md` for the roadmap
(more languages + Open VSX-based server install are next).

The daemon serves `/fs/*` and `/git/*` confined to a root (the pane's cwd, else
`MYMUX_ROOT`/cwd) — rejecting path escapes, with a CORS allowlist so only the
mymux UI can reach them.

## Processes (⌘K t)

Press **⌘K t** (or the `ps` button) for a scoped mini-htop: every window → pane →
its process subtree (rooted at each pane's shell pid, including `⌁` shells), with
live %CPU, memory and state. Hover a row and click **✕** to kill that process —
**⇧✕** for SIGKILL. Kills are **scoped**: the daemon only signals a pid it can
prove is inside a pane's subtree (never by name), so the dashboard can't take
down arbitrary processes. It reads `/proc` directly (Linux) and serves
`/proc/tree` + `/proc/kill` behind the same CORS allowlist as the code panel.

## Ephemeral shells (⌘K s)

Not everything needs tmux. Press **⌘K s** (or the `+sh` button) for a raw,
non-tmux shell in its own top-level tab (marked `⌁`, dashed) — ideal for quick
throwaway commands without nesting inside a persistent agent session. It's a
mymuxd-owned pty: it inherits the focused pane's cwd (with `$TMUX` stripped, so
you can even nest a tmux in it) and **survives a disconnect** (the daemon holds
it). Reconnects and tab switches restore a **faithful terminal snapshot** —
colors, cursor, alternate screen (vim & co.) and recent scrollback — from a
server-side terminal grid, the first building block of the future native
engine. It still dies with the daemon (by design). Close it like any pane;
persistent (agent) work stays on tmux windows.

## Persistent shells (⌘K ⇧S)

Press **⌘K ⇧S** (or the `+psh` button) for a native shell that **survives
mymuxd restarts**: its PTY and terminal grid are held by **mymux-ptyd**, a tiny
companion daemon that changes rarely (installed and started by
`scripts/install-systemd.sh`; mymuxd can also bootstrap it on demand). Deploy or
crash mymuxd all you like — on the next start it re-adopts these tabs, full
screen state included. Tabs are marked `∞` (violet). The contract mirrors tmux's
server: panes die only if **ptyd itself** stops, so the installer never restarts
a live ptyd — do that yourself when idle.
