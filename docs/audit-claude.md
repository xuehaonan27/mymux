# mymux bug audit — 2026-07-21 (Claude)

Follow-up to `docs/AUDIT.md` (2026-07-17). Method: eight parallel read-only
subsystem audits, every finding then re-verified by the orchestrator against the
actual code on **both** sides of each cross-layer claim (Rust ⇄ TS, and against
vendored `avt 0.18` / `portable-pty 0.9` source). Nothing here duplicates
`AUDIT.md`'s Fixed / Open-deferred / Verified-solid lists — this is what that
pass missed or what shipped after it (commits `9206ead..HEAD`).

Baseline is healthy: `cargo test` 79/79 green, `tsc --noEmit` clean, clippy only
cosmetic. Severity: **P0** corruption/security · **P1** user-visible wrongness ·
**P2** leak/freeze/papercut · **P3** latent/narrow-trigger.

Status: the daemon-core (Hub), connect-layer, code/LSP, git/pkgs, and
post-audit-regression audits were orphaned by a background-session transition
and have been re-dispatched; their findings will be appended. Everything below
is **verified real**.

## User-reported rendering bugs (Coding CLIs — Claude Code / Codex / Kimi)

Two symptoms the owner observed directly: after switching to another window/pane
and back, a Coding CLI's rendering (1) **loses part of the scrollback history**
above the viewport, and (2) **shows distorted colours** (things turn yellow/green).
Both were reproduced and root-caused to the reseed/snapshot path (not the live
render — live output is byte-faithful; only the on-switch re-seed is wrong):

- **Colour shift → finding #38.** avt's `vt.dump()` emits truecolor in colon
  sub-parameter form `\x1b[38:2:R:G:Bm`; the bundled xterm.js reads the 3rd
  sub-param as a colorspace id, so `RGB(10,200,30)` (green) renders as
  `RGB(200,30,0)` (orange). Fix: normalize the dump to semicolon form.
- **History eaten → finding #39.** `snapshot()`'s `\x1b[2J` erases the ≈`rows`
  newest history lines instead of scrolling them into scrollback — a full screen
  of backlog lost per switch. (tmux panes: `capture-pane` without `-S` loses
  *all* scrollback.) Fix: scroll into scrollback before clearing; add `-S` for
  tmux.

Both are P1, both carry a concrete fix + reproduction in the findings below.

---

## P1 — user-visible wrongness

### 1. Bind-failure port realloc never propagates — workspace stuck on a dead (or foreign) port
**Regression from `ceb328e`.** `crates/mymux-connect/src/russh_tunnel.rs:763-773`
handles `Status::BindFailed(held)` by picking a fresh port and continuing:
`cfg.local_port = p; backoff = min; continue;`. But the realloc closure is
`alloc_port_maps` (`src-tauri/src/lib.rs:86-101`) which **only reads** — it never
writes the new port back to `state.ports`, `Active.port` (set once at
`connect()` ~line 425), or `conns_list`. Status events carry no port. So the
tunnel task now serves on port `p`, while the UI keeps dialing the port it was
handed at connect time: `hostmanager.ts:544` (`attempt.port`), `:248` (Open
button `conn.port`), and the workspace WS URL `ws://127.0.0.1:<old>/ws`.

**Trigger:** any connect/reconnect cycle where the remembered local port was
taken during the down-window (exactly the case the commit describes). **Result:**
permanent "reconnecting…" banner while the host card shows Connected; worst case
the old port is now held by *another host's* tunnel or an older mymux instance,
so the workspace talks to the **wrong daemon** (the cross-daemon-zombie class
rated P0 elsewhere in this repo).

**Fix:** `alloc_port_maps` (or the realloc site) must write the new port into
`state.ports` + `Active.port` and emit it to the UI (extend the status event with
a port, or a dedicated `port_changed`); the UI must re-point its WS URL.

### 2. Transient progress notes sent as `Status::Error` terminate the connect attempt — zero-touch install opens no workspace
`russh_tunnel.rs:378-384`, `:390-396`, `:767-770` send *progress* notes
("mymuxd not answering … running the installer next", "forward port X is held —
retrying on fresh port Y", bind detail) as `Status::Error(msg)`, which serializes
as `{ "error": msg }`. But `ui/src/hostmanager.ts:626-628` treats **every**
`{error}` as terminal → `setStatus('error', …); settleAttempt();`, and
`settleAttempt` sets `attempt = null`. Every later status for this attempt then
hits the guard at `hostmanager.ts:569` (`if (!attempt || …) return`), so:
- the `installing…` message never shows,
- on the eventual `connected`, `hooks.onConnected` (`:574`) **never fires** — no
  workspace is created; the panel sits on a stale red error with the button
  re-armed.

**Trigger:** first connect to a fresh host with no daemon yet (the marquee
zero-touch flow). The install actually succeeds and the tunnel reaches Connected
in the background, but the UI shows a scary failure and opens nothing; the user
must click Connect again (which `teardown()`s the just-connected tunnel and
rebuilds). Same failure for the realloc note in #1.

**Fix:** send transient notes as `Status::Connecting`/`Reconnecting` carrying a
`why` (the `why` channel already exists — `hostmanager.ts:601-602`), and reserve
`Status::Error` for genuinely terminal failures; or make the UI not settle on
non-terminal error notes.

### 3. ptyd reader thread removes panes by id with no identity check — a lingering reader kills a new pane that reused the id
`crates/mymux-ptyd/src/main.rs:432-433`, on read EOF:
```rust
let _ = store2.panes.lock().unwrap().remove(&id);
let _ = store2.events.send(Ev::Exit { id });
```
No check that the map still holds *this* reader's pane. **Trigger chain:**
1. a shell has a backgrounded grandchild holding the pty slave fd (`nohup x &`, a
   daemonized agent helper — common); the pane is killed (ClosePane / owner
   disconnect sweep), removed from the map, but the reader stays blocked in
   `read()` because the slave fd is still open;
2. mymuxd restarts and resets its id counter from the **survivors** (persistent
   panes) in `persist.rs`, so the killed ephemeral pane's low id is free to
   reissue → a new pane gets the same full id;
3. the grandchild finally exits → the stale reader wakes and `remove(&id)`
   deletes the **new** pane, dropping its `Arc<Pane>` (→ SIGHUP/SIGKILL its
   shell) and broadcasting `Ev::Exit` — the user's new tab dies "for no reason".

Collateral during the lingering window: the stale reader's `Ev::Output{id}`
streams into the new pane's screen (text crosstalk); its grid + HistLog fd +
thread leak.

**Fix:** tag panes with a generation/`Arc::ptr_eq` identity and only remove if it
still matches; or have the reader hold a `Weak<Pane>` and compare on EOF.

### 24. `save()` snapshots the wrong buffer's editor state after its await — corruption that can write one file's content into another
`ui/src/code.ts:1202-1226`. `save()` captures `s = current`, `b = curBuf()`
(buffer A) and `doc` (A's content), `await fsWrite(…)`, then on success runs
`b.savedDoc = doc; b.dirty = false; b.state = editor.state;` (`:1212`) **with no
`current === s` re-check** — the lone post-await mutation in the file without that
guard (contrast `:882`, `:935`, `:1273`, `:1284`). The `EditorView` is shared, so
if the user switches to buffer B during the write window (dirty-restore is
synchronous → `editor.setState(B)`), `b.state` (buffer A) is set to **B's** state.

**Escalation to disk:** reopen A → clean → reads disk (A-content) →
`content === existing.savedDoc` (`:1275`) → `mount(existing.state)` mounts **B's
content** under path A; `isDirty()` then reports A dirty (editor doc B ≠ savedDoc
A); the next ⌘S writes **B's content into file A**. `notifySaved` (`:1215`) also
fires `didSave` for the wrong file. The write window is easily long enough over
SSH. **Fix:** snapshot `const savedState = editor.state` *before* the await and
assign that; guard the cosmetic header work on `current === s`.

### 38. Reseed shifts truecolor (green→orange etc.) — the "变黄变绿" on every switch-back — avt dump's colon-form SGR vs xterm.js
**User-reported, root-caused against the installed xterm.js.** Native panes are
reseeded from `PaneGrid::snapshot()` on every window/pane switch. The snapshot's
visible-screen portion is `avt`'s `vt.dump()`, which emits **truecolor in ITU
colon sub-parameter form** `\x1b[38:2:R:G:Bm` (verified in the snapshot bytes) —
*without* the colorspace-id slot. xterm.js's `_extractColor`
(`@xterm/xterm/lib/xterm.js`) reserves `accu[2]` for that colorspace id and reads
the color from `accu[3..5]`, so `38:2:10:200:30` parses to
`accu=[38,2,10,200,30,0]` → **`RGB(200,30,0)`** instead of `RGB(10,200,30)`. Every
truecolor cell in a reseed is shifted (its real R is dropped into the colorspace
slot, G→R, B→G, B→0): green becomes orange, etc. — exactly the yellow/green
distortion the user sees.

Why only after a switch: **live** output reaches xterm as the CLI's *raw* bytes
(semicolon form `38;2;R;G;B`, which xterm.js parses correctly), so colours are
right until the pane is re-seeded; the reseed (dump, colon form) is what shifts
them. The styled-history serializer already uses semicolon form (`sgr`/
`color_params`, grid.rs:298-303), so the two halves of one snapshot even disagree.
Coding CLIs (Claude Code / Codex / Kimi) use truecolor themes heavily, so they're
the visible victims. **Fix:** normalize the dump's `38:2:`/`48:2:`/`58:2:` colon
runs to semicolon form (`38;2;R;G;B`) before sending — universally unambiguous;
or insert the empty colorspace slot (`38:2::R:G:B`). Confidence **high**
(reproduced end-to-end against the bundled xterm.js parser).

### 39. Reseed eats ~a screenful of scrollback per switch — `\x1b[2J` erases the newest history lines
**User-reported ("超出渲染范围之前的历史被吞掉一部分"), root-caused with a
snapshot round-trip.** In `PaneGrid::snapshot()` (`crates/mymux-ptyd/src/grid.rs`)
the styled history replays `lines[..len-rows]` (all scrolled-off lines), then
emits `\x1b[0m\x1b[2J\x1b[H` (grid.rs:206) before `vt.dump()`. But feeding those
history lines into the client leaves the **last ≈`rows` of them in the visible
region** (they haven't scrolled into the client's scrollback yet); `\x1b[2J`
(Erase-in-Display) then **wipes them without pushing them to scrollback**, and the
dump only carries the truly-visible page. Net: the ≈`rows` most-recent history
lines vanish on every reseed.

Reproduced (30×4 grid, 12 colored lines): the replay was missing `L06,L07,L08` —
it jumped from `L05` straight to the visible `L09`. On a real ~50-row terminal
that is a **full screen of scrollback destroyed per window switch**, compounding
with each switch. **Fix:** scroll the leftover visible history into scrollback
before clearing — emit `\x1b[<rows>S` (or `rows` line feeds) after the history and
before painting the dump — instead of `\x1b[2J` erasing it. Confidence **high**.

_Related (tmux panes):_ `snapshot_pane` uses `capture-pane -e -p` **without
`-S`** (`tmux.rs:1234`), so a reseed of a tmux pane restores only the visible
screen — *all* scrollback is lost. Agents running in tmux windows (⌘K w) would
lose their entire backlog on switch-back. Same user-visible symptom, different
engine; fix by capturing with a scrollback start (`-S -<N>`).

---

## P2 — freezes, leaks, papercuts

### 4. Unclamped pane size reaches avt allocation — one bad resize OOM-aborts ptyd, killing every persistent shell
`crates/mymux-ptyd/src/grid.rs:54` (`PaneGrid::new`) and `:146` (`resize`) only
clamp the **lower** bound (`.max(1)`) — no upper bound. `Req::Resize`
(`main.rs:248-256`) and `Req::Spawn` pass `cols`/`rows` straight from the request
to `Vt::resize`, which reallocates `cols*rows` cells (~16 B each, ×2 buffers).
`cols=rows=65535` ⇒ ~137 GB ⇒ allocation failure ⇒ **abort ⇒ all panes in ptyd
die**. No clamp anywhere in the chain (UI fit → `ws.rs` → `tmux.rs:494` →
`persist` → ptyd → grid), and attach doesn't clamp either.

**Trigger:** a malformed WS resize; or — more realistically given this repo's
documented font-metric races (`88f142e`) — a fit-addon miscalc when a cell is
measured near-zero width during font loading, ballooning `cols`. Blast radius is
total, so this is high-severity despite the narrow trigger.

**Fix:** clamp at the ptyd entry (e.g. ≤1000×500) and add a second clamp on the
mymuxd side.

### 5. Blocking pty-master write inside the async connection loop freezes the whole ptyd connection
`main.rs:138-141`:
```rust
let mut w = w.lock().unwrap();
let _ = w.write_all(&body[4..]);   // blocking fd
```
The master writer is a blocking fd, and this runs directly in the connection's
`read_frame().await` loop. If the pane's foreground program isn't reading stdin
(`^S` flow-control, a busy TUI, a foreground `sleep`), the kernel pty input queue
(~4 KB) fills and `write_all` blocks **indefinitely**, stalling this tokio worker
— which is the loop that services *every* pane's input/Kill/Resize/Spawn on this
connection. The unsticking Kill travels the same jammed loop (only a second
connection, e.g. `mymux-attach`, can rescue it).

**Trigger:** paste >4 KB into a `^S`-frozen or non-reading pane. **Fix:**
non-blocking writer + per-pane input queue, or move writes to a dedicated
blocking thread (this is exactly what tmux does).

### 6. `Pane::drop` (SIGHUP + blocking grace + SIGKILL + `wait`) runs while the global `panes` lock is held
Every removal is `store.panes.lock().unwrap().remove(&id)` (`main.rs:168`, `:279`,
`:398`, `:432`). Rust temporary drop order: the returned `Option<Arc<Pane>>`
drops **before** the `MutexGuard`, so `Pane::drop` (`main.rs:46-50`:
`child.kill(); child.wait()`) runs **under the lock**. `portable-pty`'s `kill()`
is SIGHUP + a blocking try-wait grace loop then SIGKILL; `child.wait()` then
blocks until reap. Since the input path (`main.rs:132-137`) and all removals need
that same lock, each kill freezes the daemon ~50-200 ms; an adoption sweep of N
stale panes serializes N× that; a child stuck in **D-state** (NFS/fuse) makes
`wait()` — and the whole daemon — hang forever.

**Fix:** `let removed = map.lock().remove(&id);` on its own statement (guard drops
first), then drop `removed` outside the lock (or on a reaper thread).

### 7. `mymux-attach` can't detach from a continuously-outputting pane
`crates/mymux-ptyd/src/bin/attach.rs:341-346`: the `tokio::select!` recreates a
fresh `tokio::time::sleep(120ms)` future **every loop iteration**. When output
events arrive faster than 120 ms (a compile spew, `yes`), the `events.recv()`
branch always wins, the sleep never completes, and the `DONE` flag (set when
Ctrl-\ is pressed and the stdin thread exits, `:291-312`) is **never checked**.
The stdin thread has already exited, so the user can neither detach (Ctrl-\) nor
interrupt — only an external kill of `mymux-attach` frees them.

**Fix:** make `DONE` a `Notify`/channel select branch, or hoist the sleep future
out of the loop and reuse it.

### 8. `/fs/write` is non-atomic (truncate-then-write) — a mid-write failure corrupts the file on disk
`crates/mymuxd/src/fs.rs:230`: `std::fs::write(&file, req.content)` truncates the
destination first. If the write fails partway (ENOSPC, disk error, daemon
killed), the original file is left truncated/corrupted. The editor keeps the
dirty buffer in memory (save only clears dirty on success, `code.ts:1209`), so
the *edit* survives — but the on-disk source is clobbered.

**Fix:** write to a temp sibling then atomic `rename` (standard save-file
pattern).

### 9. Reconnect banner's "Hosts" escape button is unclickable
`ui/src/style.css:2404`: `.ws-banner { … pointer-events: none; }`, and
`.ws-banner-btn` (`:1798`) never restores `pointer-events: auto`. The button
created at `workspace.ts:204-210` (`onclick → hooks.onOpenHosts`) can never
receive a click — the comment above it describes it as the escape hatch for a
dead daemon, which is precisely when the user is stuck. Clicks pass through to the
pane below. **Fix:** `.ws-banner-btn { pointer-events: auto }`.

### 10. Empty-state overlay is shown (not hidden) on first connect — ghost text bleeds through in translucent mode
`ui/src/main.ts:480` calls `renderEmpty()` (comment: "a workspace arriving hides
the empty state") **before** `workspaces.set(id, w)` at `:533`. `renderEmpty`
(`:149-151`) toggles `.show` on `workspaces.size === 0`, which is still true, so
it **shows** `#empty`; nothing later hides it until a second host connects or a
session ends. `#empty` sits under the workspace layer, so it's masked while panes
are opaque — but with `has-winalpha`/`has-bgimage` (the translucency mode this
user runs) the ghost "No windows / Connect to a host…" text bleeds through the
terminal for the whole session. **Fix:** move `renderEmpty()` after
`workspaces.set`.

### 11. Focus-steal guard only recognizes `<input>` — state broadcasts yank focus out of the editor/pager into the live pty
`ui/src/workspace.ts:633`: `const typing = document.activeElement instanceof
HTMLInputElement;`. Not covered: the termhist pager's focused `<div tabIndex=-1>`
(the very element the 07-17 audit added to stop pager keys leaking), CodeMirror's
contenteditable `.cm-content`, `<textarea>`, `<select>`. Since the workspace stays
`visible` under overlays, any state broadcast where `active_pane` changed (a
background pane/agent exits, another client focuses) runs `setActivePane`, sees
`typing == false`, and calls `term.focus()` — stealing focus from the open editor
or pager; subsequent keystrokes (incl. Enter/Esc) go to the live shell. Same
class as the audit's fixed "pager keys leaked into pty", through the opposite
door. **Fix:** broaden `typing` to `isContentEditable` + textarea/select, or gate
on "an overlay owns focus".

### 25. File viewers ignore the session root override — broken viewer, or the wrong file's bytes
`ui/src/viewers.ts:33-41` has no concept of `root`: `rawUrl` builds
`/fs/raw?path=…&pane=…&limit=…` with no `root`, and `code.ts:1172` calls
`makeCtx(apiBase(), s.pane, path)` (no root). The daemon resolves against
`root_for_req(pane, None)` = pane cwd, but every *other* code-panel read passes
`rootQ(s.root)`. Whenever a root override is active — terminal "jump to dir"
(`openRoot`), git-graph jump-in (`openAt`), the ⎇/↑/⌂ root switcher,
`enterSubmodule` — opening any image/PDF/binary fetches relative to the pane cwd:
404/403 "could not load" in the common case, or, if a same-named file exists under
the pane cwd, it **silently displays the wrong file's bytes**. `showSession`'s
viewer-restore (`:1903`) has the same omission. **Fix:** thread `root` through
`makeCtx`/`rawUrl` like every other read.

### 26. Active clean buffer is never reconciled with disk — a concurrent agent write is clobbered by the user's next save
`ui/src/code.ts:1228-1292` re-reads disk only on tab re-activation/`refresh()`,
never while a file stays displayed; `save()` (`:1208`) POSTs with no precondition.
There is no mtime/watch/If-Match anywhere. In this agent-aware tool the flow is
routine: file A open + clean + on screen → an agent rewrites A on disk → the user
(looking at the stale buffer) edits and ⌘S → the agent's version is silently
overwritten with no conflict signal. Distinct from the non-atomic-write item (#8):
this is a lost-update/staleness gap. **Fix:** capture mtime on read, send it as a
precondition on write (or watch the file and warn on external change).

### 27. LSP client is keyed by `(apiBase, root)` but not `lang` — two languages in one root cross-wire to a single server
`ui/src/lsp.ts:480`: `const key = ${apiBase}|${info.root}`. The launched server is
fixed from whichever language connected first (`?lang=${lang}`, `:491`). Two
languages can resolve to the same `info.root` — e.g. a Cargo-workspace root that
also holds top-level `.py` scripts (Python falls back to cwd, `lsp.rs:195`; Rust
uses the outermost `Cargo.toml`, `lsp.rs:183`), or a dir with both `Cargo.toml`
and `go.mod`. Opening `.rs` then `.py` there reuses the rust-analyzer client for
Python: `didOpen`/pulls go to the wrong server → broken or spurious diagnostics.
**Fix:** include `lang` in the key.

### 32. `String::truncate` on a byte cap panics off a char boundary — `/git/show` & `/git/compare` fail on large multibyte diffs
`crates/mymuxd/src/git.rs:566` (show) and `:628` (compare):
`diff.truncate(DIFF_CAP)` where `DIFF_CAP = 4_000_000` and `diff` is a `String`
from `from_utf8_lossy(...).into_owned()`. `String::truncate` **panics** unless the
new length is a char boundary. A commit/compare diff >4 MB with a multibyte char
straddling byte 4,000,000 panics the handler — near-certain for CJK/emoji-heavy
diffs (~⅔ of bytes are continuation bytes). The handler task unwinds (default
unwind, daemon survives), so it's a per-request break: the UI shows "could not
load this commit", plus log spam. The truncation affordance meant to *gracefully*
cap large diffs instead reliably breaks multibyte ones. **Fix:** walk back to a
char boundary, or truncate the `&[u8]` before `from_utf8_lossy`.

### 33. Packages catalog cache is never invalidated after install/remove — the button reverts and the op looks like a no-op
`ui/src/pkgs.ts:97` sets `catalogCache`; nothing ever nulls it. After an
install/remove, `actionBtn`'s `finally` (`:238-242`) calls `load()`, but the
catalog path returns early on the still-fresh cache (`:91`, `CATALOG_TTL = 5 min`)
and re-renders from the **stale** cache — so a just-installed package's card flips
**back to "Install"** (no error), and a just-removed one still shows "Remove", for
up to 5 minutes (no Refresh button in this panel). This hits the primary catalog
install flow; search-result installs self-correct (they refetch). **Fix:**
`catalogCache = null` in the `finally` before `load()`.

---

## P3 — latent / narrow-trigger

### 12. `QuotaExceededError` on a large background image poisons every later pref write
`ui/src/prefs.ts:71-74`: `setPrefs` mutates `current = { ...current, ...patch }`
**before** `localStorage.setItem`. A too-large `bgImage` data-URL (settings allows
~1-3 MB) throws at `setItem`, after `current` is already updated and before
listeners run. Every later `setPrefs` (font zoom, theme, notify) re-serializes the
giant `current`, throws again, and never reaches the listeners — all pref changes
silently stop applying and persisting until reload. **Fix:** write-then-commit, or
catch around `setItem` and roll back `current`.

### 13. A failed lazy `import('./code')` wedges the code panel forever
`ui/src/main.ts:923-932`: `ensureCode` sets `codeLoading = true` then
`await import('./code')` with no try/finally. If the import rejects (stale hashed
chunk after a redeploy, mainly in browser mode), `codeLoading` stays `true`, so
every later call skips the retry and spins `while (!codeReal) await sleep(50)` —
an infinite 50 ms loop and ⌘E dead for the session, plus an unhandled rejection.
Same shape at the git (`:982`) and hist (`:1056`) wrappers. **Fix:** try/finally
resetting `codeLoading`, and surface the error.

### 14. `alert()` is inert in the Tauri webview — add-host validation silently does nothing
`ui/src/hostmanager.ts:526`: `alert('Hostname and user are required.')`. The same
file documents (`:301-303`) that `window.confirm` is inert in the Tauri v2
webview; `window.alert` shares that plumbing. Saving a host with an empty
hostname/user shows no feedback. **Fix:** in-panel inline error (the codebase's
established pattern).

### 15. "⇧ older output" scroll chip appears over alt-screen TUIs and fresh panes
`ui/src/workspace.ts:570-571`: `term.onScroll(ydisp => chip.style.display =
ydisp === 0 ? '' : 'none')`. xterm fires `onScroll` with `ydisp=0` outside user
scrolling — on alt-buffer activation (entering vim/htop), on resize/font-zoom of a
pane with no scrollback, on ED3 clear — so the chip pops up over full-screen TUIs
and freshly-split empty panes and lingers (alt buffers never scroll again).
**Fix:** also require `buffer.active.type === 'normal'` and non-empty scrollback.

### 16. Legacy clipboard fallback drops terminal focus
`ui/src/clipboard.ts:16-26`: the `execCommand('copy')` path focuses a transient
`<textarea>` (`:22`) and removes it (`:26`) with no refocus; `copySelection`
(`main.ts`) doesn't restore either. If the modern `navigator.clipboard` rejects in
the Tauri build (the fallback's whole reason to exist), every ⌘C leaves typing
dead until a click. **Fix:** refocus the active terminal after the fallback.

### 17. Agent-status report keys on `$TMUX_PANE` with no socket check — cross-server badge collision
`scripts/mymux-agent-report.sh:5`: `pane="${TMUX_PANE#%}"` with no check that it's
mymux's `-L mymux` server. If a user nests a personal tmux inside a mymux pane and
runs an agent there, its hook reports that tmux's pane id to mymuxd, which badges
an unrelated window. `set_agent` (`tmux.rs:992`) does no validation. Narrow
trigger (nesting is the workflow mymux replaces), hence P3.

### 18. ptyd alt-screen tracking is narrower than avt's parser
`crates/mymux-ptyd/src/grid.rs:39-48` matches only six 8-byte literals
`\x1b[?104{7,8,9}{h,l}`, but avt also accepts legacy `?47`, multi-parameter DECSET
(`\x1b[?6;1047h`), and 8-bit C1 CSI (`\x9b?1049h`); the mymuxd byte-scan fallback
(`tmux.rs:1063`) only knows `?1049`. So `PaneGrid.alt` / `Ev::Alt` / the UI alt
indicator / agent heuristic can desync from reality. `snapshot()` itself is
**unaffected** (avt's `dump()` normalizes, and avt self-heals primary width on
alt-exit reflow). **Fix:** track alt via the grid's own parsed state rather than a
byte-literal match.

### 19. Timed-out ptyd RPCs leak in the pending map
`crates/mymux-ptyd/src/client.rs:91-98` inserts into the pending-reply map; only a
received reply (`:219/:226`) or connection death (`:246`) removes it — the 5 s
timeout paths don't. A timed-out `Spawn` also returns `Err` while ptyd may have
succeeded, leaving an un-mirrored live pane until the next adoption reconcile.
Sibling of the audit's known ws-client `pending` leak, in the ptyd client.

### 20. Orphan-sweep vs concurrent promote race
`main.rs:156-169`: the owner-disconnect sweep collects ephemeral-owned ids under
the lock, releases it, then deletes them one-by-one without re-checking the flag.
A concurrent `SetEphemeral(false)` (promote "keep this shell") landing in that
window still gets the shell killed. **Fix:** re-check flag+owner under the lock at
delete time (or use `retain`).

### 21. `mymux-attach` Ctrl-\ detection discards the rest of the read chunk
`attach.rs:304-306`: `if chunk.contains(&0x1c) { break; }` runs **before**
forwarding, so bytes before a `0x1c` in the same `read()` (fast-typed input, or a
paste that happens to contain 0x1c) are lost and the paste detaches mid-stream.
**Fix:** forward the pre-`0x1c` slice, then detach.

### 22. ptyd `Spawn` `contains_key`/`insert` TOCTOU
`main.rs:353` checks then `:398` inserts with no atomicity; two connections
spawning the same proposed id would have the second overwrite the first (old shell
killed, its reader later Exits the new pane — same root as #3). Latent today
(mymuxd is the sole spawner; attach never spawns). **Fix:** `entry` API.

### 23. Snapshot taken while alt-screen is active can replay stale-width history (cosmetic)
`crates/mymux-ptyd/src/grid.rs` history serializer: reseeds captured mid-alt can
emit primary history at the pre-resize width. Low impact — avt reflow corrects on
the next primary paint. Noted for completeness.

### 28. `/fs/write` follows a final-component symlink out of the confined root
`crates/mymuxd/src/fs.rs:87-97` (write branch, `must_exist=false`) canonicalizes
only the **parent**; the final component is `parent.join(file_name)`. If `root/foo`
symlinks outside root, `starts_with(root)` passes and `std::fs::write` follows the
link out of confinement. Mitigated in practice (the UI only writes files it first
opened via `read`, which canonicalizes fully; Origin guard blocks cross-site
POSTs) — a raw-endpoint / TOCTOU hardening gap, not a UI-reachable escape. **Fix:**
`O_NOFOLLOW`/`symlink_metadata` reject on the target.

### 29. LSP document URI built with `encodeURI` — `#`/`?` in a filename breaks it
`ui/src/lsp.ts:497`: `encodeURI(\`file://${info.fs_root}/${relPath}\`)`. `encodeURI`
leaves `#` and `?` unescaped, so `a#b.rs` → `file:///…/a#b.rs`, which servers parse
as path `/…/a` + fragment `b.rs` → wrong/absent document; `displayFile`'s
`decodeURI` (`:99`) is inconsistent too. LSP degrades for such (rare) filenames.
**Fix:** `encodeURIComponent` per path segment.

### 30. Save network failure gives no feedback and leaks an unhandled rejection
`ui/src/code.ts:119-131` (`fsWrite`) + `save()` else-branch (`:1223`): `fsWrite`
returns `r.ok`, but a dropped connection makes `fetch` **reject**, so `fsWrite`
rejects → `save()` rejects → the `void save()` at the keymap (`:1121`) swallows it.
The `✗ save failed` message only shows on an HTTP error status, never on a dropped
link (the flaky-SSH case). No data loss (dirty ● persists) but no failure signal.
**Fix:** try/catch in `fsWrite`, treat exception as failure.

### 31. `/fs/raw` reads the whole file before truncating to `limit`
`crates/mymuxd/src/fs.rs:198-201`: `std::fs::read(&file)` loads up to `MAX_RAW`
(50 MiB) then `bytes.truncate(limit)`. The path-jump existence probe
(`pathjump.ts:64`, `limit=1`) and the hex viewer (`limit=4096`) force a full-file
read to serve a few bytes. Correctness fine; wasted I/O per probe. **Fix:** bounded
read (open + `take(limit)`).

### 34. `mymux-pkg` passes the download URL to curl without `--`; the index overlay is unvalidated
`crates/mymux-pkg/src/main.rs:807` (`download_verified`):
`.args(["-fsSL","--max-time","600","-o"]).arg(&tmp).arg(url)` — `url` reaches curl
with no `--` separator, and `index()` (`:116-141`) merges a user overlay
(`$MYMUX_INDEX`/`~/.config/mymux/index.json`) with **no scheme/prefix validation**
(unlike the embedded index, which is test-guarded to `https://github.com/`). An
overlay channel `url` beginning with `-` (`-K/tmp/x.curlrc`, `--output /path`) is
parsed by curl as an option. Local-only (overlay is an on-disk file), sha256
pinning still protects normal URLs — defense-in-depth. **Fix:** `.arg("--")` before
the URL, and validate overlay URLs (https scheme, no leading `-`).

### 35. Package INFLIGHT guard keyed by raw spec, not resolved dir — `npm:foo` and `npm:foo@1.0.0` race the same staging dir
`crates/mymuxd/src/pkgs.rs:38-54` keys INFLIGHT by `req.name` (raw spec), but
`install_npm_dynamic` (`mymux-pkg/src/main.rs:300-313`) collapses both specs to
`safe_dir(name)` for the `.tmp-<dir>` staging and `<base>/<dir>` dest. Two
differing specs of the same package are distinct INFLIGHT keys yet identical dirs
→ concurrent `remove_dir_all` + `rename` races. Contrived trigger; defeats the
guard's stated intent. **Fix:** key INFLIGHT on the resolved dir.

### 36. `show(hash)` doesn't reset stale `fileFilter`/`rootOverride` — commit detail wrongly filtered to a prior file
`ui/src/gitgraph.ts:1388-1396`: `show(hash)` sets only `page`/`selected` and opens
the panel directly, bypassing `toggle()` (which clears `rootOverride`/`fileFilter`,
`:1382`). After a `showFileHistory(root, fileX)` session, a later blame-gutter
`show(hash)` keeps `fileFilter=fileX`, so `renderDetail` requests
`/git/show?rev=hash&path=fileX` — the user sees only fileX's slice of the commit
until they clear the file-history chip. **Fix:** reset the filter/root in
`show()`.

### 37. status/diff/discard parse human porcelain (no `-z`) — exotic filenames are unmanageable (fails safe)
`crates/mymuxd/src/git.rs:35` (`--porcelain=v1` via `text.lines()`), `:781`, and
diff/discard — whereas `files()` (`:151`) correctly uses `-z`. A filename with a
newline/tab/quote/non-ASCII is C-quoted by git, so the UI receives the quoted
literal; subsequent diff/discard/stage on it matches nothing → the op fails.
**Verified fails safe** (no wrong file is ever deleted/restored — the quoted
pathspec matches nothing), but those files can't be managed from the panel.
**Fix:** parse `-z` NUL-delimited output like `files()` does.

---

## Verified solid (do not re-audit without cause)

- **git injection surface** — `valid_rev` rejects leading `-` and restricts the
  charset; `--` separators precede all path args; `commit -m <msg>` /
  `reset <flag> <rev>` can't be flag-injected; `safe_path` gates every path.
- **ws.rs** — LE framing both directions, input chunked ≤1 MiB (ptyd cap),
  `Lagged` → full state + visible reseed, ping every 20 s, `send_task.abort()` on
  close.
- **native.rs** — `reorder_window` clamps `to.min(len)`; `split_sizes` refuses
  <2-cell halves.
- **daemon HTTP panics** — `parse_log` guards `f.len() < 6`; the `expect`s are on
  guaranteed-piped stdio or test code; no attacker-reachable index/unwrap in
  `/fs`, `/git`, `/proc`, `/pkgs` handlers.
- **tmux command escaping** — window-name rename single-quote-escapes
  (`'\''`) for the control-mode parser.
- **mymuxd Hub concurrency & funnels** (`tmux.rs`, audited inline) — the seven
  Hub mutexes follow a consistent global order (`active_view → {state, natives}
  → last_size`, and separately `model → agents → tab_order`), with the two
  groups never held simultaneously → no AB-BA cycle; no guard is held across an
  `.await` (compiler-enforced with `std::sync::Mutex`) or across a blocking
  `persist.*` socket call (all scoped and dropped first); `send_cmd` clones
  `cmd_tx` out before awaiting and drops commands when tmux is absent;
  close/self-exit dedup via `persist.kill`→`remove_mirror` before the ptyd-Exit
  path (`native_exited` no-ops on the second `remove_mirror`); `select_window`
  trues-up backend size before reseed; `new_window`'s `fresh` guard prevents the
  double-window bug.
- **ptyd framing** — `read_frame` length/partial-read/clean-EOF and `MAX_FRAME`
  inbound bound; snapshot 4 MiB budget; UTF-8 carry across chunks; `ends_in_alt`
  holds for all avt dump shapes.
- **Markdown sanitize** — `html:false` + DOMPurify + post-pass dropping
  non-https/absolute `src`/`href`; `data:`/`javascript:` schemes removed; SVG
  stripped. (Verified by the code/LSP audit.)
- **LSP `/lsp` bridge framing** — `Content-Length` byte length correct on axum
  0.8 `Utf8Bytes`; `read_line` header-split-safe + `read_exact` body-split-safe;
  single WS→stdin loop (no interleaving); per-socket server teardown via
  `send_task.abort()` + `kill_on_drop`. Latent caveat only: header match is
  case-sensitive (all four real servers emit exact casing).
- **`safe_path` read/list** — `must_exist=true` canonicalizes fully and rejects
  out-of-root incl. `..` and symlinked dirs; search skips symlinks.
- **git argv (re-confirmed by the git/pkgs audit)** — all ~40 dynamic reaches
  guarded; destructive ops two-click-armed, `branch -d` (safe), no `--force` on
  push/rebase; per-channel sha256 (github-*) mandatory, go/npm delegate to
  sumdb/registry by design; `pkgs` `valid_name`/`safe_dir` confine removal;
  git/pkg output is `textContent` (no innerHTML sink); git panel closed on host
  switch.
- Secret handling, bundle sha256 chain, `/proc` subtree-kill confinement (per
  `AUDIT.md`, re-confirmed unchanged).

---

## Pending (re-dispatched audits — findings to be appended)

1. **connect-layer adjacency** — task-leak audit of forwarders/keepalives/probes,
   supervisor state-machine edges neighbouring #1/#2 (re-dispatched).
2. **post-audit regression sweep** — the `2f66e2c` panel paint-from-cache
   refactor and the canvas add/withdraw pair (re-dispatched).

_Code panel + LSP audit returned — folded in above as #24-#31._
_Git + pkgs audit returned — folded in above as #32-#37._
_mymuxd Hub (`tmux.rs`) audited inline — no findings; see Verified solid._
