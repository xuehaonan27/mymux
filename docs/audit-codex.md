# mymux Codex structural audit — 2026-07-21

Baseline: `main` at `88f142e` (`v0.1.0-88f142e`). This was a diagnostic
batch: no product code was changed. The audit covered UI state/races, daemon
and ptyd lifecycle, the Tauri connection layer, filesystem and Git endpoints,
release packaging, and the UX/CI harness.

Severity follows the existing audit's convention:

- **P0** — security boundary break or credible data corruption/loss.
- **P1** — major user-visible wrongness, wrong-host action, or unusable core
  workflow.
- **P2** — bounded race, reliability/performance defect, or significant test
  gap.
- **P3** — hardening and maintainability debt with limited immediate impact.

## Executive conclusion

The repository builds and its current automated tests are green, but that is
not a reliable readiness signal. The audit found two stop-ship defects: an
async save can contaminate one file buffer with another file's contents, and
`/fs/write` can follow a final symlink outside its declared root. Several P1
races can also route UI state or destructive actions to the wrong host/repo.

The highest-priority repair order is:

1. make editor saves and file opens generation-safe, and close the `/fs/write`
   symlink escape;
2. repair tunnel status/port ownership and native-pane lifetime inheritance;
3. stop destroying/reseeding cached terminals on window switches and repair
   snapshot truecolor encoding;
4. scope every panel request by captured host/root/request generation;
5. repair the release manifest handoff before publishing another DMG;
6. make the UX harness genuinely sandboxed and add a normal push/PR CI gate.

## Verification performed

| Check | Result |
|---|---|
| `cargo test --workspace --all-targets` | **PASS** — 83 tests, 0 failures |
| `cargo build -p mymuxd` | **PASS** — reports `mymuxd 0.1.0 (88f142e)` |
| `npm --prefix ui run build` | **PASS** — typecheck + Vite build; two large-chunk warnings (~780/833 KiB) |
| `npm --prefix ui run check:args` | **PASS** — 12 commands, despite the guard gaps documented below |
| `bash -n scripts/*.sh` and JS/MJS syntax checks | **PASS** |
| isolated `emojicheck.mjs` | **PASS**; its private daemon/socket were cleaned up |
| isolated terminal switch probe | **REPRODUCED** — 5,500-line oldest marker vanished, pane DOM identity changed, and `rgb(37, 83, 149)` became `rgb(83, 149, 0)` after A→B→A |
| targeted ptyd alt-history test | **PASS** — confirms the current engine retains only the visible alternate-screen page |
| `cargo clippy --workspace --all-targets` | completes with warnings |
| `cargo clippy --workspace --all-targets -- -D warnings` | **FAIL** — `grid.rs:484` `bool_comparison`; `bundle.rs:71` `manual_split_once`; `bundle.rs:192` `unused_mut` |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked` | blocked on this Linux audit host by missing system `dbus-1.pc`; not classified as a source regression |

Targeted live checks used independent ports plus private `MYMUX_SOCKET` and
`MYMUX_PTYD_SOCK`. Checks known to omit one of those isolation boundaries were
not run. Playwright route-delay probes were used for deterministic UI races.

## Newly confirmed defects

### P0-01 — async save can put file B's state into file A's buffer

**Evidence.** [`ui/src/code.ts:1202`](../ui/src/code.ts#L1202) captures the
session and current buffer before `await fsWrite(...)`, but after the await it
reads the shared `editor.state` and the mutable `s.path` again. If A is being
saved and the user switches to B while the request is in flight:

- the request writes the captured A contents to A on disk;
- `b.state = editor.state` stores B's `EditorState` in A's buffer;
- `notifySaved(editor)` notifies B's LSP plugin;
- the success header can name B because `s.path` changed.

An isolated delayed-write probe reproduced this: A became `AAA-EDIT` on disk,
but reopening A displayed B's `BBB` contents and marked A dirty. Saving once
more would overwrite A with B. Concurrent saves of the same file are also not
serialized, so an older request can complete after a newer one.

**Why tests missed it.** [`ui/ux/mdcheck.mjs:97`](../ui/ux/mdcheck.mjs#L97)
saves and waits; it never changes buffer/host or issues a second save while the
write is pending.

**Smallest safe fix.** Capture `{session, path, buffer, submittedState,
submittedDoc, generation}`. Serialize or generation-order writes per buffer;
on completion update only the captured buffer, and touch the visible editor or
LSP only if the same generation is still mounted. Add delayed save→switch and
double-save tests.

### P0-02 — `/fs/write` follows a final symlink outside the requested root

**Evidence.** For writes, [`crates/mymuxd/src/fs.rs:87`](../crates/mymuxd/src/fs.rs#L87)
canonicalizes only the parent and appends the unchecked leaf. Then
[`fs.rs:227`](../crates/mymuxd/src/fs.rs#L227) calls `std::fs::write`, which
follows an existing final symlink.

This was reproduced against an isolated daemon: `root/escape.txt` was a
symlink to an outside file; `POST /fs/write` returned 204 and changed the
outside file to `escaped-write`. This also disproves the “`/fs` confinement
verified solid” claim in [`docs/AUDIT.md`](AUDIT.md).

**Why tests missed it.** `fs.rs` has search tests but no write-confinement
tests for final symlinks, replacement races, or existing special files.

**Smallest safe fix.** Reject a symlink leaf with `symlink_metadata` and write
through an anchored directory handle with no-follow semantics (then atomically
rename a same-directory temporary file). Add existing-link and swap-race
tests; merely canonicalizing then opening leaves a TOCTOU window.

### P1-01 — a promoted/demoted native pane gives new splits the wrong lifetime

**Evidence.** [`crates/mymuxd/src/tmux.rs:883`](../crates/mymuxd/src/tmux.rs#L883)
promises a split inherits the target's current kind, but line 907 passes
`is_ephemeral(pane)`, which reads the pane's birth-ID bit. Promotion/demotion
updates ptyd's current flag without changing that ID.

An isolated real-daemon probe produced both wrong states:

- create `⌁`, promote to `∞`, split → original `∞`, new pane `⌁`;
- create `∞`, demote to `⌁`, split → original `⌁`, new pane `∞`.

In the first case the supposedly persistent new work dies with a mymuxd
restart; in the second, throwaway work unexpectedly survives.

**Why tests missed it.** Native layout unit tests cover geometry; protocol
tests cover the current flag. No integration test does promote/demote→split→
disconnect/re-adopt.

**Smallest safe fix.** Use `persist.pane_ephemeral(pane)` with the ID bit only
as a legacy fallback, as the state rendering paths already do at
[`tmux.rs:939`](../crates/mymuxd/src/tmux.rs#L939).

### P1-02 — tunnel port reallocation succeeds internally but every consumer keeps the old port

**Evidence.** On bind failure,
[`crates/mymux-connect/src/russh_tunnel.rs:763`](../crates/mymux-connect/src/russh_tunnel.rs#L763)
changes only its private `cfg.local_port`. The Tauri `Active.port`, remembered
`ports` map, `connect()` return value, and `conns_list()` response remain the
original port in [`src-tauri/src/lib.rs:358`](../src-tauri/src/lib.rs#L358) and
[`src-tauri/src/lib.rs:421`](../src-tauri/src/lib.rs#L421). `Status::Connected`
does not carry the replacement port. The UI creates the workspace from that
stale return value at [`ui/src/hostmanager.ts:571`](../ui/src/hostmanager.ts#L571).

The tunnel can therefore be healthy on port N+1 while the workspace talks to
the occupied port N—possibly another mymux daemon/service.

**Why tests missed it.** There is no bind-race test spanning the supervisor,
Tauri state, emitted status, and workspace URL.

**Smallest safe fix.** Make the listener/port an owned connection-state value.
Publish a typed `PortChanged/Connected { port }` event and atomically update
`Active`, `ports`, `ConnInfo`, and the workspace before exposing “connected”.
Prefer reserving the listener before spawning to remove the TOCTOU entirely.

### P1-03 — `Status::Error` is both a diagnostic note and a terminal state

**Evidence.** The tunnel emits `Status::Error` for recoverable events: daemon
warm-up before auto-install, a held port before reallocation, one missed health
probe, and a dropped channel before reconnect
([`russh_tunnel.rs:377`](../crates/mymux-connect/src/russh_tunnel.rs#L377),
[`russh_tunnel.rs:387`](../crates/mymux-connect/src/russh_tunnel.rs#L387),
[`russh_tunnel.rs:448`](../crates/mymux-connect/src/russh_tunnel.rs#L448)).

Two independent breakages follow:

1. [`ui/src/hostmanager.ts:626`](../ui/src/hostmanager.ts#L626) calls
   `settleAttempt()` for every Error. Later `installing` or `connected` events
   are ignored because `attempt` is null, so zero-touch install and port
   self-healing can connect in the backend without ever opening a workspace.
2. [`src-tauri/src/lib.rs:378`](../src-tauri/src/lib.rs#L378) stores Error as the
   latest phase and sets `was_connected = false`. If a one-off health miss is
   followed by a healthy probe, no new `Connected` event is emitted; the host
   manager can report “connecting/error” forever over a healthy tunnel.

**Why tests missed it.** Stub status checks treat Error as terminal and do not
replay the real sequences `Error→Installing→Connecting→Connected` or
`Connected→Error(one miss)→healthy`.

**Smallest safe fix.** Split state from notices, for example `{ phase,
diagnostic, terminal, port }`. Only explicit terminal variants may settle an
attempt; a diagnostic must not replace the last connection phase.

### P1-04 — the advertised non-systemd launch fallback commonly cannot launch the installed daemon

**Evidence.** The installer puts the daemon at `~/.local/bin/mymuxd`, but the
remote start command uses bare `setsid mymuxd` in
[`src-tauri/src/lib.rs:14`](../src-tauri/src/lib.rs#L14). Non-interactive SSH
PATH commonly omits `~/.local/bin`; README itself acknowledges this at
[`README.md:268`](../README.md#L268). The absolute-path version probe then says
the binary is current, so `maybe_install` declines to reinstall and the
connection ends `DaemonUnreachable`.

The same command's `pgrep -x mymuxd` is not UID-scoped and can be satisfied by
another user's process. Its shared `/tmp/mymuxd.log` is also collision/symlink
prone.

**Why tests missed it.** There is no installer launch integration test and no
stripped-PATH, no-systemd SSH fixture.

**Smallest safe fix.** Execute `"$HOME/.local/bin/mymuxd"` explicitly, check
only the remote UID's process (or the actual health port), and log under a
user-owned state directory.

### P1-05 — an older file-open request can override the user's latest click

**Evidence.** [`ui/src/code.ts:1228`](../ui/src/code.ts#L1228) guards only
`current === s`. Two files in the same Session share `s`, so A's slow
`fsRead()` or LSP setup can commit after a later B request. A route-delay probe
(A 500 ms, B 50 ms) clicked A→B and ended with `a.txt / contents-a.txt`.

**Why tests missed it.** `codecheck` and `codetreecheck` use serial clicks and
fixed sleeps, with no response reordering.

**Smallest safe fix.** Add a per-session open generation and captured path;
check both after every await, including error/viewer branches. Preserve cached
DOM/buffers first, then refresh in the background when possible.

### P1-06 — manual code roots are not carried into LSP resolution

**Evidence.** The editor sends `root` to `/fs/read`, but
[`ui/src/code.ts:1283`](../ui/src/code.ts#L1283) calls `lspExtensionFor` without
it. `LspQuery` has no root field
([`crates/mymuxd/src/lsp.rs:24`](../crates/mymuxd/src/lsp.rs#L24)); both
`/lsp/info` and `/lsp` resolve from the pane cwd at
[`lsp.rs:180`](../crates/mymuxd/src/lsp.rs#L180) and
[`lsp.rs:329`](../crates/mymuxd/src/lsp.rs#L329). The resulting file URI is
also built from the pane `fs_root`, not the selected code root.

After ↑/repo/submodule root switching, the text can come from one file while
diagnostics, definitions, and edits refer to a same-named file under the pane
cwd.

**Why tests missed it.** `langcheck.mjs` checks CodeMirror language syntax, not
a real multi-root LSP session.

**Smallest safe fix.** Carry a validated root through info, WebSocket, client
key, server cwd, and file URI; capture it in the open generation.

### P1-07 — binary/image/PDF viewers ignore the manual root

**Evidence.** [`ui/src/code.ts:1164`](../ui/src/code.ts#L1164) calls
`makeCtx(apiBase(), pane, path)` without `s.root`, and
[`ui/src/viewers.ts:33`](../ui/src/viewers.ts#L33) builds `/fs/raw` with only
pane/path. A viewer opened after a root switch reads from pane cwd, returning a
404 or a wrong same-named file.

**Why tests missed it.** Markdown preview has its own correct `rootQ` path;
viewer-specific root checks do not exist.

**Smallest safe fix.** Put `root` in `ViewerCtx.rawUrl()` and add image/hex/PDF
checks from a root different from pane cwd.

### P1-08 — LSP connection cache omits the language dimension

**Evidence.** [`ui/src/lsp.ts:480`](../ui/src/lsp.ts#L480) keys clients by only
`apiBase|workspaceRoot`, while one WebSocket launches exactly one language
server. A mixed-language monorepo with equal resolved roots can reuse the
first language's client/server for a later language. The design explicitly
requires one server per `(workspace root, language)` in
[`docs/LSP-PLAN.md:60`](LSP-PLAN.md#L60).

**Why tests missed it.** There is no real mixed-language LSP integration test.

**Smallest safe fix.** Include normalized language (and effective daemon/root)
in the key; test two languages sharing a root.

### P1-09 — an LSP WebSocket drop leaves existing buffers permanently bound to a dead client

**Evidence.** [`ui/src/lsp.ts:311`](../ui/src/lsp.ts#L311) deletes the cache key
on WebSocket error/close but does not reconnect or replace extensions already
stored in `EditorState`. The reconnect healer at
[`ui/src/code.ts:2206`](../ui/src/code.ts#L2206) rereads the file; if disk
contents are unchanged, it remounts the same old state and dead plugin.

**Trigger/impact.** Restart/update `mymuxd`, flap the tunnel, or let a language
server exit. Existing buffers silently lose hover/completion/diagnostics until
their editor state is rebuilt; opening another file may create a new client
without healing the old one.

**Why tests missed it.** Reconnect checks cover terminal transport, not LSP
socket death with an already-open buffer.

**Smallest safe fix.** Give the transport reconnect/backoff semantics or
reconfigure every affected buffer onto the replacement client on reconnect.

### P1-10 — package catalog state is stale after mutation and can be assigned to the wrong host

**Evidence.** [`ui/src/pkgs.ts:75`](../ui/src/pkgs.ts#L75) caches catalog state
for five minutes. Operation completion at
[`pkgs.ts:238`](../ui/src/pkgs.ts#L238) calls `load()` without invalidating it;
an install probe returned `{ok:true}` but made only one catalog request and
immediately restored an enabled **Install** button.

For a cross-host request, line 95 selects host A before fetch, while line 97
calls `getApiBase()` again after the response. A's items can therefore be
stored as B's cache. The global `catalogInflight`, `inflight`, and `lastErr`
can also block or decorate B using A's operation.

**Why tests missed it.** `pkgsstylecheck.mjs` tests first paint/reopen/search,
not mutation or host switching during an in-flight request.

**Smallest safe fix.** Key all state by captured API/host, invalidate the
captured host after successful mutation, and use per-host in-flight dedup plus
a request generation.

### P1-11 — a stale process response can render host A rows on host B and kill a B process

**Evidence.** [`ui/src/proc.ts:115`](../ui/src/proc.ts#L115) captures neither
API base nor host/request generation. Switch A→B while A's poll is pending,
then reopen the panel: A's response sees `open === true` and renders. A row's
kill handler later resolves `apiBase()` dynamically at
[`proc.ts:64`](../ui/src/proc.ts#L64), so clicking A's PID sends the signal to
B. If B has the same PID inside an allowed pane subtree, the daemon correctly
authorizes—but kills the wrong process from the user's perspective.

**Why tests missed it.** There is no process-panel UX test, much less a
two-daemon delayed-response test.

**Smallest safe fix.** Capture `{api, hostGeneration}` for poll and render;
capture the same API in each row's action, discard on close/switch, and add
in-flight dedup.

### P1-12 — Git load can pass its stale guard while global `root` belongs to another repo/host

**Evidence.** [`ui/src/gitgraph.ts:1330`](../ui/src/gitgraph.ts#L1330) writes
global `root` immediately after awaiting `/git/toplevel`, before checking its
`seq`. An old A load can overwrite `root=A` after a newer B load has already
started. B's responses still pass B's `seq` check but render/operate with the
now-global A root. Because `get()` resolves `getApiBase()` at each call, an old
host load can also issue its post-toplevel requests to the new host.

**Why tests missed it.** Git checks use one repo/daemon and wait after every
navigation; none delays `/git/toplevel` or overlaps loads.

**Smallest safe fix.** Make `{api, pane, root, seq}` an immutable load scope.
Do not mutate panel globals until the whole scoped result passes its guard;
pass scope explicitly to every request and action.

### P1-13 — selecting a commit can cancel the current history pagination attempt

**Evidence.** The pagination observer disconnects before `loadMore()` at
[`ui/src/gitgraph.ts:1247`](../ui/src/gitgraph.ts#L1247). `loadMore()` snapshots
the global `seq`, but selecting a commit calls `renderDetail()`, which increments
that same counter at [`gitgraph.ts:612`](../ui/src/gitgraph.ts#L612). The page
response is discarded and the observer is never attached again; history stays
at 200 commits until the graph is rerendered or reloaded (for example, a local
history-filter change also rerenders it).

**Why tests missed it.** `gitpagecheck.mjs` scrolls and waits; it does not select
a commit during a delayed page request.

**Smallest safe fix.** Separate list-generation from detail-generation and
reattach the observer after any canceled/failed page request.

### P1-14 — partial staging emits an invalid new-side hunk start

**Evidence.** [`ui/src/gitgraph.ts:1119`](../ui/src/gitgraph.ts#L1119) parses
only the old `-start`, then writes it to both sides. A real header
`@@ -10,... +12,... @@` becomes `@@ -10,... +10,... @@`, so later hunks can
fail or apply only through offset/fuzz behavior.

**Why tests missed it.** The fixture's first change has zero net line count,
so old/new starts happen to be equal.

**Smallest safe fix.** Parse and preserve both starts, recomputing only counts;
add insertion-before-later-hunk and deletion-before-later-hunk fixtures.

### P1-15 — Git mutation timeouts report failure but do not stop the mutation

**Evidence.** [`crates/mymuxd/src/git.rs:683`](../crates/mymuxd/src/git.rs#L683)
wraps `cmd.output()` in a timeout without `kill_on_drop(true)`; the explicit
child in [`git.rs:804`](../crates/mymuxd/src/git.rs#L804) has the same issue.
Tokio children default to surviving handle/future drop. A timed-out pull,
rebase, checkout, hook, or apply can keep changing the repository after the UI
has reported failure, racing the user's next operation and `index.lock`.

The package runner demonstrates the intended pattern at
[`crates/mymuxd/src/pkgs.rs:137`](../crates/mymuxd/src/pkgs.rs#L137).

**Why tests missed it.** No test uses a deliberately blocking Git/helper and
checks that its process group and delayed side effect are gone after timeout.

**Smallest safe fix.** Set `kill_on_drop(true)`, kill/reap the process group on
deadline (hooks may have children), and include stdin write inside the timeout.

### P1-16 — switching ordinary terminal tabs disposes hidden xterms and local state

**Evidence.** The daemon state contains only the active window's layout at
[`crates/mymuxd/src/state.rs:153`](../crates/mymuxd/src/state.rs#L153). UI state
handling feeds that layout into
[`applyLayout`](../ui/src/workspace.ts#L279); its cleanup loop at
[`workspace.ts:341`](../ui/src/workspace.ts#L341) disposes every pane absent
from that layout. [`onBinary`](../ui/src/workspace.ts#L290) also writes only to
panes still in that map, so output from the background window is dropped.

The destroyed xterm has a 10,000-line client buffer
([`workspace.ts:484`](../ui/src/workspace.ts#L484)), while the native primary
snapshot retains only 4,096 lines
([`grid.rs:11`](../crates/mymux-ptyd/src/grid.rs#L11)). An alternate-screen
Coding CLI is worse: the snapshot explicitly restores only its visible page at
[`grid.rs:169`](../crates/mymux-ptyd/src/grid.rs#L169). The tmux lane calls
`capture-pane -e -p` without history at
[`tmux.rs:1233`](../crates/mymuxd/src/tmux.rs#L1233), so it also restores only
the current page.

Even native primary history within the 4,096-line cap has a deterministic gap.
The snapshot writes each history row with CRLF, then immediately clears the
visible grid with ED2 at
[`grid.rs:200`](../crates/mymux-ptyd/src/grid.rs#L200). The final `rows - 1`
history rows are still on the visible page rather than in client scrollback,
so ED2 deletes them. A 30×4 probe with `L00..L11` retained `L00..L05` and the
live `L09..L11`, but lost the contiguous band `L06..L08`—precisely the band
just above the visible page described in the field report.

A fully isolated probe wrote 5,500 unique lines with an oldest `HIST-FIRST`
sentinel. Before A→B→A the sentinel was reachable; afterwards it was gone and
the original pane element reported `isConnected=false`. Scroll position and
selection necessarily die with that element too.

This is the same root cause as the already-known zoom/unzoom issue, but it also
affects ordinary window switching.

**Why tests missed it.** `winswitchcheck.mjs` creates only 200 history lines,
and only after its switching assertions. It checks neither an oldest sentinel
before/after switching nor DOM identity, selection, or scroll position. The
ptyd history test at [`grid.rs:486`](../crates/mymux-ptyd/src/grid.rs#L486)
asserts only two early markers, not complete line continuity, so the
`rows - 1` hole passes.

**Smallest safe fix.** Preserve and hide pane DOM/xterm instances by window,
continue feeding them while hidden, and dispose only on an authoritative true
pane/window close. Merely hiding is insufficient: native selection still
broadcasts a destructive snapshot at
[`tmux.rs:678`](../crates/mymuxd/src/tmux.rs#L678), and the UI requests another
one after 280 ms at [`workspace.ts:376`](../ui/src/workspace.ts#L376). Tag
seed/live frames (preferably with per-pane sequence numbers) and do not reseed
a retained pane on a routine switch or zoom. For genuine primary reseeds, push
all replayed history rows into scrollback before ED2 and assert end-to-end
continuity around the history/live boundary.

### P1-17 — Git is missing from full-screen panel mutual exclusion

**Evidence.** `closeOtherPanels` accepts only code/proc/pkgs at
[`ui/src/main.ts:1084`](../ui/src/main.ts#L1084), and
[`toggleGitGraph`](../ui/src/main.ts#L1043) does not call it. A live probe opened
proc then Git and found both `.show`; proc (`z-index:21`) covered Git
(`z-index:20`) while both remained in the modal stack.

**Why tests missed it.** `modalcheck.mjs` covers only code+settings and
code+host combinations.

**Smallest safe fix.** Use one panel/modal arbiter for all full-screen surfaces
and test the pairwise transitions.

### P1-18 — the current tagged release workflow builds a DMG with an old daemon manifest and downgrade path

**Evidence.** The tracked manifest still pins `c3ac761` at
[`src-tauri/resources/daemon/bundles.json:3`](../src-tauri/resources/daemon/bundles.json#L3),
while HEAD/tag and published daemon assets are `88f142e`. The Ubuntu job builds
and mutates a new manifest, but the macOS job does a fresh checkout and has no
artifact handoff in [`.github/workflows/release.yml:58`](../.github/workflows/release.yml#L58)
and [`.github/workflows/release.yml:74`](../.github/workflows/release.yml#L74).
[`crates/mymux-connect/build.rs:17`](../crates/mymux-connect/build.rs#L17)
therefore compiles the tracked old file into the DMG.

Manifest data wins over any embedded bundle in
[`russh_tunnel.rs:571`](../crates/mymux-connect/src/russh_tunnel.rs#L571). Since
both versions are `0.1.0` but their SHA strings differ, the current client marks
an `88f142e` daemon outdated and can “update” it to `c3ac761`. GitHub API and
the tagged tree/workflow were checked, establishing the deterministic affected
build path; the DMG artifact itself was not extracted during this audit.

**Known/new boundary.** [`docs/AUDIT.md`](AUDIT.md) already noted the missing
drift guard and bad bundle fallback. This audit confirms the tagged workflow
builds an affected DMG, and the equal-version SHA lane makes it an active
downgrade path.

**Smallest safe fix.** Pass the generated manifest/assets to the DMG job as a
verified artifact, fail if manifest version/SHA does not match the tag/daemon
asset, and add a post-build extraction assertion against the DMG.

### P1-19 — `/tmp` ptyd fallback can be pre-bound by another local user

**Evidence.** Without `XDG_RUNTIME_DIR`,
[`crates/mymux-ptyd/src/proto.rs:170`](../crates/mymux-ptyd/src/proto.rs#L170)
uses `/tmp/mymux-ptyd-$USER.sock`. Startup treats any successful connect as a
valid existing ptyd and exits at
[`crates/mymux-ptyd/src/main.rs:68`](../crates/mymux-ptyd/src/main.rs#L68), with
no peer-UID or protocol handshake. A pre-bound permissive socket can therefore
deny startup or impersonate the ptyd on non-systemd/minimal hosts.

**Why tests missed it.** Tests set a private socket; there is no hostile
pre-bound fallback test.

**Smallest safe fix.** Use a UID-owned 0700 runtime directory, verify peer
credentials and a versioned handshake, and fail closed if a secure runtime path
cannot be created.

### P1-20 — daemon-touching UX checks are not consistently sandboxed

**Evidence.** README's example starts only with `MYMUX_ADDR` at
[`README.md:121`](../README.md#L121), despite requiring all three isolation
variables at line 129. `altcheck.mjs`, `agentflowcheck.mjs`, and
`winswitchcheck.mjs` set a ptyd socket and port but omit `MYMUX_SOCKET`
([`altcheck.mjs:26`](../ui/ux/altcheck.mjs#L26),
[`agentflowcheck.mjs:20`](../ui/ux/agentflowcheck.mjs#L20),
[`winswitchcheck.mjs:19`](../ui/ux/winswitchcheck.mjs#L19)). Such a daemon probes
the default `tmux -L mymux` and can inspect/adopt/clean a developer's live
session.

Only four checks use the shared `sandbox.mjs`; most default to a separately
started port 8099 harness. Several lack `finally` cleanup, so a Playwright
failure can leave daemon/socket state behind.

**Smallest safe fix.** Make the sandbox helper the only daemon launcher, have
every check allocate all three resources, install signal/finally cleanup, and
refuse to run when an explicit private socket is absent.

### P1-21 — terminal snapshots deterministically corrupt truecolor and lose the tmux current pen

**Evidence.** Native panes feed the live byte stream through AVT, then
[`PaneGrid::snapshot`](../crates/mymux-ptyd/src/grid.rs#L154) appends
`self.vt.dump()` as the visible-grid seed. The locked AVT 0.18.0 dependency
([`Cargo.lock:97`](../Cargo.lock#L97)) serializes an RGB pen as
`CSI 38:2:R:G:B m`. The bundled xterm 6 parser treats the third colon field as
the color-space slot; its compatible forms are `38;2;R;G;B` or
`38:2::R:G:B`. The AVT dump therefore shifts `(R,G,B)` to `(G,B,0)` when it
is replayed into xterm.

A fully isolated native-window probe painted `COLOR-PROBE` with
`38;2;37;83;149`. Its computed color was `rgb(37, 83, 149)` before A→B→A and
`rgb(83, 149, 0)` after the switch, exactly matching the reported
yellow/green distortion. This reproduces in headless Chromium, independently
of the separate macOS translucent-compositor artifact.

The tmux lane has a second loss mechanism. `capture-pane -e` serializes styled
cells and resets the pen after each colored run, while
[`snapshot_pane`](../crates/mymuxd/src/tmux.rs#L1231) restores only the cells
and cursor—not the application's current SGR pen. A probe that emitted red,
paused across a window switch, then emitted more bytes without another SGR
showed the latter text in the default color even though the application still
considered its pen red.

**Why tests missed it.** The native color test at
[`grid.rs:329`](../crates/mymux-ptyd/src/grid.rs#L329) replays AVT output back
into AVT, whose parser accepts its own colon form; it never crosses into
xterm. `winswitchcheck.mjs` uses plain RED/GREEN marker text. Its only SGR
check runs after the switch sequence, the preceding input turns the command
into `xprintf`, and the assertion at
[`winswitchcheck.mjs:157`](../ui/ux/winswitchcheck.mjs#L157) passes whenever
the literal word `REDACT` exists even with no matching color.

**Smallest safe fix.** Patch/upgrade the AVT dump path to emit an
xterm-compatible RGB form and add a cross-emulator exact-RGB regression test.
Do not snapshot retained panes on routine switch/zoom. For real tmux resyncs,
the protocol must preserve current terminal modes/pen (or maintain a
server-side terminal model); `capture-pane` cell text alone cannot do so.

## P2/P3 findings

| ID | Sev | Finding and evidence | Minimum repair/test |
|---|---:|---|---|
| C-21 | P2 | Process polling uses a fixed 1.5 s interval with no in-flight dedup/generation and rebuilds the body via `replaceChildren`, so slow responses can regress rows/CPU baselines and refreshes discard scroll/selection ([`ui/src/proc.ts:115`](../ui/src/proc.ts#L115)). | One captured-host poll at a time; preserve scroll/selection; add delayed-response coverage. |
| C-22 | P2 | Code tree and Git-status refreshes guard only the Session, not request order, and rebuild the tree without preserving `scrollTop` ([`ui/src/code.ts:1528`](../ui/src/code.ts#L1528), [`code.ts:1804`](../ui/src/code.ts#L1804)). An older refresh in the same Session can win. | Per-lane generations plus DOM/scroll preservation; test overlapping save/reconnect/manual refresh. |
| C-23 | P2 | Host-manager `showList()` awaits host/connection I/O and then unconditionally replaces the current view ([`ui/src/hostmanager.ts:137`](../ui/src/hostmanager.ts#L137)). A user can click Add/Edit/Connect in the preserved view and have a late list response erase that form. | View generation and captured intent; cache-first list refresh test with delayed invokes. |
| C-24 | P2 | Git open always replaces preserved DOM with `loading…`, serially awaits toplevel, then waits for four more calls ([`ui/src/gitgraph.ts:1330`](../ui/src/gitgraph.ts#L1330)). This violates the panel first-paint/scroll rule. | Paint the last scoped model/DOM immediately, background-refresh with dedup/TTL/stale guard. |
| C-25 | P2 | `ensureWorkspace()` calls `renderEmpty()` before inserting the workspace ([`ui/src/main.ts:477`](../ui/src/main.ts#L477)); a live probe found `#empty.show`/`display:flex` behind the first terminal. | Render after `workspaces.set`, and assert both zero→one and one→zero transitions. |
| C-26 | P2 | An invalid/stale pane silently falls back to daemon cwd/MYMUX_ROOT in [`crates/mymuxd/src/fs.rs:51`](../crates/mymuxd/src/fs.rs#L51). Invalid root overrides also fall back. Thus stale host/pane requests can read/write or run Git in a plausible but wrong directory instead of failing. | Distinguish absent pane/root from omitted pane/root; return 404/403 and require explicit default-root intent. |
| C-27 | P2 | Host metadata refreshes are detached and lack a connection generation ([`src-tauri/src/lib.rs:286`](../src-tauri/src/lib.rs#L286), [`src-tauri/src/lib.rs:378`](../src-tauri/src/lib.rs#L378)); an old master's slow probe can overwrite a newer connection's cache/event. | Key probe commits by connection generation/master identity. |
| C-28 | P2 | The UI's two-minute `HOST_META_TTL` does not actually refresh remote state: it invokes the `host_meta` cache getter and timestamps the same value as fresh ([`ui/src/hostmanager.ts:663`](../ui/src/hostmanager.ts#L663), [`src-tauri/src/lib.rs:279`](../src-tauri/src/lib.rs#L279)). | Add a real deduplicated refresh command or remove the false TTL claim; stale-guard its result. |
| C-29 | P2 | `Hub::new` writes a predictable shared `/tmp/mymux.tmux.conf` through normal symlinks ([`crates/mymuxd/src/tmux.rs:159`](../crates/mymuxd/src/tmux.rs#L159)); the non-systemd launcher similarly uses `/tmp/mymuxd.log`. This creates collision/symlink hazards and couples parallel daemons. | Per-UID/per-process 0600 files in an owned runtime/state dir, create-new/no-follow, cleanup. |
| C-30 | P2 | DEC mode 1048 is tracked as alternate screen at [`crates/mymux-ptyd/src/grid.rs:38`](../crates/mymux-ptyd/src/grid.rs#L38), but 1048 only saves/restores the cursor. It emits false alt state, distorts agent heuristics, and enters the wrong deferred-reflow branch; `alt_screen_1048_variant_tracked` codifies the error. | Track only 1047/1049 as buffer switches; replace the test with cursor-only semantics. |
| C-31 | P2 | LSP PATH-server probing runs `<server> --version` without a timeout/cache ([`crates/mymuxd/src/lsp.rs:99`](../crates/mymuxd/src/lsp.rs#L99)), and file open serially awaits `/lsp/info` before mounting content. A hung shim can hang the editor open path. `/lsp/install` is also unbounded. | Cache bounded probes, give them hard kill-on-drop deadlines, mount plain text first, then reconfigure LSP asynchronously. |
| C-32 | P2 | Git porcelain/name-status parsing uses newline/text modes instead of `-z` ([`crates/mymuxd/src/git.rs:32`](../crates/mymuxd/src/git.rs#L32), [`git.rs:490`](../crates/mymuxd/src/git.rs#L490)). Quoted non-ASCII/control-character and rename paths can be shown or acted on as escaped strings rather than real filenames. | Use `-z` and byte-safe parsers; fixture Chinese, newline, tab, quote, and ` -> ` names. |
| C-33 | P2 | Many Git read endpoints have no timeout and collect the complete child output before truncating it; even mutation `run_git` calls its first eight lines a “tail” ([`crates/mymuxd/src/git.rs:683`](../crates/mymuxd/src/git.rs#L683)). Large diffs/hooks can stall or allocate far beyond the displayed cap. | Shared bounded subprocess runner, byte-tail ring, timeout/process-group kill, streaming caps. |
| C-34 | P2 | `parse_semver` accepts only three numeric components; on parse failure `daemon_outdated` falls back to raw string inequality ([`crates/mymux-connect/src/russh_tunnel.rs:641`](../crates/mymux-connect/src/russh_tunnel.rs#L641)). Example: current `1.0.0-alpha`, expected `0.9.0` is wrongly “outdated”. | Use a SemVer parser; unknown/unparseable versions must not authorize downgrade. Test pre-release/build/dev strings. |
| C-35 | P2 | Release publishing violates `DRY_RUN=1` by rewriting `bundles.json` before the dry-run branch ([`scripts/ci-publish-release.sh:55`](../scripts/ci-publish-release.sh#L55)). | Generate into a temporary output or move the dry-run branch before all writes; regression-test input hashes. |
| C-36 | P2 | GitHub asset upload treats any failed upload/delete/list sequence as “kept previously uploaded,” even when no old asset was found ([`scripts/ci-publish-release.sh:91`](../scripts/ci-publish-release.sh#L91)). Rebuilt tarballs are non-deterministic, so partial retries can leave tar/manifest SHA mismatches. | Deterministic archives; require/verify an existing asset on duplicate; compare remote SHA/size; otherwise fail. |
| C-37 | P2 | `SKIP_AARCH64=1` selects only x86_64 but does not clean the output ([`scripts/ci-build-daemon-matrix.sh:27`](../scripts/ci-build-daemon-matrix.sh#L27)), while manifest generation still includes any old aarch64 tar present in that directory ([`ci-build-daemon-matrix.sh:145`](../scripts/ci-build-daemon-matrix.sh#L145)). | Fresh output dir or explicit target allow-list; test reused OUT. |
| C-38 | P2 | There is no push/PR CI workflow; release CI does not run tests, clippy, arg-shape, or a UX sweep. `ui/ux/package.json` still has the default failing `npm test`. | Add one reproducible aggregate check command and gate pushes/PRs plus release jobs on it. |
| C-39 | P2 | UX checks rely on absent/external fixtures and hard-coded `/home/xuehaonan` paths; `gitopscheck` masks its pull assertion with `|| true`, and `clipboardcheck` passes literal `true` for “no page errors.” In `winswitchcheck`, an earlier bare `x` makes the later color command `xprintf`, then `|| hueHtml.includes('REDACT')` lets the assertion pass on its uncolored command text. | Repository-owned fixture builder, portable temp roots, remove vacuous assertions, fail-fast cleanup. |
| C-40 | P3 | `argshapecheck.mjs` does not detect missing required args, shorthand/spread, command registration, or `rename_all`. Three Tauri commands omit the owner-mandated annotation even though their current arg names happen not to expose a mismatch ([`ui/ux/argshapecheck.mjs:41`](../ui/ux/argshapecheck.mjs#L41), [`src-tauri/src/lib.rs:121`](../src-tauri/src/lib.rs#L121)). | Parse Rust/TS ASTs or generate a contract; require the annotation on every command and exact recorded call shapes. |

## Previously known and still open

These are not new Codex discoveries. They remain in the current tree's
[`docs/AUDIT.md`](AUDIT.md) deferred table and are included here so this file is
a complete handoff rather than a misleading “new issues only” list.

| Existing item | Sev | Current status / relation to this audit |
|---|---:|---|
| Global viewport ownership lets two clients resize-ping-pong and broadcasts refresh reseeds to both. | P2 | Still open; needs idempotent resize/visibility dampers or a viewport lease. |
| A closed ptyd connection silently degrades until an unrelated spawn calls ensure. | P1 | Still open; add background reconnect/ensure. |
| Reconnect has a snapshot/live-byte duplication window. | P3 | Still open; sequence numbers are the clean fix. |
| Broadcast lag can lose ptyd Exit events and leave ghost panes. | P3 | Still open; periodic mirror reconciliation or reliable per-connection exit delivery. |
| Dead agent/heuristic pane entries are not pruned. | P3 | Still open; reconcile against fresh pane PID set. |
| ptyd stale-socket bootstrap race can create two processes with one unreachable. | P3 | Still open; P1-19 adds a separate hostile fallback-socket problem. |
| Old ptyd silently drops unknown operations. | P3 | Still open; versioned/error handshake. |
| Timed-out ptyd client RPC entries remain pending until disconnect. | P3 | Still open; remove on timeout. |
| Quick-open `/git/files` and terminal `jumpToToken/openAt` can cross a host switch. The old bare-pane repo auto-jump sub-case is fixed by host-scoped keys. | P3 | The two async-return races remain open at [`ui/src/code.ts:2104`](../ui/src/code.ts#L2104) and [`ui/src/main.ts:542`](../ui/src/main.ts#L542); the auto-jump key now includes `getScope()` at [`code.ts:763`](../ui/src/code.ts#L763). P1-05/P1-12 show the same missing captured-scope pattern in additional lanes. |
| Manifest lane selection makes embedded x86_64 fallback unreachable and does not fall back after download failure. | P2 | Still open; P1-18 additionally proves the shipped manifest itself is stale. |
| `load_secret_key` collapses local key-read/decrypt failures into `AuthFailed`; russh has no agent fallback. | P2 | Still open. |
| Deferred layout heal/nudge timers stack across rapid switches. | P3 | Still open; generation-token them. |
| Passphrase stays in memory without zeroize; remote master exec can accumulate unbounded output. | P3 | Still open; zeroize and tail-cap. |
| Soft-wrapped terminal history is replayed as hard lines. | P3 | Still open; needs wrapped-line metadata or another signal. |
| Legacy pre-2014 SSH algorithms are unsupported. | P3 | Intentional limitation; document host requirements. |
| Non-systemd `daemon_update` does not restart an already-running detached daemon. | P3 | Still open; separate from P1-04, where a stopped installed daemon cannot be launched at all. |
| Zoom/unzoom disposes sibling xterms and loses client scrollback. | P2 | Still open; P1-16 shows ordinary tab switching shares the bug. |
| Term-history rotation pagination, predictable agenthook temp path, notify-target/session map growth, and stale history workspace references. | P3 | Still open awareness-level debt. |

Three old deferred entries have changed status and are therefore detailed in
the new section rather than repeated as-is:

- “forwarder retries a cached held port” was partially changed, but the new
  port never reaches Tauri/UI (**P1-02**);
- raw version inequality was partially replaced, but non-core SemVer still
  falls back to inequality (**C-34**);
- release-manifest drift is now verified in the currently published tag/DMG
  (**P1-18**).

## Coverage that should accompany fixes

The current failures cluster around one missing testing primitive: controlled
asynchrony across two scopes. A repair batch should add reusable tests for:

1. two files with independently delayed read/write/LSP requests;
2. two daemon API bases/hosts with the same PID/path/package names;
3. two repositories with delayed `/git/toplevel`, detail, and pagination;
4. a tunnel bind collision followed by port reassignment and a real workspace
   attach;
5. promote/demote→split→daemon disconnect/re-adopt;
6. symlink and stale-pane/root confinement failures;
7. terminal A→B→A and zoom→unzoom with stable pane DOM identity, a 5,500-line
   oldest sentinel, preserved viewport/selection, exact truecolor, and an
   alternate-screen enter/exit fixture;
8. release artifact handoff: inspect the built client and compare its manifest
   version/SHA to the tag's daemon assets.

Every daemon-backed case must go through a helper that owns a private
`MYMUX_ADDR`, `MYMUX_SOCKET`, and `MYMUX_PTYD_SOCK`, and cleans them in
`finally`/signal handlers.
