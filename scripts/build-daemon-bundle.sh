#!/usr/bin/env bash
# build-daemon-bundle.sh — build the self-contained daemon bundle the APP
# ships to hosts (zero-touch install / repair). Produces musl-static Linux
# binaries, a VERSION file (exactly what `mymuxd --version` prints, so the app
# can compare a host's probe against it), and SHA256SUMS, packed as
#
#   src-tauri/resources/daemon/linux-x86_64.tar.gz  (+ .version sidecar)
#
# which mymux-connect embeds at app build time (include_bytes!; build.rs there
# tolerates the file being absent — the install path then errors clearly).
# musl-static = no glibc-version skew on any distro. x86_64 only for now;
# aarch64 needs an aarch64-musl cross toolchain.
#
# Run it ANYWHERE: without a local musl toolchain (e.g. on a Mac) it delegates
# the build to a Linux host — $MYMUX_BUILD_HOST, else
# ~/.config/mymux/build-host — by rsyncing this working tree over, building
# there, and pulling the bundle back. One command, no Mac-side toolchain.
set -euo pipefail
# Non-interactive contexts (ssh build delegation, CI) have a scrubbed PATH.
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# A script copied out of the repo resolves ROOT to somewhere else — building
# (or worse, rsyncing) from there can be catastrophic. Refuse early.
[ -f "$ROOT/Cargo.toml" ] || die "ROOT resolved to $ROOT (no Cargo.toml) — run this from inside the mymux repo"
TARGET="x86_64-unknown-linux-musl"
OUT="$ROOT/src-tauri/resources/daemon"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

note() { printf 'mymux: %s\n' "$*"; }
die() { printf 'mymux: %s\n' "$*" >&2; exit 1; }

# ---- delegate when there's no local musl toolchain (macOS, minimal images) --
if ! command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then
  BUILD_HOST="${MYMUX_BUILD_HOST:-}"
  [ -n "$BUILD_HOST" ] || BUILD_HOST="$(cat "${MYMUX_CONFIG_DIR:-$HOME/.config/mymux}/build-host" 2>/dev/null || true)"
  [ -n "$BUILD_HOST" ] || die "no musl-gcc here and no build host — set MYMUX_BUILD_HOST=user@linuxbox (or write it to ~/.config/mymux/build-host)"
  REMOTE='~/.cache/mymux-bundle-build'
  note "no musl-gcc here — delegating the build to $BUILD_HOST …"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$BUILD_HOST" true 2>/dev/null || die "cannot reach $BUILD_HOST (check ssh access, or install musl-tools locally)"
  ssh "$BUILD_HOST" "mkdir -p $REMOTE"
  # The tree being bundled must match the app being built — sync it as-is
  # (dirty worktree included), excluding build outputs and old bundles.
  rsync -a --delete \
    --exclude target --exclude node_modules \
    --exclude 'src-tauri/resources/daemon' \
    "$ROOT/" "$BUILD_HOST:$REMOTE/"
  ssh "$BUILD_HOST" "cd $REMOTE && scripts/build-daemon-bundle.sh"
  mkdir -p "$OUT"
  rsync -av "$BUILD_HOST:$REMOTE/src-tauri/resources/daemon/" "$OUT/"
  note "bundle pulled back → $OUT ($(du -h "$OUT/linux-x86_64.tar.gz" | cut -f1), $(cat "$OUT/linux-x86_64.version"))"
  exit 0
fi

rustup target add "$TARGET" >/dev/null

echo "mymux: building $TARGET release daemons…"
( cd "$ROOT" && CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc \
    cargo build --release --target "$TARGET" -p mymuxd -p mymux-ptyd -p mymux-pkg )

B="$ROOT/target/$TARGET/release"
for b in mymuxd mymux-ptyd mymux-pkg mymux-attach; do
  [ -f "$B/$b" ] || { echo "mymux: $B/$b missing after the build" >&2; exit 1; }
  # musl-strip if available, else plain strip (both read ELF); strip is
  # best-effort — an unstripped binary still works.
  ( x86_64-linux-musl-strip "$B/$b" 2>/dev/null || strip "$B/$b" 2>/dev/null || true )
  install -m 0755 "$B/$b" "$STAGE/$b"
done

# VERSION must be byte-identical to the pushed mymuxd's own --version output.
"$STAGE/mymuxd" --version > "$STAGE/VERSION"
( cd "$STAGE" && sha256sum mymuxd mymux-ptyd mymux-pkg mymux-attach > SHA256SUMS )

mkdir -p "$OUT"
tar -czf "$OUT/linux-x86_64.tar.gz" -C "$STAGE" .
cp "$STAGE/VERSION" "$OUT/linux-x86_64.version"
echo "mymux: bundle → $OUT/linux-x86_64.tar.gz ($(du -h "$OUT/linux-x86_64.tar.gz" | cut -f1))"
echo "mymux: version: $(cat "$STAGE/VERSION")"
