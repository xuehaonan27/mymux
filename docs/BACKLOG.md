# mymux backlog (later polish)

Deferred refinements — captured so we don't lose them. Not blocking.

## Plugin system (contract-first; decoupled per the user, 2026-07-03)
Strategy decided with the user: no general-purpose plugin platform up front
(single-user product — no author ecosystem to serve, and "lightweight" is the
identity); instead, REAL extension points behind a public on-disk contract
(docs/PKG-SPEC.md), producer and consumers fully decoupled (zero shared code).
Ecosystem boundary (user-ratified): **Open VSX usable in full; the VS
Marketplace and Microsoft's proprietary extensions (Pylance, C/C++, Remote,
Copilot) are NEVER touched** — enforced by a unit test in mymux-pkg.
- ~~P1: managed language servers~~ — **DONE 2026-07-03**: `mymux-pkg` CLI
  (install/list/remove; channels: pinned GitHub releases + sha256 from the
  release digests, `go install` (Go sumdb), npm (registry integrity), and an
  Open VSX channel implementation held in reserve; recipes: rust-analyzer
  2026-06-29, clangd 22.1.6, gopls, pyright 1.1.411). mymuxd resolves
  managed → PATH-heuristic-fallback, `POST /lsp/install` runs the CLI
  (sibling binary), the code panel offers one-click installs, and go/python/
  c/cpp roots + server commands are wired. Verified: real installs
  (rust-analyzer, pyright incl. through a stripped-PATH daemon via the nvm
  fallback), managed resolution beats a stripped PATH, install endpoint
  round-trip, LSP e2e regression green.
- ~~P2: viewer registry~~ — **DONE 2026-07-03** (image + hex built-ins): UI
  `viewers.ts` registry whose interface mirrors the future `kind:"viewer"`
  package shape; daemon `GET /fs/raw` (MIME by extension, `limit` for
  prefixes, `X-File-Size`, 50 MiB cap, safe_path). Binary/too-large files now
  render (images inline with dimensions + transparency checkerboard; anything
  else hex-dumps its first 4 KiB); the placeholder only remains for real
  errors (404 …). Markdown PREVIEW deliberately deferred: needs a sanitizer
  chain to be XSS-safe in the Tauri webview, low value while md is editable.
- ~~Dynamic sources (no more hardcoded-only recipes)~~ — **DONE 2026-07-05**:
  `mymux-pkg search` (curated + Open VSX API + npm registry, network from the
  daemon host), `install openvsx:ns.name[@ver]` / `install npm:pkg[@ver]`
  (auto bin detection → `lsp-server`), `lang <pkg> <lang…> -- <launch args…>`
  binding, manifest `args`/`spec`/`sha256` fields, daemon `GET /pkgs/search`
  + spec-tolerant validation, packages-panel search box with source badges,
  managed LSP resolution for ANY bound language id + augmented spawn PATH
  (nvm node under systemd). Verified: real bash-language-server session
  (search → install → bind → hover) end-to-end through the daemon.
- P2.5 (optional): TextMate grammars/themes from Open VSX for CodeMirror
  highlighting of languages we don't bundle (vscode-textmate/shiki route).
- P3 (only if ever needed): third-party loading (JS/WASM). Revisit after P2;
  an `agent-adapter` kind is the uniquely-mymux extension point if an
  ecosystem ever happens.
- **License choice for the repo is still open** (currently workspace says MIT
  in Cargo.toml but no LICENSE file / conscious decision). If open-sourcing /
  commercializing, decide BEFORE external contributors arrive (MIT/Apache +
  hosted, BSL/FSL, AGPL dual — user to pick).


## LSP + editor adaptation batch (parked 2026-07-03 — mainline first, user's call)
Deferred until the mainline (native engine, …) is mostly done; several items are
really arguments for the self-built editor/LSP client (see LSP-PLAN's absorption
principle):
- ~~Compiler-tier diagnostics~~ — **DONE 2026-07-03**: the ONLY missing link
  was the `textDocument/didSave` trigger (standard LSP, sent by
  `notifySaved()` after a successful ⌘S write). Channel model, verified
  end-to-end against real rust-analyzer: NATIVE tier = pull (our
  `pullDiagnostics()` seam plugin); COMPILER tier (cargo check) = runs on
  didSave, results arrive as `publishDiagnostics` PUSHES which the library's
  built-in `serverDiagnostics()` handler already renders. Without didSave,
  flycheck ran exactly once at open — which is why edited-in errors never
  appeared. A small post-save re-pull burst covers native-tier refreshes
  (the server's `workspace/diagnostic/refresh` is still unreceivable —
  absorbed into the self-built client's design).
- ~~**Dirty-file lock**~~ + ~~multi-file buffers + tabs~~ — **DONE 2026-07-03**
  by sidestepping the prompt entirely: every opened file keeps its own Buffer
  (doc + undo history + selection) in the per-pane session; opening another
  file stashes the current one instead of discarding, dirty buffers restore
  as-is, clean ones re-read the disk (agent edits show up; unchanged content
  keeps its undo history). Buffer chips under the header switch/close files
  (dirty ✕ = two-click confirm, mouse-only per house rules). `window.confirm`
  is gone from the codebase — never verified in Tauri because nothing asks
  anymore.
- General editor ergonomics pass (user: "有点难用" — collect concrete complaints).

## Code panel (M4)
- **Editor ergonomics pass** — the user finds the editor "有点难用" (2026-07-03,
  deferred by their call); collect concrete complaints and address as a batch.
- ~~Lazy-load CodeMirror~~ — DONE (QoL batch 2026-07-03; main bundle 365 KB).
- Side-by-side (split) diff view, in addition to the unified one.
- ~~File-tree search / fuzzy open (⌘P)~~ — DONE (QoL batch 2026-07-03).
- Navigate above the pane root; a root switcher (pane cwd / repo root / custom).
- Configurable default root: pane cwd vs project/working dir (once agents expose their working dir).
- Clean up the untracked-file diff header (currently shows an absolute path).
- Staged vs unstaged diff toggle; jump from a diff to editing that file inline.

## Agents (M3)
- Codex `notify` snippet + a real end-to-end test.
- Per-window "since" / last-activity, shown in a tooltip.

## Connectivity (M2)
- Tauri `SSH_ASKPASS` passphrase dialog — a fallback for a passphrase-locked key
  when there's no agent (the agent path is preferred, so this is only a safety net).
- Surface connection status + the "load your key" guidance *inside the app
  window*, not just on stderr (which a Finder-launched app hides).
- Optional: a dedicated persistent ControlMaster (separate from the forward) so a
  forward restart never re-auths even without an agent.

## Replace tmux with a native engine — declared endgame (2026-07-03)
Since external-tmux interop is rejected, tmux is a pure implementation detail —
replacing it is coherent. Strangler-fig path (each step ships alone, no big bang):
1. ~~**Server-side grid for ephemeral panes**~~ — **DONE 2026-07-03**
   (`crates/mymuxd/src/grid.rs`: avt-based `PaneGrid`; faithful reseed with
   colors/cursor/alt-screen + styled scrollback history; UTF-8 carry decoding).
2. ~~Persistent native panes: same engine + restart survival~~ — **DONE
   2026-07-04** via the `mymux-ptyd` fork of the design (chosen over systemd
   FD store): `crates/mymux-ptyd` holds PTYs + grids behind a unix-socket
   protocol; mymuxd bootstraps it, adopts survivors on startup, and routes
   `PERSIST_BIT` ids to it. Verified: panes survive a SIGKILL'd mymuxd with
   full grid state.
3. Native splits/layout (the layout tree is already ours). ~~`mymux attach`
   CLI escape hatch~~ — **DONE 2026-07-04** (snapshot + raw bridge, Ctrl-\
   detaches, list mode; installed by install-systemd.sh). ~~agent/proc-tree
   integration for persistent panes~~ — **DONE 2026-07-04** (∞ panes in
   /proc/tree + scoped kill; agent badges already worked via MYMUX_PANE).
   ~~Splits/layout for persistent windows~~ — **DONE 2026-07-03** (option 1:
   mymuxd owns layout semantics in `crates/mymuxd/src/native.rs` — split with
   same-direction flattening, collapse-on-close, proportional resize,
   geometric ⌘⌥-arrow navigation; ptyd stores the serialized tree as an
   opaque `SetMeta`/`GetMeta` blob so layout and panes share fate; adopted
   and reconciled on reconnect. UI unchanged — it already spoke layout
   trees. E2E: 3-pane window survives a SIGKILL'd mymuxd with tree, focus,
   names and scrollback intact). ~~Migrate ephemeral panes onto ptyd~~ —
   **DONE 2026-07-03**: ephemeral is now just a Spawn flag; ptyd tracks the
   spawning connection per pane and kills its ephemeral panes when that
   connection drops (so ⌁ still dies with mymuxd, verified down to the shell
   pid), mymuxd sweeps EPH_BIT survivors on reconnect (old-ptyd fallback),
   in-process pty.rs is deleted, and ⌁ tabs gained splits + attach (`ls`
   marks ⌁/∞). **Step ③ complete.**
4. ~~New windows default to native~~ — **DONE 2026-07-03** (`+win`/⌘T/⌘K c →
   persistent native; the redundant `+psh` button is gone; tmux windows live
   behind ⌘K w; native-view cwd inheritance via `/proc/<pid>/cwd`; grid
   scrollback 1000→2000 to match tmux's default). **DECISION (user,
   2026-07-03): the tmux engine is KEPT long-term, not retired** — native is
   the default, tmux stays as a supported secondary engine (interop escape
   hatch, battle-tested fallback). No engine-removal step.
Honest counterweight: no acute pain forced this — drivers are strategic (own the
stack; per-window sizes; multi-client semantics; kill the control-mode boundary
that caused most historical bugs).

## Persistent shells as first-class citizens — polish track (2026-07-03)
Native ∞ windows are the default; keep closing the gap to a great daily driver:
- ~~Zoom pane~~ — **DONE 2026-07-03** (⌘K z: full-leaf state + `zoomed` flag,
  auto-unzoom on any layout op, persisted in the blob, `resize-pane -Z`
  passthrough on tmux views).
- ~~Swap panes~~ / ~~break-pane~~ — **DONE 2026-07-03** (⌘K { } trades
  rectangles with the layout-order neighbour, focus follows the shell;
  ⌘K ! breaks a pane out into its own window; tmux passthroughs).
- ~~Promote ⌁ → ∞~~ — **DONE 2026-07-03** (⌘K k "keep this shell"): the kind
  TRUTH moved from the id bit to an explicit flag (ptyd `SetEphemeral` +
  `PaneInfo.ephemeral`, mirror `PaneMeta`, state/proc/attach all read the
  flag; ids and MYMUX_PANE stay put). Verified across a restart.
- ~~Close confirmation~~ — **DONE 2026-07-03**: `close_pane` without `force`
  checks the shell's foreground group (`/proc` tpgid vs pgrp) and emits
  `confirm_close` instead of killing; inline mouse-only bar in the UI. Works
  for native and tmux panes.
- ~~Help overlay~~ — **DONE 2026-07-03** (⌘K ?, static keymap card,
  click-to-dismiss — Esc stays inert by design).
- Rearrange tabs (custom window order, drag) — needs an order model beyond
  BTreeMap id order + tmux/native interleaving rules.
- Drag the split divider to resize panes (UI + a `resize_leaf` verb).
- ~~Unlimited history~~ — **DONE 2026-07-03** via raw per-pane output logs in
  ptyd (`$XDG_STATE_HOME/mymux/history/<short>-<pid>.log`, ANSI included,
  64 MB cap + one rotation, `MYMUX_HISTORY=0` opt-out, `MYMUX_HISTORY_CAP`
  tunable; `mymux-attach hist [pane]` locates the files — numeric lookup
  works without ptyd, and logs outlive panes/ptyd). In-app paging of older
  scrollback stays blocked on xterm.js prepend; the log is the answer until
  a self-built renderer exists.
- Alt-screen/agent heuristics for native panes (ptyd could report alt state
  with output events; hooks already cover claude/codex).

## Multi-host — SHIPPED 2026-07-03; remaining polish
- ~~Remember open hosts~~ — **DONE 2026-07-03** (full-set restore):
  `mymux.openHosts` tracks every connected host (updated on connect and on
  workspace end); at boot the host manager guides through the whole set one
  passphrase at a time (chained showConnect after each `connected`), cards
  show a ↻ badge, "← hosts" bails out of the guide. Legacy `mymux.lastHost`
  is read as a fallback.
- ~~Per-host reconnect banners~~ → done (in-workspace banner when its WS drops).
- ~~Chip overflow behavior~~ — **DONE 2026-07-03**: the host bar scrolls
  horizontally (thin scrollbar, chips don't shrink) and the active chip is
  kept in view on switch.

## Attach to an existing tmux session — decided against (2026-07-03)
mymuxd only drives its own socket + session (`tmux -L mymux … -s mymux`). Cleanly
attaching to a user's pre-existing tmux (default socket) would inherit *that*
server's config (no truecolor conf), couple sizes with other attached clients,
and break the one-session-per-control-client model — not worth it; a standalone
tmux stays standalone.

## Pane-granular attention — DONE 2026-07-03
`WinMsg.agent_pane` carries the pane holding the window's agent state; ⌘J sends
`focus{pane}` after `select_window`, so keyboard focus lands on the agent's pane.
**Requirement to preserve when the native engine/protocol replaces tmux.**

## Settings / user profile (started minimally)
- DONE: client-side prefs in localStorage (`mymux.prefs`), first setting "always
  show the host bar" as a checkbox in the host manager.
- Open: a proper persisted settings store + a real settings surface.

## Misc
- ~~Tighten the daemon's HTTP surface~~ — **DONE 2026-07-03** via an Origin
  guard, which fits the actual threat model better than a token: the daemon
  binds 127.0.0.1 and same-uid local processes are out of scope (they could
  attach ptyd directly), so the real hole was BROWSER pages — CORS never
  stopped requests (only response reads), and WebSockets have no CORS at
  all, letting any web page open /ws and type into terminals. Now every
  request carrying an Origin header must match the UI allowlist (403
  otherwise); no Origin = local tool = pass. Verified: evil-origin HTTP 403 +
  WS rejected, allowlisted/absent Origin pass. A full per-session token adds
  nothing within this model — dropped deliberately.
- M2.2: unify the `cargo tauri dev` vs `npm install` working directories.
