#!/usr/bin/env bash
# ci-build-daemon-matrix.sh — build the daemon for EVERY supported host
# architecture and emit the manifest (bundles.json) the client downloads
# against. This is the CI/OS-independent half of the release pipeline: the
# same script runs on your Mac-run Gitea runner (release.yml) and locally.
#
# Outputs (in $OUT, default <repo>/release/artifacts):
#   linux-x86_64.tar.gz  linux-aarch64.tar.gz   (daemons + VERSION + SHA256SUMS)
#   linux-<arch>.version (byte-identical to `mymuxd --version`)
#   SHA256SUMS           (per-arch tarballs + versions)
#   bundles.json         { version, baseUrl, assets: { <key>: {name, sha256, size} } }
#
# x86_64 builds with the system musl-gcc. aarch64 goes through
# cargo-zigbuild; the zig toolchain is bootstrapped (sha256-pinned) into
# ~/.cache/mymux-ci on first use — no system packages required.
#
# Knobs:
#   TAGBASE   — if set, bundles.json's baseUrl (e.g.
#               https://gitea.aka.cy/XueHaonan/mymux/releases/download/v0.1.0-abc1234)
#   OUT       — alternate output dir
#   SKIP_AARCH64=1 — only build x86_64 (fast local iteration)
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/release/artifacts}"
CACHE="${MYMUX_CI_CACHE:-$HOME/.cache/mymux-ci}"
TARGETS=(x86_64-unknown-linux-musl)
[ "${SKIP_AARCH64:-0}" = "1" ] || TARGETS+=(aarch64-unknown-linux-musl)
BINS=(mymuxd mymux-ptyd mymux-pkg mymux-attach)

note() { printf 'mymux-ci: %s\n' "$*"; }
die() { printf 'mymux-ci: %s\n' "$*" >&2; exit 1; }

VERSION_FILE="$(mktemp)"
trap 'rm -f "$VERSION_FILE"' EXIT

# ---- zig toolchain bootstrap (pinned; needed for cargo-zigbuild) -------------
ZIG_VER="0.13.0"
ZIG_CACHE="$CACHE/zig-$ZIG_VER"
ZIG_TARBALL="$CACHE/zig-linux-x86_64-$ZIG_VER.tar.xz"
ZIG_SHA256="d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea"
zig_mirror_list() {
    cat <<'MIRRORS'
https://ziglang.org/download
https://pkg.machengine.org/zig
https://mirror.aakashadm.com/zig
MIRRORS
}
ensure_zig() {
    [ -x "$ZIG_CACHE/zig" ] && return 0
    mkdir -p "$CACHE"
    local ok=""
    for base in $(zig_mirror_list); do
        note "downloading zig $ZIG_VER from $base …"
        if curl -sfL --connect-timeout 15 -o "$ZIG_TARBALL.tmp" "$base/zig-linux-x86_64-$ZIG_VER.tar.xz"; then
            ok=1; break
        fi
        note "  …mirror failed, trying next"
    done
    [ -n "$ok" ] || die "all zig mirrors failed"
    echo "$ZIG_SHA256  $ZIG_TARBALL.tmp" | sha256sum -c - >/dev/null || die "zig tarball sha256 mismatch"
    mkdir -p "$ZIG_CACHE"
    # The archive holds one top-level zig-linux-x86_64-<ver>/ dir.
    tar -xJf "$ZIG_TARBALL.tmp" -C "$CACHE"
    rm -rf "$ZIG_CACHE.old.$$"
    mv "$ZIG_CACHE" "$ZIG_CACHE.old.$$" 2>/dev/null || true
    mv "$CACHE/zig-linux-x86_64-$ZIG_VER" "$ZIG_CACHE"
    rm -rf "$ZIG_CACHE.old.$$" "$ZIG_TARBALL.tmp"
    note "zig $ZIG_VER cached at $ZIG_CACHE"
}

# ---- one target ----------------------------------------------------------------
build_one() {
    local target="$1" stage
    stage="$(mktemp -d)"
    case "$target" in
        x86_64-unknown-linux-musl | aarch64-unknown-linux-musl)
            # One toolchain serves both arches: cargo-zigbuild (zig cc links
            # musl). No apt/system packages — k3s runners with broken apt or
            # DNS-hanging mirrors can't bite. musl-gcc stays an explicit
            # fallback for local dev (USE_MUSL_GCC=1).
            if [ "${USE_MUSL_GCC:-0}" = "1" ] && [ "$target" = "x86_64-unknown-linux-musl" ]; then
                note "building $target (system musl-gcc, USE_MUSL_GCC=1)…"
                command -v x86_64-linux-musl-gcc >/dev/null || die "x86_64-linux-musl-gcc missing (apt install musl-tools)"
                rustup target add "$target" >/dev/null
                ( cd "$ROOT" && CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc \
                    cargo build --release --target "$target" -p mymuxd -p mymux-ptyd -p mymux-pkg )
            else
                note "building $target (cargo-zigbuild)…"
                ensure_zig
                rustup target add "$target" >/dev/null
                if ! command -v cargo-zigbuild >/dev/null 2>&1; then
                    note "installing cargo-zigbuild (first time)…"
                    cargo install cargo-zigbuild --locked
                fi
                ( cd "$ROOT" && PATH="$ZIG_CACHE:$PATH" \
                    cargo zigbuild --release --target "$target" -p mymuxd -p mymux-ptyd -p mymux-pkg )
            fi
            ;;
        *) die "unknown target $target" ;;
    esac
    local B="$ROOT/target/$target/release"
    for b in "${BINS[@]}"; do
        [ -f "$B/$b" ] || die "$B/$b missing after build"
        install -m 0755 "$B/$b" "$stage/$b"
    done
    ( x86_64-linux-musl-strip "$stage"/* 2>/dev/null || strip "$stage"/* 2>/dev/null || true )
    # VERSION is crate version + git rev — identical per arch by construction,
    # and cross-built binaries don't execute on the build host. Compute it on
    # the x86_64 leg, reuse everywhere.
    if [ "$target" = "x86_64-unknown-linux-musl" ]; then
        "$stage/mymuxd" --version > "$stage/VERSION"
        cp "$stage/VERSION" "$VERSION_FILE"
    else
        cp "$VERSION_FILE" "$stage/VERSION"
    fi
    ( cd "$stage" && sha256sum "${BINS[@]}" > SHA256SUMS )
    mkdir -p "$OUT"
    local key="${target%%-unknown-linux-musl}" # x86_64 | aarch64
    key="linux-$key"
    tar -czf "$OUT/$key.tar.gz" -C "$stage" .
    cp "$stage/VERSION" "$OUT/$key.version"
    rm -rf "$stage"
    note "$key.tar.gz → $OUT ($(du -h "$OUT/$key.tar.gz" | cut -f1))"
}

for t in "${TARGETS[@]}"; do
    build_one "$t"
done

# ---- sums + manifest -------------------------------------------------------------
VERSION="$(cat "$OUT/linux-x86_64.version")"
mkdir -p "$OUT"
( cd "$OUT" && sha256sum linux-*.tar.gz linux-*.version > SHA256SUMS )

if [ -n "${TAGBASE:-}" ]; then
    BASE_URL="$TAGBASE"
else
    BASE_URL=""
fi
VERSION="$VERSION" BASE_URL="$BASE_URL" OUT="$OUT" python3 - <<'PY'
import hashlib, json, os
out = os.environ["OUT"]
assets = {}
for key in ("linux-x86_64", "linux-aarch64"):
    p = os.path.join(out, f"{key}.tar.gz")
    if not os.path.exists(p):
        continue
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    assets[key] = {"name": f"{key}.tar.gz", "sha256": h.hexdigest(), "size": os.path.getsize(p)}
manifest = {
    "channel": "gitea",
    "version": os.environ["VERSION"],
    "baseUrl": os.environ.get("BASE_URL", ""),
    "assets": assets,
}
with open(os.path.join(out, "bundles.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
note "bundles.json → $OUT/bundles.json"
note "version: $VERSION"
note "done — publish with: TAG=<tag> scripts/ci-publish-release.sh"
