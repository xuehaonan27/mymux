# mymux backlog (later polish)

Deferred refinements — captured so we don't lose them. Not blocking.

## Plugin system (contract-first; decoupled per the user, 2026-07-03)
Strategy decided with the user: no general-purpose plugin platform up front
(single-user product — no author ecosystem to serve, and "lightweight" is the
identity); instead, REAL extension points behind a public on-disk contract
(docs/PKG-SPEC.md), producer and consumers fully decoupled (zero shared code).
Ecosystem boundary (updated 2026-07-15): **the Visual Studio Marketplace and
Microsoft's proprietary extensions (Pylance, C/C++, Remote, Copilot) are NEVER
touched** — enforced by a unit test in mymux-pkg. **The Open VSX channel was
REMOVED 2026-07-15** (user's call after a sober look at the fit): the boundary
(never run VS Code extension-host code) capped the consumable surface at
declarative assets — grammars/themes/snippets — the ecosystem's minority and
least-maintained slice, while everything mymux actually wants (language
servers) ships independently via GitHub releases / npm / go modules anyway.
Dynamic installs keep the npm channel only. mymux's ecosystem is its own: the
data index + the on-disk contract + mymux-native kinds (viewer, agent-adapter…).
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
- ~~Index-ification (the ecosystem seed)~~ — **DONE 2026-07-05** (user
  ratified the layered ecosystem model: channels → capability manifests →
  data index → mymux-native extension points; no extension-host compat,
  ever). `index/index.json` (repo root, embedded at build, `$MYMUX_INDEX` /
  `<config>/index.json` overlay merged over it) replaces the hardcoded
  recipe Vec entirely. Entries are PREWIRED: `install <name>` lands langs +
  launch args in the manifest — no `mymux-pkg lang` step. Channel types
  incl. new `github-bin` (raw release binary) and npm `extras` (companion
  packages). Starter set: rust-analyzer, clangd, gopls, pyright,
  bash-language-server, typescript-language-server(+typescript),
  yaml-language-server, marksman — every entry live-verified (install +
  LSP initialize probe). Unit tests validate the index and enforce the
  ecosystem boundary over its content; catalog/search/UI show friendly
  titles.
- ~~Open VSX as an acquisition channel~~ — **REMOVED 2026-07-15** (user's
  call; see the boundary note above). Deleted: the `openvsx:` install spec
  and the `openvsx` index channel type, VSIX fetch/extract
  (`install_openvsx`, `vsix_provides`, `download_unpinned`), the search
  integration + verified badge + VSIX disclaimer in the panel, and the
  `provides`/`runtime_code` manifest fields (old manifests still parse —
  consumers are serde-lenient). Fallback for a hypothetical VSIX-only
  server: an index entry pointing at its upstream GitHub/npm source instead.
- P2.5 (demand-driven): syntax highlighting for languages CodeMirror doesn't
  cover. DECIDED 2026-07-15: the TextMate-grammar-from-a-registry pipeline
  (vscode-textmate/shiki + oniguruma WASM + a CM bridge) is REJECTED — too
  much machinery and fidelity loss for a single-user product. Route instead:
  `@codemirror/lang-*` official packages and `legacy-modes` from npm, added
  one language at a time when a real file type actually shows up unhighlighted.
- P3 (only if ever needed): third-party loading (JS/WASM). Revisit after P2;
  an `agent-adapter` kind is the uniquely-mymux extension point if an
  ecosystem ever happens.
- ~~License choice~~ — **DECIDED 2026-07-05: MIT** (LICENSE file at the repo
  root; workspace Cargo.toml already declared MIT).


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
- ~~Agent attention notifications~~ — **DONE 2026-07-15**: a `bell` toggle in
  the bar arms system-level alerts on TRANSITIONS into waiting/done while the
  app is unfocused (Tauri notification plugin in the desktop app — **Mac
  verify pending**; browser Notification API otherwise, which macOS browsers
  route through Notification Center). Click focuses mymux and lands on the
  agent's pane. Verified headless: transition/dedup/focus-suppression against
  a live daemon. Wiring shipped for the other two agents too: Kimi Code
  `[[hooks]]` (UserPromptSubmit/PermissionRequest/Stop) and an Open Code
  plugin (permission.asked/session.idle) — both now report precisely instead
  of leaning on heuristics.
- ~~Codex `notify` snippet + a real end-to-end test~~ — **DONE 2026-07-15**:
  install-codex-notify.sh writes `notify = ["…/mymux-codex-notify.sh"]`
  non-destructively; ui/ux/codexcheck.mjs drives the handler with a real
  Codex turn-complete payload against a live daemon and asserts the done dot
  lands on the tab (plus an unknown-type no-op case). One env lesson baked
  into the test: the reporter resolves TMUX_PANE first, so out-of-pane
  drivers must clear it.
- ~~Per-window "since" / last-activity, shown in a tooltip~~ — **DONE
  2026-07-15**: agent tabs' tooltips read `waiting|done for 3m · …` from the
  daemon's agent_since.
- ~~Native-pane heuristic nuance~~ — **FIXED 2026-07-15**: `run_heuristics`
  took its `active` set from the tmux model only, so a focused NATIVE pane
  could badge spuriously. The viewed set now spans engines (active native
  window's `visible_panes_of`, zoom-aware; active tmux window's panes).

## Connectivity (M2)
- ~~Zero dev-box pre-setup (stage 1)~~ — **DONE 2026-07-15**:
  `scripts/mymux-bootstrap.sh <host>` (run from the Mac) installs/upgrades
  mymuxd in one idempotent command: rsync'd prebuilts (`--bin-dir`, ELF-checked)
  or a source build on the box (`--with-rustup` when cargo is missing), systemd
  units best-effort, restart only when the installed state actually changed
  (verified against localhost: idempotent, no-op runs leave the daemon alone).
  The box-side half, `scripts/mymux-install-remote.sh`, is self-contained
  (embedded units) so the app can reuse it — see the zero-touch entry below.
- ~~Zero-touch daemon install from the app~~ — **DONE 2026-07-15**: the russh
  supervisor runs the same `scripts/mymux-install-remote.sh` (embedded via
  include_str!) over its own SSH when the daemon is missing (`exec_script` —
  channel exec + stdin pipe + output capture; exit-status read AFTER eof,
  which the throwaway-sshd integration test caught), surfaces an `installing`
  status in the host manager, then retries the connect. Tauri path **Mac
  verify pending**; crate side covered here by
  crates/mymux-connect/tests/exec_script.rs (temp-keys + throwaway sshd in a
  temp dir, never the user's real ssh setup). **UPDATED 2026-07-15 — source
  build → self-contained bundle** (triggered by a real failure: the box had
  no GitHub access, `git clone` exit 128): `scripts/build-daemon-bundle.sh`
  produces musl-static binaries + VERSION + SHA256SUMS
  (`src-tauri/resources/daemon/linux-x86_64.tar.gz`, git-ignored, sync to the
  Mac by hand), embedded via include_bytes! with a `daemon_bundle` cfg
  fallback (app without it still works; install reports why). The app probes
  the host's `mymuxd --version` (now carries the git rev via mymuxd/build.rs)
  against the bundle's VERSION: missing/mismatch/broken → upload (atomic
  `.new`→rename) → installer's bundle branch (sha256-verified, rename-over
  binary swap; **a running ptyd is never restarted** — persistent shells
  untouched, new ptyd code takes effect at its next manual restart). Source
  build stays as the installer's fallback branch. Verified: musl binaries run
  (static-pie), localhost bundle install (ptyd pid unchanged, idempotent),
  1 MiB binary-stdin roundtrip in the sshd test, clippy/tests green.
- ~~Tauri `SSH_ASKPASS` passphrase dialog~~ — **SUPERSEDED by M6**: the russh
  host manager takes the key passphrase IN the app (no ssh-agent in the
  picture at all), which was the point of the askpass fallback. Nothing left.
- ~~Surface connection status inside the app window~~ — **SUPERSEDED**:
  host-manager status lines (incl. `installing`), per-host reconnect banners,
  and UI toasts for daemon-reported errors (2026-07-15) cover it; the "load
  your key" guidance is moot — there is no agent to load keys into.
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
- ~~Rearrange tabs (custom window order, drag)~~ — **VERIFIED DONE 2026-07-15**
  (implemented earlier; the backlog entry was stale): UI drag handlers send
  `reorder_window`, the daemon owns one global `tab_order` for both engines
  and rides it in the ptyd blob. Harness check (ui/ux/dragcheck.mjs): drag
  reorders the DOM and the order survives a page reload.
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
- ~~M2.2: unify the `cargo tauri dev` vs `npm install` working directories.~~ —
  **DONE 2026-07-15** (root-caused on the Mac): the tauri CLI runs
  `beforeDevCommand`/`beforeBuildCommand` with cwd = the **frontend dir**, so
  `npm --prefix ui …` looked for `ui/ui/package.json`. The commands are now
  `ScriptWithOptions` with an explicit `cwd: "../ui"` (resolved against
  `dirs.tauri`, i.e. src-tauri) — deterministic no matter where `cargo tauri`
  is invoked from.
