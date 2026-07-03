# LSP plan — native LSP in mymux's panel (C-first)

Goal (user, 2026-07-03): LSP in mymux, with the VS Code ecosystem's *artifacts*
(install rust-analyzer from Open VSX) but **not** a stitched-in VS Code.
**DECIDED 2026-07-03: C-first** — embedding openvscode-server (route A) was
judged too heavy *as a product* (identity dilution: mymux exists partly to not
need VS Code; two editors in one app; ongoing maintenance of someone else's
IDE), even though its RAM cost is dominated by rust-analyzer on every route.
Route A is demoted to an arm's-length optional script, never stitched into the
app.

## Routes assessed

### A. Run openvscode-server per host (full VS Code Web) — DEMOTED to arm's-length optional
[openvscode-server](https://github.com/gitpod-io/openvscode-server) is upstream
VS Code with only the server bits added (Gitpod-maintained). Assessment kept
for reference — if a full IDE (extension UIs, DAP debugging) is ever needed,
the shape is: a standalone install script on the host + open the system
browser; **not** integrated into the app. What it would give that C never
will: debuggers (DAP), extension webviews/themes, zero-per-language work.

### B. Build a `vscode.*` extension-host compatibility layer — RULED OUT
The honest assessment the user asked for: the `vscode.*` API surface is huge
and moving; Eclipse Theia — years of work by a funded team — still tracks it
with gaps. For this project it is not "hard", it is a multi-year detour. If A's
UX is unacceptable, the fallback is C, not B.

### C. LSP in OUR CodeMirror panel, servers taken from ecosystem artifacts — **CHOSEN (C-first)**
The 2026 CodeMirror LSP story is mature: the official
[`@codemirror/lsp-client`](https://github.com/codemirror/lsp-client) (MIT, by
the CodeMirror author; completion/hover/diagnostics/goto/rename/references,
transport-agnostic — fits our WS) or the batteries-included
[`codemirror-languageserver`](https://github.com/FurqanSoftware/codemirror-languageserver)
(+ the [marimo fork](https://github.com/marimo-team/codemirror-languageserver)
with code actions).

- **Daemon**: an `/lsp` WS endpoint; mymuxd spawns and supervises one language
  server per (workspace root, language) and bridges stdio LSP framing ↔ WS —
  process lifecycle we already do well.
- **Ecosystem flavor**: acquire servers from Open VSX VSIXs (`mymux lsp
  install rust-lang.rust-analyzer` → download, extract the bundled per-platform
  server binary), falling back to PATH (`rustup component add rust-analyzer`).
- **Limits (be explicit)**: LSP features only — no DAP debugging, no extension
  UIs/webviews/themes, no non-LSP extensions. Rust/Go/Python/TS/C++ ✓;
  "any extension" ✗.
- Effort MEDIUM; phase inside it: diagnostics + hover first, completion/goto
  second, code actions third. Start with rust-analyzer only (dogfood).

### D. Swap CodeMirror for Monaco — RULED OUT
Monaco is VS Code's *editor widget*, not its extension host — you get the look,
still zero extensions, and lose our CodeMirror investment. No.

## Plan (C-first)

- **C1 — foundation + read features**: daemon `lsp.rs` — supervise one language
  server per (workspace root, language), starting with rust-analyzer resolved
  from PATH; a `/lsp` WebSocket on the existing `:8088` (no new tunnel/ports)
  bridging WS messages ↔ stdio LSP framing (`Content-Length`). UI: a thin
  `ui/src/lsp.ts` seam wrapping `@codemirror/lsp-client` (transport = our WS);
  wire into the ⌘E editor: **diagnostics + hover** first.
- **C2 — write features**: completion, go-to-definition (opens the target file
  in the panel), rename, signature help. Evaluate the marimo fork if code
  actions are wanted before the official client grows them.
- **C3 — ecosystem acquisition + languages**: `mymux lsp install
  <open-vsx-id>` — download the VSIX from Open VSX, extract the bundled
  per-platform server binary (rust-analyzer ships it), register it; then gopls
  / pyright / clangd. Version-pin + prefer verified publishers (Open VSX had a
  2026 supply-chain incident).

**Client-library choice (`@codemirror/lsp-client`) and the replacement
principles.** An LSP client decomposes into three layers, and their portability
is what makes today's choice safe:

| Layer | What it is | Fate if mymux self-builds an editor later |
|---|---|---|
| **Transport** | the WS to the daemon | kept as-is (it's ours already) |
| **Protocol** | JSON-RPC, request lifecycle, document-sync bookkeeping | editor-agnostic; a modest re-implementation (hundreds of lines) |
| **Bindings** | how squiggles / hover tooltips / completion popups render *inside* the editor | rewritten **by definition** — this layer IS editor integration, under any library |

Since the only non-portable layer (bindings) is inherently tied to whichever
editor exists, no library choice today creates lock-in; self-building the LSP
client would be the *small* part of a future self-built editor. Two guardrails
keep the swap surface minimal:

1. **The daemon speaks raw, standard LSP** on `/lsp` — no private semantics —
   so any future frontend (a self-built editor, even third-party tools) talks
   to it unchanged; the daemon side is 100% reusable.
2. **The library is confined behind one thin seam, `ui/src/lsp.ts`** — swapping
   implementations later touches that file plus bindings, nothing else.

Same philosophy as the tmux replacement: **the protocol is ours; the
implementation is replaceable.**

## Security notes
- openvscode-server must bind localhost + require its connection token (since
  v1.64 it is unauthenticated without one); the token travels only over the
  authenticated SSH channel.
- Open VSX had a 2026 supply-chain incident (malicious extensions; publisher
  verification + scanning added since) — pin extension versions where possible
  and prefer verified publishers.
- rust-analyzer RAM (1-4 GB on big workspaces) dominates the resource budget on
  every route; it is the price of the feature, not of the architecture.
