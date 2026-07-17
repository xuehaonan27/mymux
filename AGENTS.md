# mymux — agent workflow notes

- After a development batch is done (code + typecheck/build + relevant `ui/ux/*check.mjs` checks all green), **git commit and push directly** — no need to ask. Per the owner (2026-07-17).
- Still ask first for anything beyond routine commit/push: force-push, history rewrites, branch surgery, releases/tags (CI publishes on `v*` tags), and outward-facing actions (PRs, issues, comments).
- UI changes must come with their `ui/ux/*check.mjs` coverage; run the related sweep before committing (see README *Develop* for the harness).

## Design rules (owner, 2026-07-17 — no ad-hoc fixes around these)

- **Panel I/O discipline**: every surface paints from in-memory state FIRST — preserved DOM, a session cache, or a model snapshot (VS Code's stale-while-revalidate). Remote I/O only ever REFRESHES in the background, with in-flight dedup, a TTL, and a stale-guard (seq/captured-state check). An open path may not serially await remote fetches, and a DOM rebuild may not drop scroll/selection without a reason.
- **Tauri invoke args are snake_case at every call site** — all commands declare `rename_all="snake_case"`. Stub checks must assert recorded call arg SHAPES (a stub that accepts anything is how hostId/host_id shipped broken).
- **Version comparisons are semantic** (`STRICTLY older ⇒ outdated`), with sha-string inequality reserved for the equal-version update lane — never a raw `!=`.
- **Daemon-touching ux checks run sandboxed** (own `MYMUX_PTYD_SOCK` + `MYMUX_SOCKET` + port); never against a shared/production daemon — ad-hoc "just use the dev daemon" runs are how pollution flakes came to be.
- Legal escape from any of these is a code comment at the site explaining why the pattern doesn't fit (like the search-per-query lanes that stay fetch-per-open by design).

