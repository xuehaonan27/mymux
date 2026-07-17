# mymux — agent workflow notes

- After a development batch is done (code + typecheck/build + relevant `ui/ux/*check.mjs` checks all green), **git commit and push directly** — no need to ask. Per the owner (2026-07-17).
- Still ask first for anything beyond routine commit/push: force-push, history rewrites, branch surgery, releases/tags (CI publishes on `v*` tags), and outward-facing actions (PRs, issues, comments).
- UI changes must come with their `ui/ux/*check.mjs` coverage; run the related sweep before committing (see README *Develop* for the harness).
