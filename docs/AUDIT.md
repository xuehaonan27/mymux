# mymux structural audit — 2026-07-17

Method: five parallel read-only audits over (1) client state routing &
app-global panels, (2) daemon hub & ws protocol, (3) ptyd protocol & terminal
grid, (4) Tauri connect layer & install flows, (5) client input/render core.
Every finding verified against code at the time; two client behaviors probed
live in Chromium. Severity: P0 corruption/security · P1 user-visible
wrongness · P2 leaks/papercuts · P3 maintainability.

## Fixed in the audit batch (same commit window)

| Finding | Sev | Fix |
|---|---|---|
| Agent-hook payloads uploaded to a literal `./$HOME/…` dir (single-quoted target) — claude/codex/kimi hooks "installed" but broken; opencode XDG mismatch | P0 | Double-quote target (expands `$HOME`), `test -x` sanity, XDG-fallback path aligned (`crates/mymux-connect/src/agenthook.rs`) — verified with an exact-string bash repro |
| Tunnel **Cancel** left the workspace retrying the freed port; the next host to bind it got a zombie talking to the wrong daemon | P0 | Cancel now calls `hooks.onDisconnected` like Disconnect (`ui/src/hostmanager.ts`) |
| Resize while a TUI owns the alt screen: avt reflows only the active buffer, next reseed dumped the stale-width primary (wrap-junk frames — the daily vim-resize corruption) | P1 | `PaneGrid` defers a primary reflow to the alt→primary flip (`crates/mymux-ptyd/src/grid.rs` + test `resize_in_alt_reflows_primary_on_exit`) |
| Snapshot prefix left client DECOM/scroll-region live — reseeds into region-using TUIs painted offset/clamped frames | P1 | Prefix now emits `\x1b[?6l\x1b[r` (`grid.rs`) |
| One oversized frame (>8 MiB) could kill the ptyd connection — dense truecolor history in one snapshot; giant pastes | P1 | History replay capped to newest ~4 MiB (`grid.rs`); ws client input chunked ≤1 MiB (`crates/mymuxd/src/ws.rs`) |
| Adoption treated transient `list`/`get_meta` failures as truth and **persisted the empty view**, wiping the layout blob | P1 | Adoption commits only on a full read; failures drop the connection and retry (`crates/mymuxd/src/persist.rs`) |
| SSH connect had no timeout (blackholed SYN / banner-silent listener hung "Connecting…" forever) | P1 | 20 s timeout around the handshake (`crates/mymux-connect/src/russh_tunnel.rs`) |
| Daemon update had no rollback — new binary failing to start left the host broken | P1 | Installer backs up prev binaries, restores + restarts on failed boot check (`scripts/mymux-install-remote.sh`) |
| tmux `%exit` None branch left stale model + spent bootstrap (ghost windows for the next client) | P2 | Model reset + `booted` cleared (`crates/mymuxd/src/tmux.rs`) |
| pkgs panel host-scoped but not swapped/closed on host switch (installed-state from host A, Install hits host B) | P1 | Closed on switch (`ui/src/main.ts switchTo`) |
| Zero workspaces left: host-scoped panels kept polling the `8088` fallback; proc could SIGKILL a same-numbered pid on the wrong daemon | P1 | `endWorkspace` closes code/git/proc/hist/pkgs before showing the manager |
| Keystrokes with the history pager open leaked into the live pty (and yanked it to bottom) | P2 | Pager panel is focused on open (`ui/src/termhist.ts`) |
| Closing overlays never returned focus — hidden editors kept `document.activeElement` and swallowed typing (Chromium-probed) | P2 | `refocusActive()` on modal-Esc and code-close paths (`ui/src/main.ts`) |
| `STYLE` boot-snapshot: hosts connected after a theme/font-zoom boot looked stale until next pref edit | P2 | `ensureWorkspace` re-applies theme + font size at construction (`ui/src/main.ts`) |

## Open / deferred (by design decision or effort-gated)

| Finding | Sev | Notes / smallest fix |
|---|---|---|
| Two clients, two viewport sizes: hub-global `last_size` → resize ping-pong every ~1.5 s; `Refresh` reseeds broadcast to all clients | P2 | Designed "one shared view". Cheap dampers: idempotent resize early-return (`tmux.rs:489`), gate client nudge on `visible` (`workspace.ts:631`). Lease-based ownership = larger design. |
| ptyd connection `Closed` → engine degrades silently until an unrelated pane spawn re-ensures | P1 | Spawn a background `ensure()` retry (2 s) from `persist_disconnected` (`tmux.rs:1500-1517`). Byte-budget half now fixed. |
| First-paint duplication window on (re)connect/attach (bytes inside snapshot also delivered live) | P3 | Self-healing by design; only clean cure is per-grid seq numbers. Documented. |
| ptyd→mymuxd Exit events lossy on broadcast lag (ghost panes until reconnect) | P3 | Periodic mirror reconcile vs `List`, or a reliable per-conn exit channel. |
| Agent/heuristic entries for dead tmux panes never pruned (endless 2 s `pane_pids` subprocess) | P3 | Drop entries absent from the fresh pids map in `run_heuristics`. |
| `bootstrap_ptyd` stale-socket unlink race (two ptyds, one unreachable) | P3 | Check `systemctl --user is-active` before unlinking/extend poll. `ptyd` bind-first probe ordering (`ptyd main.rs:69-73`). |
| Old ptyd silently drops unknown ops (e.g. `SetEphemeral` demote intent inverted) | P3 | Error frames for unknown ops; version word in handshake. |
| ws client `pending` map holds timed-out RPCs until disconnect | P3 | Remove on timeout. Slow-client stalls: none (verified per-conn send task + 4096 rings). |
| Quick-open `/git/files` populate and `jumpToToken`/`openAt` can apply across a mid-flight host switch; repo auto-jump guard keys bare pane ids | P3 | Capture scope at schedule time and re-check before applying (code.ts, main.ts). Transient & self-healing today. |
| `resolve_bundle_bytes` lane selection wrong (x86_64 embedded fallback unreachable; airgap=embedded lane never falls back on download failure) | P2 | Rewrite fallback selection + embedded fallback on download error (`russh_tunnel.rs:512-547`). |
| Release dmg embeds committed `bundles.json` with no CI drift guard | P2 | CI step failing the dmg job when the manifest ≠ the tag's daemon artifacts. |
| Version audit is raw string equality — a NEWER remote daemon is flagged "outdated" and downgraded | P2 | Parse `mymuxd X.Y.Z (<sha>)`, flag only strictly older (`russh_tunnel.rs:582-586`). |
| `load_secret_key` collapses every failure into AuthFailed | P2 | Distinguish unreadable key vs server rejection. No agent fallback in russh path — document. |
| Forwarder bind failure retries the cached port forever (TOCTOU between probe and bind) | P2 | Bind in `connect()` and pass the listener in; or evict + realloc after N bind failures. |
| Deferred heal timers (ghost/nudge/refresh) stack on rapid switches — duplicate refresh requests | P3 | Generation tokens per `applyLayout` swap. |
| `passphrase` held in memory for app lifetime (by design), no zeroize; `master_exec_inner` unbounded output accumulation | P3 | `zeroize` the Mutex String; cap output ~4 MB tail-keep. |
| Soft-wrapped history lines replayed as hard lines (`\r\n` after every styled_line row) | P3 | Needs `Line.wrapped` from avt — field is `pub(crate)` in 0.18; either upstream change or a different public signal. |
| Legacy algorithms (pre-2014 OpenSSH) unsupported by russh defaults | P3 | Intentional; document in host requirements. |
| Non-systemd hosts: `daemon_update` never restarts the running daemon | P3 | Restart detached path too, or surface "restart needed". |
| Zoom/unzoom discards sibling panes' xterm instances (client scrollback lost) | P2 | Hide instead of dispose while zoomed; dispose on true close (`workspace.ts:applyLayout`). |
| `termhist` pagination vs. concurrent rotation; `/tmp/mymux-agenthook.sh` predictable path; notify targets map growth; histWs stale workspace ref; sessions map unbounded growth | P3 | Awareness-level papercuts. |

## 2026-07-21 follow-up (Codex + Claude re-audits → fix batch)

Two independent re-audits (`docs/audit-codex.md`, `docs/audit-claude.md`,
baseline `88f142e`) found two stop-ships — `save()` could migrate one file's
editor state into another's buffer (P0-01/#24), and `/fs/write` followed a
final symlink out of its root (P0-02/#28) — plus ~50 further findings. All
were fixed in the 2026-07-21 batch (per-finding status in the two reports).
Status changes for THIS ledger's deferred rows:

| Ledger row | New status |
|---|---|
| ws client `pending` map holds timed-out RPCs | **Fixed** (ptyd `client.rs` evicts on timeout) |
| Forwarder bind failure retries the cached port (TOCTOU) | **Fixed** properly: the listener is pre-bound in `connect()` and owned by the tunnel task — the port is immutable |
| Version audit is raw string equality | **Fixed**: hand-rolled SemVer (pre-release/build); unparseable ⇒ no verdict |
| Release dmg embeds committed `bundles.json`, no drift guard | **Fixed**: verified artifact handoff in `release.yml` (version+sha256 must match the tag or the dmg job fails); tracked manifest updated |
| Zoom/unzoom discards sibling xterms | **Fixed** by the broader preserve design: native panes are hidden (still fed) across window/zoom switches — only authoritative Exit disposes; tmux panes re-seed faithfully (`capture-pane -S`) |
| Quick-open / `jumpToToken` / `openAt` mid-flight host switch | **Fixed** (per-session open generation + captured scope, `code.ts`) |
| ptyd connection `Closed` → engine degrades silently | **Still open** (background `ensure()` retry) |
| Old ptyd silently drops unknown ops | **Still open** (versioned handshake) |
| `bootstrap_ptyd` stale-socket unlink race | **Partially** addressed (peer-uid SO_PEERCRED check + per-UID 0700 socket dir + only-ours unlink); the two-process ordering race itself is open |

New still-open items from the 2026-07-21 reports: #26 save-vs-disk mtime
precondition (deferred by decision), #18 alt tracking from parsed state
(blocked on avt's public API), C-33 full streaming byte-tail ring (partial:
bounded runner + kill-on-drop landed), C-40 AST-level arg-shape guard,
`.gitea/workflows/release.yml` needs the P1-18 handoff mirrored, `/fs/write`
parent-dir TOCTOU (needs anchored dir handles / new dep).

## Verified solid (do not re-audit without cause)

- Per-connection ordering end-to-end (client ms → hub → tmux pipe / ptyd FIFO);
  slow-client isolation via per-conn send tasks; ws Lagged → full resync.
- Pane/window id monotonicity & adoption id reseeding; kill/exit dedup;
  unknown-id no-ops on every hop; mirror reconcile tests.
- Bundle integrity chain (manifest sha256 → upload atomic → remote sha256
  re-check); ptyd-restart-free update semantics; uninstall exact-path safety.
- Secret handling: no passphrase on disk/logs/errors; key file decrypt in-app
  only; TOFU known_hosts incl. hashed entries; KeyChanged hard refusal.
- Grid: UTF-8 carry, alt tracking chunk-safe, snapshot grid-lock vs feeder
  thread; history writer single-owner, rotation bounds, pid-namespaced logs.
- `/fs`, `/git`, `/proc`, `/termhistory` confinement & clamps (`safe_path`,
  CORS/Origin allowlist, pid-subtree kill proofs).
- xterm side: per-pane teardown completeness (`term.dispose()` kills all
  listeners), re-created panes rewire everything (single `makePane` path),
  timers safe across destroy/hidden workspaces, IME shim unreachable during
  real compositions, modkey ordering, measureCell metric self-consistency.

## Method notes for the next audit

- The P0 hook-payload and Cancel-zombie classes were invisible to the stubbed
  UI checks — they live at the Rust/script layer, so audit passes must keep
  exact-string shell repros (see `crates/mymux-connect/src/agenthook.rs`
  history) alongside the `ui/ux/*check.mjs` suite.
- Sandbox every daemon-touching check (own `MYMUX_PTYD_SOCK` + `MYMUX_SOCKET`
  + port): shared-daemon pollution caused multiple false failures this week.
