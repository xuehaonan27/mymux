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
  - `npm-assets`: an extracted npm package with no runnable server; consumed
    by later phases.
  - `viewer` (reserved): the UI keeps a viewer registry (`ui/src/viewers.ts`)
    whose interface mirrors what a viewer package would provide — built-ins
    (image, hex) ship in the UI today; third-party loading is a later phase
    and will finalize this kind's manifest shape.
  - (future) `theme`, `grammar`, `agent-adapter` — added here first.
- `source` — informational provenance (`github-release` | `go-install` |
  `npm` | `manual`).
- `spec` — for dynamic installs, the exact spec `mymux-pkg install` accepts
  (`npm:pkg[@ver]`); lets the UI re-install/remove by spec and records where
  the files came from.
- `sha256` — artifact digest. Curated recipes PIN it (install fails on
  mismatch); dynamic installs RECORD it (audit trail — there is no pin to
  compare against on first install). npm relies on the registry's own
  integrity metadata instead.

## Acquisition channels & the ecosystem boundary

Two tiers, same boundary:

**The index** (`index/index.json` at the repo root — DATA, not code): the
curated tier. Each entry maps a friendly name to a pinned source plus
PREWIRED capability config, so `mymux-pkg install <name>` (or one panel
click) lands a fully-working package — langs and launch args go straight
into the manifest, no separate binding step:

```json
"bash-language-server": {
  "title": "Bash language server",
  "kind": "lsp-server",
  "langs": ["bash"],
  "args": ["start"],
  "version": "5.6.0",
  "channel": { "type": "npm", "package": "bash-language-server",
               "bin": "node_modules/.bin/bash-language-server" }
}
```

- Channel types: `github-gz` / `github-zip` / `github-bin` (pinned release
  URL + sha256 + bin), `go` (module, checksum-db verified), `npm` (pinned
  version; `extras` for companion packages — typescript-language-server
  ships `typescript` alongside; empty `bin` = auto-detect).
- The file is embedded into `mymux-pkg` at build time (works offline /
  air-gapped). An optional overlay — `$MYMUX_INDEX` path, else
  `<config>/index.json` — merges over it, overlay wins per name: users pin
  different versions or add private entries without forking the base.
- Unit tests validate every entry (parse, langs uniqueness, https
  GitHub-only release URLs, 64-hex sha256, relative bins) and enforce the
  ecosystem boundary over the index content. Community contributions are
  PRs against this file; review + tests are the trust layer.

**Dynamic installs** (user-initiated, anything not in the index):

- `mymux-pkg search <query>` — searches the curated index only. The catalog
  is mymux's whole package ecosystem: registries are install *channels* for
  pinned entries, never browse sources in the UI.
- `mymux-pkg install npm:pkg[@ver]` — npm-installs into the package dir; if
  the package declares a `bin` it becomes a runnable `lsp-server` (bind
  languages below), else `npm-assets`. This explicit spec form is the
  escape hatch for servers the index doesn't carry yet.
- `mymux-pkg lang <pkg> <lang…> [-- <launch args…>]` — binds an installed
  package's executable to language ids (and its launch args). Needed only
  for dynamic installs; index entries come prewired.
- `mymux-pkg remove <name | spec>` — specs map back to the install directory.

**Never** the Visual Studio Marketplace (its ToS restricts extensions to
Microsoft's own products) and **never** Microsoft's proprietary extensions
(Pylance, C/C++, Remote, Copilot — their EULAs bind them to official VS Code
regardless of where the file came from). Use the open equivalents (pyright,
clangd). Open VSX was a channel until 2026-07-15 — removed: the consumable
surface (declarative assets only; extension-host code is never executed by
design) was too small to justify the channel's cost, and npm covers the
dynamic-install case.

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
use.

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
  search box over the same catalog, install/remove per card. The daemon embeds
  no recipes or acquisition logic. Relayed CLI runs have hard deadlines
  (install 600s, remove 60s, search 45s, catalog 15s — timed-out children
  are killed), and install/remove are serialized PER PACKAGE NAME (a
  concurrent duplicate is rejected with an explanation; different packages
  run in parallel).
- mymuxd `POST /lsp/install {lang}` (legacy): runs `mymux-pkg install --lang
  <lang>`; superseded by the packages panel but kept for scripts.
- Philosophy: mymux never nags about missing packages — installs happen at
  the user's initiative from the panel.
