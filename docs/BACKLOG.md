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

## Misc
- Tighten the daemon's HTTP surface (per-session token in addition to the CORS allowlist).
- M2.2: unify the `cargo tauri dev` vs `npm install` working directories.
