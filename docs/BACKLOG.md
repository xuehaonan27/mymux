# mymux backlog (later polish)

Deferred refinements — captured so we don't lose them. Not blocking.

## LSP + editor adaptation batch (parked 2026-07-03 — mainline first, user's call)
Deferred until the mainline (native engine, …) is mostly done; several items are
really arguments for the self-built editor/LSP client (see LSP-PLAN's absorption
principle):
- Compiler-tier diagnostics: send `textDocument/didSave` on ⌘S + scheduled
  post-save re-pulls (cargo check takes seconds); real `workspace/diagnostic/
  refresh` handling needs a lib fork or the self-built client.
- **Dirty-file lock**: with unsaved changes you can't open another file —
  suspected root cause: `window.confirm()` is a no-op/falsy in the Tauri v2
  webview, so the discard prompt can never be accepted. Verify; fix = async
  in-panel confirm, or better: per-file buffers (multi-buffer lite).
- Multi-file buffers + tabs in the code panel (editor architecture).
- General editor ergonomics pass (user: "有点难用" — collect concrete complaints).

## Code panel (M4)
- **Editor ergonomics pass** — the user finds the editor "有点难用" (2026-07-03,
  deferred by their call); collect concrete complaints and address as a batch.
- Lazy-load CodeMirror (dynamic `import()` on first ⌘E) to shrink the initial bundle.
- Side-by-side (split) diff view, in addition to the unified one.
- File-tree search / fuzzy open (⌘P).
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
2. Persistent native panes: same engine + restart survival — design fork to
   settle: a tiny `mymux-ptyd` holder process (our own client/server split)
   vs systemd FD store (single process, fd + serialized grid across restarts).
3. Native splits/layout (the layout tree is already ours) + a `mymux attach`
   CLI escape hatch (today `tmux -L mymux attach` is the rescue path — keep an
   equivalent).
4. New windows default to native; tmux engine kept for a transition, then removed.
Honest counterweight: no acute pain forces this — drivers are strategic (own the
stack; per-window sizes; multi-client semantics; kill the control-mode boundary
that caused most historical bugs).

## Multi-host — SHIPPED 2026-07-03; remaining polish
- ~~Remember open hosts~~ → the manager now boots into last time's host
  (passphrase prompt pre-opened); remembering the full multi-host set is still open.
- ~~Per-host reconnect banners~~ → done (in-workspace banner when its WS drops).
- Chip overflow behavior for many hosts (scroll / compact mode).

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
- Tighten the daemon's HTTP surface (per-session token in addition to the CORS allowlist).
- M2.2: unify the `cargo tauri dev` vs `npm install` working directories.
