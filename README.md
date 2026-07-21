# mymux

A lightweight, remote-first, **agent-aware** terminal workspace for vibe coding
over SSH. It replaces the `iTerm2 → ssh → tmux → coding-agent` stack with a
single clean layer:

```
Tauri app / browser (xterm.js UI)
   ⇄  SSH tunnel (in-process russh, auto-reconnect)
   ⇄  mymuxd (Rust daemon)  ⇄  tmux -CC (persistent sessions)  +  mymux-ptyd (native ⌁/∞ panes)
```

- **Native rendering** — terminals render once, in xterm.js. No nested tmux
  redraw, so scrollback and TUIs (Claude Code, Codex) stay clean.
- **Two engines, one client** — tmux `-CC` powers the classic engine;
  mymux-ptyd's native panes (⌁/∞) are the default windows and survive daemon
  restarts.
- **Agent-aware** — tab badges show which agent is running, waiting for your
  approval, or done — no more polling windows.
- **Resilient** — an in-process SSH tunnel with auto-reconnect; you pick a host
  and type its key passphrase **in the app** (held only in memory, so
  reconnects are silent). One persistent master connection per host carries
  the forward, exec calls and probes on one auth.

## Quick start (desktop app)

**On the dev box (remote Linux).** Requires `tmux` installed. One command,
run from your Mac (or any machine with ssh and this repo):

```sh
scripts/mymux-bootstrap.sh user@dev-box   # install/upgrade mymuxd, idempotent
```

It lands the daemons in `~/.local/bin` (rsync'd prebuilts via `--bin-dir`, or a
source build on the box — `--with-rustup` when the box has no cargo) and
registers the systemd --user services when available. **The desktop app can
skip even this**: connecting to a host whose mymuxd is missing or outdated
pushes a self-contained daemon bundle (musl-static binaries — no toolchain or
GitHub access needed on the box) and installs it over its own SSH — zero-touch.
On the box itself, the equivalents are `scripts/mymux-install-remote.sh`
(self-contained) and `scripts/install-systemd.sh` (the classic). Optional agent
wiring: `install-claude-hooks.sh` / `install-codex-notify.sh` /
`install-kimi-hooks.sh` / `install-opencode-plugin.sh` (see Agent status).

**On your Mac:**

```sh
cargo install tauri-cli --version '^2'      # one-time
cargo tauri dev                             # or `cargo tauri build` for a .app/.dmg
```

The app opens on the **host manager**: add your dev box (hostname, user,
identity file), click it, type the key's passphrase, **Connect**. On first use
it asks you to trust the server's host key; then you land in the workspace —
⌘E code panel, ⌘K i processes, ⌘K n raw shells, agent badges, all live.

## Status

**Latest: reliability + VS Code-parity line (2026-07-17)** — all-pane IME
(Sogou-class commit lanes), terminal font zoom (⌘=/⌘-/⌘0), ⌘+click path
jumps (terminal ⇄ editor ⇄ `file:line`), editor⇄git two-way jumps with the
graph as the landing view, workspace-scoped panel swapping across hosts,
autoretrying/self-healing editor trees, plain-English reconnect/install
surfaces (bind-fatal + install-rollback + oscillation breaker), and an
experimental Canvas terminal renderer (Settings A/B). A five-area structural
audit lives in `docs/AUDIT.md`; the design rules these changes follow are in
`AGENTS.md`. On top of the git surface, per-host persistent SSH masters,
multi-host workspaces, ptyd persistent panes, and the editor/package stack
below.

| Milestone | Scope | State |
|-----------|-------|-------|
| **M0 / M0.1** | tmux `-CC` driver, byte-accurate parser, reseed, respawn, truecolor | ✅ done |
| **M1** | multi-pane layouts, splits, windows, resize, lossless, keys, copy/paste | ✅ done |
| **M2** | Tauri desktop app + resilient SSH tunnel (auto-reconnect) | ✅ done |
| **M3** | agent-status tab badges (hooks: Claude + Codex; heuristics) | ✅ done |
| **M4** | ⌘E code panel: file tree, editor (edit/save), git diff | ✅ done |
| **M5** | process tree (⌘K i) + ephemeral non-tmux shells (⌘K n) | ✅ done |
| **M6** | native host manager: in-process SSH (russh), in-app passphrase, TOFU host keys | ✅ done |
| **M7** | multi-host: several hosts at once, host chips, cross-host agent counts | ✅ done (in daily use) |

Post-milestones so far: persistent native panes (mymux-ptyd: splits, zoom,
faithful snapshots, survive mymuxd restarts), the **mymux-pkg** package index
(9 prewired entries, LSP ready at install), settings surface + attention
notifications, and the git tooling line above. Deferred items are tracked in
`docs/BACKLOG.md` (polish) and `docs/AUDIT.md` (structural).

## Layout

- `crates/mux-core` — dependency-free tmux control-mode protocol parser + model.
- `crates/mymuxd` — the daemon: drives `tmux -CC`, talks to ptyd; serves
  the WebSocket plus the `/fs`, `/git`, `/proc`, `/agent`, `/lsp`, `/pkgs`,
  `/termhistory` HTTP endpoints.
- `crates/mymux-ptyd` — the persistent-pane holder: PTYs + server-side terminal
  grids + raw history logs behind a unix-socket protocol; outlives mymuxd.
- `crates/mymux-connect` — SSH tunnels: the in-process russh client (host
  manager) and the ssh-binary CLI connector (browser workflow).
- `crates/mymux-pkg` — the package manager CLI: prewired `index/index.json`
  entries (language servers today), integrity-checked channels, install/list/
  remove.
- `src-tauri` — the macOS desktop app (Tauri 2; its own workspace so the root
  builds on headless boxes).
- `ui` — Vite + TypeScript + xterm.js + CodeMirror client.
- `ui/ux` — the headless e2e harness: Playwright-core checks driving the real
  UI against live daemons and fixture repos (see *Develop*).
- `systemd/mymuxd.service` — the user-service unit (note `KillMode=process`).
- `scripts/` — installers (systemd, agent hooks) + the no-build shell tunnel.
- `docs/BACKLOG.md` — deferred polish.
- `docs/AUDIT.md` — the 2026-07-17 five-area structural audit (fixed + deferred findings, and what was verified solid).
- `fixtures` — captured control-mode streams used in tests.

## Develop

```sh
cargo test                  # workspace: parser/model fixtures, /proc, tunnel, host store
cargo build -p mymuxd       # the daemon
npm --prefix ui install     # first time
npm --prefix ui run build   # typecheck + bundle the UI
```

The **e2e harness** lives in `ui/ux`: an isolated ptyd+daemon pair with all
three isolation knobs set, plus `npm --prefix ui run dev`:

```sh
export MYMUX_PTYD_SOCK=/tmp/mymux-ux.sock MYMUX_SOCKET=mymux-ux MYMUX_ADDR=127.0.0.1:8099
./target/debug/mymux-ptyd & ./target/debug/mymuxd &
```

then checks like `node ui/ux/gitcheck.mjs` drive the real UI headless
(Playwright-core) against fixture repos. The shared fixtures
(`~/ux-git-test`, `~/ux-git-ops` + its bare remote, `~/ux-code-tree`) are
built idempotently by `node ui/ux/fixtures.mjs` — never clobbered when
present — and the checks that need one call its `ensure*` themselves; a few
checks still create their own (e.g. `~/ux-git-sub`). Daemon-touching checks
should not hand-roll that pair: `ui/ux/sandbox.mjs`'s
`startSandbox(port, name)` wires all three knobs and the cleanup for you.
Every git-interaction batch ships with its own `git*check.mjs`; run
the whole sweep before committing UI changes. Cross-cutting static guards:
`npm --prefix ui run check:args` (every `invoke()` key in `ui/src` must match
a snake_case Rust param on its command — kills the hostId/host_id class for
good), and daemon-touching checks must run sandboxed (own `MYMUX_PTYD_SOCK` +
`MYMUX_SOCKET` + port — never a shared/production daemon).

Two env knobs let a throwaway/second daemon run without colliding with your main
one: **`MYMUX_SOCKET`** (tmux control socket, default `mymux`) and **`MYMUX_ADDR`**
(listen address, default `127.0.0.1:8088`). ptyd has its own sandbox knob too:
**`MYMUX_PTYD_SOCK`** (unix socket path) — that's how `altcheck.mjs` tests
pane-granular daemons without ever touching your production ptyd.

## Run the desktop app (macOS)

The native app (`src-tauri/`) bundles the UI, owns the SSH tunnel
**in-process** (russh — no `ssh` binary, no ssh-agent, no config files to
prepare), and unlocks the full iTerm2 keybindings a browser reserves
(⌘T / ⌘W / ⌘1–9). Build it **on your Mac** — it can't build on the headless
Linux box (no webkit2gtk, no display).

**The release build is one command** (on the Mac):

```sh
scripts/build-release.sh
```

  It produces the daemon bundle (delegating its build to
`$MYMUX_BUILD_HOST`/`~/.config/mymux/build-host` when the local box has no
musl toolchain — the Mac case; skipped entirely when the bundle already
matches the commit), builds the UI, runs `cargo tauri build` (ad-hoc signed),
and drops `mymux.dmg` into `dist/`. **That dmg is the whole product**: install
it, open, add a host, type the passphrase — the app pushes and installs the
daemon bundle itself, zero-touch. **Or just wait for CI**: every `v*` tag
builds it on GitHub's free `macos-latest` runner and attaches
`mymux_<version>_aarch64.dmg` to that tag's GitHub Release (job gated on the
daemon matrix — it downloads the matrix's `bundles.json` + tarballs as a
workflow artifact, verifies the manifest's version against the tag and each
tarball's sha256 against the manifest, pins THAT manifest into the app
before building, and asserts the built binary embeds it; ad-hoc signed by
`cargo tauri build`, same artifact shape).
First launch of an ad-hoc-signed app: **macOS may claim the app "is damaged"**
(verified on Tahoe 26.x, 2026-07-17) — it isn't; ad-hoc signing plus the
quarantine flag is why. Either right-click → Open once, or from the terminal:
`xattr -dr com.apple.quarantine /Applications/mymux.app`.

For just the bundle on its own: `scripts/build-daemon-bundle.sh` (same
delegation). Without the bundle the app still works — the zero-touch install
just reports why it's unavailable instead of pushing.

**Per-arch daemon distribution (release channel)**: the app no longer needs
daemon bytes embedded for every arch. `scripts/ci-build-daemon-matrix.sh`
produces `linux-{x86_64,aarch64}.tar.gz` (the second via cargo-zigbuild,
bootstrapped pinned) plus a `bundles.json` manifest (per-arch URL + sha256 +
version, embedded into the app). A push of tag `v*` runs the same script on
Gitea Actions (`.gitea/workflows/release.yml`, runner label `rui.ke`) and
`scripts/ci-publish-release.sh` creates the release and uploads everything to
**self-hosted Gitea Releases** (gitea.aka.cy; GitHub Releases as the fallback
mirror). On first contact with a host whose daemon is missing or outdated,
the app probes `uname -sm` over SSH, downloads exactly that host's arch over
HTTPS with integrity verification, then relays it through its own SSH into
the established upload/install flow. `MYMUX_BUNDLE_MIRROR` swaps the URL host
for internal mirrors; the embedded x86_64 bundle above stays as the
offline/airgapped fallback.

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
  detached fallback), and if the daemon is missing or outdated it first pushes
  a self-contained bundle (`scripts/build-daemon-bundle.sh` → musl-static
  binaries, embedded at app build time; the box needs no toolchain, git or
  network beyond the SSH you're on) and runs the installer — ptyd is never
  restarted in the process, so persistent shells ride through. It keeps a
  local forward with auto-reconnect, and reveals the workspace. **Exiting the
  last pane ends the session and returns you to the host manager.**
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

The easy path is `scripts/mymux-bootstrap.sh` from your Mac (above); this
section is the on-box equivalent. For a daemon that survives SSH logout and
restarts cleanly, install it as a `systemd --user` service on the dev box:

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
scripts/install-claude-hooks.sh      # Claude Code: merges hooks non-destructively
scripts/install-codex-notify.sh      # Codex: points `notify` at the reporter
scripts/install-kimi-hooks.sh        # Kimi Code: appends [[hooks]] to config.toml
scripts/install-opencode-plugin.sh   # Open Code: drops a plugin in ~/.config/opencode
```

Under the hood the hooks run `scripts/mymux-agent-report.sh <state>`, which `GET`s
`/agent?pane=…&state=…`, resolving the pane from `$TMUX_PANE` (tmux) or `$MYMUX_PANE`
(a raw `⌁` shell) — so agents in **either** pane type badge their tab. Codex's
`notify` only fires on turn-complete, so it reports *done* and leaves *running* to
the heuristic (a stale *done* clears the moment the pane emits output again). Kimi
Code reports precisely (`UserPromptSubmit` / `PermissionRequest` / `Stop`), as does
the Open Code plugin (`permission.asked` / `session.idle`).

Panes **without** hooks fall back to output heuristics: a backgrounded full-screen
app badges *running* while active, *done* when it goes quiet (8s), *waiting* if
it rang an attention bell (bells inside OSC sequences — your prompt's window
title — don't count), and focusing a window clears its *done*. For native panes
the alternate-screen signal is **authoritative**: mymux-ptyd's terminal grids
track `?1047/1048/1049` enter/exit chunk-safely and report flips on the wire
(upgrades in place at ptyd's next restart; `PaneInfo.alt` reseeds adoption).

**The attention queue**: every window that needs a human (waiting for approval /
input, or finished) is queued across **all** connected hosts, ordered by when it
first needed you. Press **⌘J** (or ⌘K `j`, or click the ⏳/✓ summary) to jump to
the oldest one — keyboard focus lands **directly on the agent's pane**. Deal
with it and press again for the next. Entries clear themselves — answering flips
*waiting* back to *running*, and focusing clears *done*. When nothing is pending
you get a small "All clear — no agent needs you right now."

**Notifications (the `bell` button)**: click `bell` in the bar once to arm
system-level alerts. From then on, when an agent window enters *waiting* (needs
your decision) or *done* while mymux is **unfocused**, you get a real
notification — in the desktop app via the **Mac Notification Center** (Tauri
plugin; macOS asks for permission once), in a browser via the Notification API
(which macOS browsers route through Notification Center too). Clicking it
focuses mymux and lands you on the agent's pane, like ⌘J. Alerts fire only on
state **transitions** (no repeat nagging while a state persists) and only while
unfocused — when you're looking at mymux, the badges and the attention queue
already say it. The app (or browser tab) must be running: a closed app can't
notify. The button shows a struck-through bell if the OS/browser has
notifications blocked — allow them in the site/app settings first.

## Git surface (⌘K v / the branch button)

One button, one surface, two pages — the repo's whole story. It opens on the
**History** graph (the map you orient by); reopening within a session returns
to whichever page you last used, and the deep links below land on their page
no matter what.

**Changes** (the working-tree workbench): the uncommitted section (per-file
＋/− stage, two-click discard, Stage/Unstage-all, the commit box with smart
stage-all-first, Amend HEAD), the conflict banner when a sequencer is running
(Continue / two-click Abort, driven over `/git/state` + `/git/op`), and the
stash list (Apply / Pop / Drop). Click a file to open a **stageable diff** on
the right: unified (click '+'/−' rows to select ranges, per-hunk buttons, or
the whole file) or split (HEAD/index ↔ working tree), with sub-hunk
(un)staging rebuilt into reduced patches and applied over `git apply
--cached`. Conflicted rows jump into the editor instead, which shows VS
Code-style **Accept Current / Incoming / Both** bars above each conflict
block. Every file row carries a **✎** that jumps back into the editor on that
file (the reverse of the editor's deep links); commit/stash detail rows have
the same ✎ to the file's working-tree copy — as does the diff header's *open
in editor*. Submodules are flagged with a purple **S**; clicking enters them
as their own repos.

**History** (pure swim-lane topology): branches/merges in an 8-color lane
palette, 200-commit infinite-scroll paging, a branch dropdown and free-text
filter, and badges that act like Git Lens's — right-click a commit for
cherry-pick / revert / copy-hash / checkout / reset (soft·mixed·hard, hard is
two-click) / **mark as compare base** (a second pick renders the A..B
cumulative diff in the detail column); right-click a branch for checkout /
merge / create / delete; create tags the same way. **File history** (from the
editor's Hist button or a diff row) narrows the lanes to one path, renames
followed. The detail column shows the commit's meta, body, name-status files
and inline diffs (whole commit or per file).

Toolbar: Fetch / Pull / Push / Rebase / Stash one-click ops (argv-only, no
shell; output toasted verbatim) with the upstream ahead/behind count beside
them. **Blame** lives in the editor: a per-run gutter colored by recency
(newest warm, oldest dim), a hover card per group, ghost text on the cursor
line — and any of them jumps here, onto that exact commit. Everything runs
read-write through the `/git/*` endpoints (rev charset-validated, paths
`safe_path`-confined, timeouts + size caps), so the same flow works identically
on every connected host.

## Editor (⌘E)

Press **⌘E** (or the `code` button) for a lightweight editor overlay: file
tree and a changes list on the left (deep links into the git surface's
workbench), CodeMirror editor on the right (loaded on first use, so the app
stays small). **⌘P** fuzzy-opens any file in the repo; every open file keeps
its own buffer (dirty `●`, two-click close) with undo history preserved.
⌘S saves (and feeds the LSP's `didSave`, so compiler-tier diagnostics land
too). **Path jumps (⌘+click)**: hold ⌘ and path-ish tokens underline like in
VS Code — in every terminal pane, and inside the editor on path tokens.
Clicking resolves the token against that pane's cwd (or the panel's root) and
opens the file — a trailing `:line[:col]` lands the cursor there, like
`./src/a.rs:33` from compiler output — or re-roots the panel when it names a
directory. Per-file buttons in the header: **Blame** (the gutter above), **Hist**
(the file's history in the git surface), and **Prev** for markdown — rendered
sanitized with relative images served through `/fs/raw`. A root switcher
(↑ parent · ⌂ pane cwd · ⎇ repo toplevel) scopes every view. Tree rows carry
a VS Code-style right-click menu (**Copy Relative Path** / **Copy Absolute
Path**), and a slow or failing directory listing shows an inline status with
click-to-retry — never a silent blank tree. Images and other
binaries open in viewers (inline image with dimensions + checkerboard,
hex dump otherwise). The editor's own changes list is leaf-node only — sub
modules still open *locally* (they're panel roots), everything else links
into the git surface, by design-division: file-context git here, repo git
there.

**Language smarts (LSP)**: open a supported file and the daemon-managed
language server wires in — diagnostics, hover, completion, rename (F2),
go-to-definition (F12), code actions (⌘.), from rust-analyzer, clangd, gopls,
pyright, bash/typescript/yaml-language-server or marksman. The servers come
from the **mymux-pkg** package index (prewired entries: install from the
packages panel with one click; fallback to PATH-detected servers otherwise),
resolved managed-first. See `docs/LSP-PLAN.md` for the roadmap.

The daemon serves `/fs/*` and `/git/*` confined to a root (the pane's cwd, else
`MYMUX_ROOT`/cwd) — rejecting path escapes, with a CORS allowlist so only the
mymux UI can reach them.

## Processes (⌘K i)

Press **⌘K i** (or the `ps` button) for a scoped mini-htop: every window → pane →
its process subtree (rooted at each pane's shell pid, including `⌁` shells), with
live %CPU, memory and state. Hover a row and click **✕** to kill that process —
**⇧✕** for SIGKILL. Kills are **scoped**: the daemon only signals a pid it can
prove is inside a pane's subtree (never by name), so the dashboard can't take
down arbitrary processes. It reads `/proc` directly (Linux) and serves
`/proc/tree` + `/proc/kill` behind the same CORS allowlist as the code panel.

## Ephemeral shells (⌘K n)

Not everything needs tmux. Press **⌘K n** for a raw,
non-tmux shell in its own top-level tab (marked `⌁`, dashed) — ideal for quick
throwaway commands without nesting inside a persistent agent session. Like all
native panes it lives in mymux-ptyd: it inherits the focused pane's cwd (with
`$TMUX` stripped, so you can even nest a tmux in it), **survives a disconnect**,
and reconnects/tab switches restore a **faithful terminal snapshot** — colors,
cursor, alternate screen (vim & co.) and recent scrollback — from a server-side
terminal grid. The one thing that separates it from `∞` is fate: ptyd kills it
the moment its mymuxd goes away (by design — "ephemeral" is just a flag now).
Close it like any pane.

## Persistent shells — the default window (⌘T / +win)

**New windows are persistent native shells now.** Press **⌘T** (the `+win`
button, or ⌘K t) for a native shell that **survives mymuxd
restarts**: its PTY and terminal grid are held by **mymux-ptyd**, a tiny
companion daemon that changes rarely (installed and started by
`scripts/install-systemd.sh`; mymuxd can also bootstrap it on demand). Deploy or
crash mymuxd all you like — on the next start it re-adopts these tabs, full
screen state included. Tabs are marked `∞` (violet). The contract mirrors tmux's
server: panes die only if **ptyd itself** stops, so the installer never restarts
a live ptyd — do that yourself when idle. tmux windows remain available behind
**⌘K u** — the tmux engine is kept, not retired; native is simply the default.

**Escape hatch**: from any plain SSH shell, `mymux-attach` lists persistent
panes and `mymux-attach <id>` attaches — faithful snapshot first, then live
bytes; `Ctrl-\` detaches, the pane keeps running. The equivalent of
`tmux -L mymux attach` for the native engine, for the day the app is out of
reach. Persistent panes also show up in the ⌘K i process tree (marked `∞`) with
scoped kill.

**Splits work too** (⌘D / ⌘R), tmux-free, for `⌁` and `∞` tabs alike: mymuxd
is the layout engine — splits, collapse-on-close, ⌘⌥-arrow navigation, zoom
(⌘K m), pane swap (⌘K , / ⌘K .) and break-out-to-window (⌘K b) are computed
natively, and the layout tree (zoom included) rides along in ptyd next to the
panes it describes. Kill and restart mymuxd and a persistent window comes back
whole: grouping, geometry, focused pane, every pane's scrollback.

More daily-driver guardrails: an `⌁` shell you decide to keep promotes to `∞`
in place with **⌘K k** (nothing restarts — the flag flips, the pid and
`MYMUX_PANE` stay); closing a pane whose shell is running something (vim, an
agent, a build) asks first instead of killing it blind; **⌘= / ⌘- / ⌘0** zoom
the terminal font (browser: ⌘K =/-/0; iTerm-style, per-device, applied live
to every pane — the settings panel has the same stepper); and **⌘K /** shows
the key map.

**Unlimited history**: every native pane's raw output (colors included) is
also appended to `~/.local/state/mymux/history/<id>-<pid>.log` — 64 MB plus
one rotated sibling per pane, `MYMUX_HISTORY=0` to opt out. In-app scrollback
stays fast and bounded (10k lines live, 2k after a reseed). When you need
older output **in the app**, scroll a pane to its very top and click the
**⇧ older output** chip: a read-only pager overlays the exact history log
(plain text, ANSI stripped; scroll up to page further back), Esc closes.
For the full text with colors, `less -R $(mymux-attach hist <id>)` — logs
survive their panes, mymuxd, and even ptyd restarts. Bare `mymux-attach hist`
lists everything.
