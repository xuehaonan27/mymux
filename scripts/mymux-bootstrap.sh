#!/usr/bin/env bash
# mymux-bootstrap.sh — install or upgrade mymuxd on a dev box in ONE command.
# Run from your Mac (or any machine with ssh + rsync and this repo checked out):
#
#   scripts/mymux-bootstrap.sh user@dev-box
#   scripts/mymux-bootstrap.sh user@dev-box --bin-dir /path/to/linux-binaries
#   scripts/mymux-bootstrap.sh user@dev-box --with-rustup   # box has no cargo
#
# What it does:
#   1. (--bin-dir only) rsyncs prebuilt binaries into ~/.local/bin on the box —
#      fast and toolchain-free; each file is verified to be a Linux ELF first
#   2. runs scripts/mymux-install-remote.sh ON the box over ssh — source build
#      when no binary is present, systemd --user services when available
#      (best-effort), and a daemon restart ONLY when something actually changed
#      (KillMode=process keeps your tmux sessions)
#
# Idempotent: a second run with nothing new reports "already current" and
# leaves the running daemon untouched.
set -euo pipefail

HOST=""
BIN_DIR=""
WITH_RUSTUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir needs a directory}"; shift 2 ;;
    --with-rustup) WITH_RUSTUP="--with-rustup"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) [ -z "$HOST" ] && HOST="$1" || { echo "unexpected arg: $1" >&2; exit 2; }; shift ;;
  esac
done
[ -n "$HOST" ] || { sed -n '2,17p' "$0" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINS=(mymuxd mymux-ptyd mymux-pkg mymux-attach)
CM="$HOME/.ssh/mymux-bootstrap-%r@%h:%p"
SSH=(ssh -o ControlMaster=auto -o ControlPath="$CM" -o ControlPersist=60)
RSYNC_SSH="ssh -o ControlMaster=auto -o ControlPath=$CM -o ControlPersist=60"

note() { printf 'mymux: %s\n' "$*"; }
die() { printf 'mymux: %s\n' "$*" >&2; exit 1; }

# ---- 0. reach the box; arch note ----------------------------------------------
REMOTE_ARCH="$("${SSH[@]}" "$HOST" 'uname -m')" || die "cannot ssh $HOST"
[ "$REMOTE_ARCH" = "$(uname -m)" ] || note "arch differs (local $(uname -m) vs remote $REMOTE_ARCH) — fine for a source build, NOT for --bin-dir"
"${SSH[@]}" "$HOST" 'command -v rsync >/dev/null' || die "rsync is not installed on $HOST"
INSTALLED="$("${SSH[@]}" "$HOST" '[ -x ~/.local/bin/mymuxd ] && timeout 2 ~/.local/bin/mymuxd --version 2>/dev/null || true')"
note "remote mymuxd: ${INSTALLED:-<none or outdated>}"

# ---- 1. (--bin-dir) push prebuilt binaries -------------------------------------
if [ -n "$BIN_DIR" ]; then
  paths=()
  for b in "${BINS[@]}"; do
    if [ -f "$BIN_DIR/$b" ]; then
      file "$BIN_DIR/$b" | grep -q 'ELF .*executable' || die "$BIN_DIR/$b is not a Linux ELF binary (wrong platform?)"
      paths+=("$BIN_DIR/$b")
    elif [ "$b" != "mymux-attach" ]; then
      die "$BIN_DIR/$b missing"
    else
      note "skipping optional $b (not in $BIN_DIR)"
    fi
  done
  note "installing ${#paths[@]} binaries from $BIN_DIR → ~/.local/bin …"
  "${SSH[@]}" "$HOST" 'mkdir -p ~/.local/bin'
  rsync -cz -e "$RSYNC_SSH" "${paths[@]}" "$HOST:~/.local/bin/"
fi

# ---- 2. run the box-side installer over ssh ------------------------------------
REPO_URL="$(git -C "$ROOT" config --get remote.origin.url || echo git@github.com:xuehaonan27/mymux.git)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
# shellcheck disable=SC2086
"${SSH[@]}" "$HOST" "MYMUX_REPO_URL=$(printf %q "$REPO_URL") MYMUX_BRANCH=$(printf %q "$BRANCH") bash -s -- $WITH_RUSTUP" < "$ROOT/scripts/mymux-install-remote.sh"

note "optional agent wiring (on the box): scripts/install-claude-hooks.sh / install-codex-notify.sh / install-kimi-hooks.sh / install-opencode-plugin.sh"
