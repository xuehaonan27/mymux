#!/usr/bin/env bash
# build-release.sh — ONE command to a complete, self-contained mymux.dmg.
# Run it on the Mac (Tauri app builds are macOS-only):
#
#   scripts/build-release.sh
#
# What it does, end to end:
#   1. produces the daemon bundle (delegating to $MYMUX_BUILD_HOST when the
#      local box has no musl toolchain — that's the Mac case), skipping the
#      round trip when the bundle already matches this commit
#   2. builds the UI
#   3. cargo tauri build → .app/.dmg with the bundle embedded (ad-hoc signed)
#   4. drops the .dmg into dist/ and prints how to install it
#
# The result is the VS Code-style artifact: download/copy it, open, add a
# host, type the passphrase — nothing else to build or install anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
note() { printf 'mymux: %s\n' "$*"; }
die() { printf 'mymux: %s\n' "$*" >&2; exit 1; }

# ---- 1. daemon bundle (embedded for zero-touch installs) ---------------------
VER_FILE="$ROOT/src-tauri/resources/daemon/linux-x86_64.version"
CUR_REV="$(git -C "$ROOT" rev-parse --short HEAD)"
if [ -f "$VER_FILE" ] && grep -q "($CUR_REV)" "$VER_FILE" && [ -z "$(git -C "$ROOT" status --porcelain)" ]; then
  note "daemon bundle is current ($CUR_REV) — skipping the rebuild"
else
  note "building the daemon bundle (delegates when there's no local musl toolchain)…"
  "$ROOT/scripts/build-daemon-bundle.sh"
fi

# ---- 2. UI ---------------------------------------------------------------------
note "building the UI…"
( cd "$ROOT/ui" && npm install && npm run build )

# ---- 3. the app (macOS only) ----------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  note "bundle + UI done. The .dmg build needs a Mac — run this script there."
  exit 0
fi
command -v cargo-tauri >/dev/null 2>&1 || cargo tauri --version >/dev/null 2>&1 || \
  die "tauri-cli missing: cargo install tauri-cli --version '^2'"
note "cargo tauri build (ad-hoc signed)…"
( cd "$ROOT" && cargo tauri build )

# ---- 4. collect + instructions ----------------------------------------------------
mkdir -p "$DIST"
shopt -s nullglob
dmg=( "$ROOT"/src-tauri/target/release/bundle/dmg/*.dmg )
app=( "$ROOT"/src-tauri/target/release/bundle/macos/*.app )
[ ${#dmg[@]} -gt 0 ] || die "no .dmg produced — see the tauri output above"
cp "${dmg[@]}" "$DIST/"
note "done → $DIST/$(basename "${dmg[0]}") ($(du -h "$DIST/$(basename "${dmg[0]}")" | cut -f1))"
note "install: open the dmg, drag mymux.app to /Applications."
note "first launch of an ad-hoc-signed app: right-click → Open once (or:"
note "  xattr -dr com.apple.quarantine /Applications/mymux.app )"
note "zero-touch from there: add a host, type the passphrase — the app pushes"
note "and installs the daemon bundle itself."
