# mymux package contract (v1)

The plugin system is deliberately decoupled from mymux so both can evolve on
their own schedules. The ONLY coupling is this on-disk contract: producers
(the `mymux-pkg` CLI today, anything else tomorrow) install packages under a
directory; consumers (mymuxd, the UI) scan it. Neither side links the other.

## Layout

```
~/.local/share/mymux/pkgs/            ($MYMUX_PKG_DIR overrides; XDG_DATA_HOME honored)
  rust-analyzer/
    pkg.json                          the manifest (below)
    bin/rust-analyzer                 files owned by the package
  clangd/
    pkg.json
    clangd_19.1.2/bin/clangd
```

One directory per package, named by package id. A package is valid iff its
`pkg.json` parses and the paths it names exist. Consumers MUST ignore invalid
or unknown packages (forward compatibility), and MUST treat everything in a
manifest as data, never as shell.

## pkg.json

```json
{
  "v": 1,
  "name": "rust-analyzer",
  "version": "2026-06-29",
  "kind": "lsp-server",
  "langs": ["rust"],
  "bin": "bin/rust-analyzer",
  "source": "github-release"
}
```

- `v` — contract version. Consumers skip packages with a `v` they don't know.
- `kind` — what the package provides. Defined kinds:
  - `lsp-server`: `langs` (language ids) + `bin` (path relative to the package
    dir, the language-server executable, stdio transport).
  - `viewer` (reserved): the UI keeps a viewer registry (`ui/src/viewers.ts`)
    whose interface mirrors what a viewer package would provide — built-ins
    (image, hex) ship in the UI today; third-party loading is a later phase
    and will finalize this kind's manifest shape.
  - (future) `theme`, `grammar`, `agent-adapter` — added here first.
- `source` — informational provenance (`github-release` | `openvsx` |
  `go-install` | `npm` | `manual`).

## Acquisition channels & the ecosystem boundary

`mymux-pkg` recipes may fetch from:

- **Upstream releases** (GitHub releases etc.) — preferred; pinned version +
  pinned sha256 baked into the recipe.
- **Open VSX** (`open-vsx.org`) — allowed in full; a VSIX is a zip and the
  recipe extracts the files it needs. Pin version + sha256; prefer verified
  publishers (supply-chain incident, 2026).
- **Toolchain installs** (`go install`, `npm`) — pinned versions.

**Never** the Visual Studio Marketplace (its ToS restricts extensions to
Microsoft's own products) and **never** Microsoft's proprietary extensions
(Pylance, C/C++, Remote, Copilot — their EULAs bind them to official VS Code
regardless of where the file came from). Use the open equivalents (pyright,
clangd).

## Consumers today

- mymuxd `/lsp/info` + server spawn: resolution order is **managed package →
  user-configured path → PATH heuristic** (the heuristic is now only a
  fallback).
- mymuxd `GET /pkgs/catalog`, `POST /pkgs/install {name}`, `POST /pkgs/remove
  {name}`: relayed to the CLI (`mymux-pkg catalog` emits the recipe directory
  as JSON with installed state merged) — the UI's packages panel (⌘K g). The
  daemon embeds no recipes or acquisition logic.
- mymuxd `POST /lsp/install {lang}` (legacy): runs `mymux-pkg install --lang
  <lang>`; superseded by the packages panel but kept for scripts.
- Philosophy: mymux never nags about missing packages — installs happen at
  the user's initiative from the panel.
