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
  bash-language-server/               (dynamic npm install)
    pkg.json
    node_modules/.bin/bash-language-server
```

One directory per package, named by package id (dynamic installs derive the
directory from the spec via a `safe_dir` charset). A package is valid iff its
`pkg.json` parses and the paths it names exist. Consumers MUST ignore invalid
or unknown packages (forward compatibility), and MUST treat everything in a
manifest as data, never as shell.

## pkg.json

```json
{
  "v": 1,
  "name": "bash-language-server",
  "version": "5.6.0",
  "kind": "lsp-server",
  "langs": ["bash"],
  "args": ["start"],
  "bin": "node_modules/.bin/bash-language-server",
  "source": "npm",
  "spec": "npm:bash-language-server",
  "sha256": "…"
}
```

- `v` — contract version. Consumers skip packages with a `v` they don't know.
- `kind` — what the package provides. Defined kinds:
  - `lsp-server`: `langs` (language ids) + `bin` (path relative to the package
    dir, the language-server executable, stdio transport) + optional `args`
    (launch arguments, e.g. pyright's `--stdio`, bash-language-server's
    `start`). Empty `args` on a built-in language falls back to the daemon's
    defaults (pre-`args` manifests keep working).
  - `vsix-assets` / `npm-assets`: an extracted extension or npm package with
    no runnable server (grammars, themes, snippets); consumed by later phases.
  - `viewer` (reserved): the UI keeps a viewer registry (`ui/src/viewers.ts`)
    whose interface mirrors what a viewer package would provide — built-ins
    (image, hex) ship in the UI today; third-party loading is a later phase
    and will finalize this kind's manifest shape.
  - (future) `theme`, `grammar`, `agent-adapter` — added here first.
- `source` — informational provenance (`github-release` | `openvsx` |
  `go-install` | `npm` | `manual`).
- `spec` — for dynamic installs, the exact spec `mymux-pkg install` accepts
  (`openvsx:ns.name[@ver]`, `npm:pkg[@ver]`); lets the UI re-install/remove by
  spec and records where the files came from.
- `sha256` — artifact digest. Curated recipes PIN it (install fails on
  mismatch); dynamic installs RECORD it (audit trail — there is no pin to
  compare against on first install). npm relies on the registry's own
  integrity metadata instead.

## Acquisition channels & the ecosystem boundary

Two tiers, same boundary:

**Curated recipes** (pinned in `mymux-pkg`): upstream releases (GitHub etc.)
with pinned version + sha256; `go install` (checksum database); pinned npm.

**Dynamic installs** (user-initiated, no recipe):

- `mymux-pkg search <query>` — merges the curated catalog with live results
  from the Open VSX API and the npm registry. Network I/O happens on the
  machine running the command (through the daemon: the mymuxd host — which is
  the box that can actually reach the registries, not the browser).
- `mymux-pkg install openvsx:ns.name[@ver]` — resolves the version via the
  Open VSX API, downloads the VSIX, extracts it (`vsix-assets`), records the
  sha256.
- `mymux-pkg install npm:pkg[@ver]` — npm-installs into the package dir; if
  the package declares a `bin` it becomes a runnable `lsp-server` (bind
  languages below), else `npm-assets`.
- `mymux-pkg lang <pkg> <lang…> [-- <launch args…>]` — binds an installed
  package's executable to language ids (and its launch args). This is what
  makes a dynamic server reachable from the editor.
- `mymux-pkg remove <name | spec>` — specs map back to the install directory.

**Never** the Visual Studio Marketplace (its ToS restricts extensions to
Microsoft's own products) and **never** Microsoft's proprietary extensions
(Pylance, C/C++, Remote, Copilot — their EULAs bind them to official VS Code
regardless of where the file came from). Use the open equivalents (pyright,
clangd). Open VSX is allowed in full; prefer verified publishers
(supply-chain incident, 2026).

## Proxies (clusters whose egress needs one)

All registry traffic originates on the machine running `mymux-pkg` — for
panel-driven installs that is the mymuxd host. Proxy resolution, highest
wins:

1. `MYMUX_PROXY` — explicit mymux-only knob (curl gets it as `--proxy`; npm
   and go children get it exported as `HTTPS_PROXY`/`HTTP_PROXY`).
2. Standard variables: `https_proxy`/`HTTPS_PROXY`/`all_proxy`/`ALL_PROXY`/
   `http_proxy`/`HTTP_PROXY`. Empty values count as unset; `no_proxy`
   exclusions are honored by the tools themselves.
3. `~/.config/mymux/env` (`$MYMUX_CONFIG_DIR` overrides the dir) — plain
   `KEY=VALUE` lines (`export ` prefix and `#` comments tolerated), loaded as
   DEFAULTS by both `mymux-pkg` and `mymuxd` at startup (the process env
   always wins). This is the persistent place: a systemd-spawned mymuxd has a
   scrubbed environment, and its `EnvironmentFile=-%h/.config/mymux/env`
   unit line reads the same file. Example:

   ```
   https_proxy=http://proxy.corp:3128
   no_proxy=localhost,127.0.0.1,.corp
   ```

Network-class failures (resolve/connect/timeout/TLS) carry a hint: without a
proxy configured they point at this file; with one they name the proxy in
use. `search` degrades per-source and reports unreachable registries in a
`warnings` array instead of failing silently.

## Consumers today

- mymuxd `/lsp/info` + server spawn: resolution order is **managed package →
  user-configured path → PATH heuristic**. Managed resolution works for ANY
  language id present in a manifest's `langs` — including ones mymux has no
  built-in table entry for; `args` come from the manifest. Spawns get an
  augmented PATH (nvm node, `~/.cargo/bin`, `~/.local/bin`) so `#!/usr/bin/env
  node` servers run under systemd's minimal environment.
- mymuxd `GET /pkgs/catalog`, `GET /pkgs/search?q=`, `POST /pkgs/install
  {name}`, `POST /pkgs/remove {name}`: relayed to the CLI; `name` accepts
  curated names and dynamic specs (charset-validated, `..` rejected). The
  UI's packages panel (⌘K g) fronts these: curated catalog by default, a
  search box for the registries, install/remove per card. The daemon embeds
  no recipes or acquisition logic. Relayed CLI runs have hard deadlines
  (install 600s, remove 60s, search 45s, catalog 15s — timed-out children
  are killed), and install/remove are serialized PER PACKAGE NAME (a
  concurrent duplicate is rejected with an explanation; different packages
  run in parallel).
- mymuxd `POST /lsp/install {lang}` (legacy): runs `mymux-pkg install --lang
  <lang>`; superseded by the packages panel but kept for scripts.
- Philosophy: mymux never nags about missing packages — installs happen at
  the user's initiative from the panel.
