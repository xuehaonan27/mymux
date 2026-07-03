# mymux backlog (later polish)

Deferred refinements — captured so we don't lose them. Not blocking.

## Code panel (M4)
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

## Multi-host (planned, not started)
One app connected to several hosts at once. Phases:
- **A. Tunnel layer** — `run_russh_tunnel` accepts `local_port: 0` and reports the
  bound port (extend `Status::Connected` or the event payload). `src-tauri`
  `ConnState` becomes `HashMap<host_id, Active>`; `connect(host_id)` no longer
  tears down other tunnels; add `disconnect(host_id)` + `conns_list()`; the
  `mymux:status` event carries `host_id`.
- **B. UI workspaces (the bulk)** — fold `main.ts`'s module globals
  (ws/panes/windowList/activePane/…) into a `Workspace` class, one per host,
  each with its own `ws://127.0.0.1:<port>/ws`; parameterize the code/proc
  panels' API base (currently a hard-coded `:8088`). A top-level host strip in
  the bar (chips / ⌘⇧1-9) switches the visible workspace; background ones stay
  connected.
- **C. Cross-host agent aggregation** — the bar sums waiting/done across all
  connected hosts (the real payoff of multi-host).
- **D. Polish** — per-host reconnect banners, remember open hosts in hosts.json.

## Attach to an existing tmux session — decided against (2026-07-03)
mymuxd only drives its own socket + session (`tmux -L mymux … -s mymux`). Cleanly
attaching to a user's pre-existing tmux (default socket) would inherit *that*
server's config (no truecolor conf), couple sizes with other attached clients,
and break the one-session-per-control-client model — not worth it; a standalone
tmux stays standalone.

## Misc
- Tighten the daemon's HTTP surface (per-session token in addition to the CORS allowlist).
- M2.2: unify the `cargo tauri dev` vs `npm install` working directories.
