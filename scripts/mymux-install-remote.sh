#!/usr/bin/env bash
# mymux-install-remote.sh — install or upgrade mymuxd ON THIS BOX. Fully
# self-contained (nothing here needs the repo):
#
#   bash mymux-install-remote.sh [--with-rustup]
#
# Steps: binaries (a source build into ~/.local/bin, skipped when a mymuxd
# binary is already in place — e.g. rsync'd prebuilt) → systemd --user units
# (embedded below) → (re)start the daemon ONLY when the installed state
# actually changed (KillMode=process keeps tmux sessions).
#
# Used by scripts/mymux-bootstrap.sh (the ssh driver) and by the mymux app's
# zero-touch install (embedded via include_str!). Optional env: MYMUX_REPO_URL,
# MYMUX_BRANCH (source-build provenance).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
WITH_RUSTUP="${1:-}"
REPO_URL="${MYMUX_REPO_URL:-git@github.com:xuehaonan27/mymux.git}"
BRANCH="${MYMUX_BRANCH:-main}"
STATE="$HOME/.local/share/mymux"
BINS="$HOME/.local/bin"
mkdir -p "$STATE" "$BINS" "$HOME/.config/systemd/user"
note() { printf 'mymux: %s\n' "$*"; }

# Any LIVE process named $1? Prints its pid. pgrep also matches <defunct>
# zombies (an un-reaped setsid orphan would suppress the fallback launch).
alive() {
  for pid in $(pgrep -x "$1" 2>/dev/null); do
    if ! grep -q ') Z' "/proc/$pid/stat" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

# ---- 1. binaries -------------------------------------------------------------
DIST="$STATE/dist"
if [ -f "$DIST/daemon.tgz" ]; then
  # A self-contained bundle pushed by the app (zero-touch install/repair):
  # extract, verify checksums, atomically swap into ~/.local/bin (rename-over,
  # so a running process keeps its inode). ptyd's BINARY is updated on disk
  # too, but a RUNNING ptyd is never restarted here — persistent shells hang
  # off it; the new code takes effect at its next manual, idle-time restart.
  note "installing from the shipped bundle…"
  rm -rf "$DIST/new"
  mkdir -p "$DIST/new"
  tar -xzf "$DIST/daemon.tgz" -C "$DIST/new"
  ( cd "$DIST/new" && sha256sum -c SHA256SUMS >/dev/null )
  for b in mymuxd mymux-ptyd mymux-pkg mymux-attach; do
    [ -f "$DIST/new/$b" ] || continue
    install -m 0755 "$DIST/new/$b" "$BINS/.$b.new"
    mv -f "$BINS/.$b.new" "$BINS/$b"
  done
  note "bundle installed: $(cat "$DIST/new/VERSION")"
  rm -rf "$DIST/new" "$DIST/daemon.tgz"
elif [ -x "$BINS/mymuxd" ]; then
  note "using the binaries already in ~/.local/bin"
else
  if ! command -v cargo >/dev/null 2>&1; then
    if [ "$WITH_RUSTUP" = "--with-rustup" ]; then
      note "installing rustup…"
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
      . "$HOME/.cargo/env"
    else
      echo "mymux: cargo not found on this box — install rustup, or have the driver use --bin-dir" >&2
      exit 1
    fi
  fi
  SRC="$HOME/.local/src/mymux"
  mkdir -p "$SRC"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC" reset --hard FETCH_HEAD
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC"
  fi
  HEAD="$(git -C "$SRC" rev-parse HEAD)"
  if [ "$HEAD" != "$(cat "$STATE/.built-rev" 2>/dev/null || true)" ]; then
    note "building release daemons (${HEAD:0:8})…"
    # mymux-attach is a bin target of the mymux-ptyd package, not its own package.
    ( cd "$SRC" && cargo build --release -p mymuxd -p mymux-ptyd -p mymux-pkg )
    install -m 0755 "$SRC"/target/release/{mymuxd,mymux-ptyd,mymux-pkg,mymux-attach} "$BINS/"
    echo "$HEAD" > "$STATE/.built-rev"
    note "binaries updated to ${HEAD:0:8}"
  else
    note "binaries already match ${HEAD:0:8}"
  fi
fi

# ---- 2. systemd units (embedded; systemd/ in the repo is the source) -----------
MYMUXD_UNIT='[Unit]
Description=mymux daemon — tmux control-mode bridge for the mymux workspace
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/mymuxd

# CRITICAL: only signal mymuxd itself on stop/restart. The tmux server it drives
# lives in this cgroup but MUST survive a mymuxd restart — it holds your sessions.
KillMode=process

Restart=on-failure
RestartSec=2

# systemd --user gives services a minimal PATH; include the per-user tool dirs
# so language servers (rust-analyzer via rustup, etc.) resolve.
Environment=PATH=%h/.cargo/bin:%h/.local/bin:%h/go/bin:/usr/local/bin:/usr/bin:/bin

# User environment defaults (proxy / MYMUX_* knobs). `-` = optional.
EnvironmentFile=-%h/.config/mymux/env

[Install]
WantedBy=default.target'
PTYD_UNIT='[Unit]
Description=mymux ptyd — persistent-pane holder (PTYs + terminal grids)

[Service]
Type=simple
# Socket lives in $XDG_RUNTIME_DIR/mymux/ptyd.sock.
RuntimeDirectory=mymux
ExecStart=%h/.local/bin/mymux-ptyd
Restart=on-failure
RestartSec=2

# NOTE: restarting THIS service kills every persistent shell it holds. Restart
# it only when idle.

[Install]
WantedBy=default.target'
[ "$MYMUXD_UNIT" != "$(cat "$HOME/.config/systemd/user/mymuxd.service" 2>/dev/null || true)" ] && printf '%s\n' "$MYMUXD_UNIT" > "$HOME/.config/systemd/user/mymuxd.service"
[ "$PTYD_UNIT" != "$(cat "$HOME/.config/systemd/user/mymux-ptyd.service" 2>/dev/null || true)" ] && printf '%s\n' "$PTYD_UNIT" > "$HOME/.config/systemd/user/mymux-ptyd.service"

# ---- 3. restart only when the installed state changed --------------------------
NEWSHA="$( { sha256sum "$BINS"/{mymuxd,mymux-ptyd,mymux-pkg} 2>/dev/null; cat "$HOME"/.config/systemd/user/mymux*.service; } | sha256sum )"
OLDSHA="$(cat "$STATE/.state-sha" 2>/dev/null || true)"
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable mymuxd.service mymux-ptyd.service
  if loginctl enable-linger "$USER" 2>/dev/null; then
    note "lingering enabled"
  else
    note "could not enable-linger (the daemon will stop at logout)"
  fi
  if ! systemctl --user is-active --quiet mymux-ptyd.service; then
    systemctl --user start mymux-ptyd.service
    note "ptyd started"
  fi
  if [ "$NEWSHA" != "$OLDSHA" ] || ! systemctl --user is-active --quiet mymuxd.service; then
    systemctl --user restart mymuxd.service
    note "mymuxd (re)started — tmux sessions preserved (KillMode=process)"
  else
    note "mymuxd already current — left running"
  fi
else
  alive mymuxd || { setsid mymuxd >/tmp/mymuxd.log 2>&1 </dev/null & }
  note "no systemd --user — mymuxd runs detached (dies at logout)"
fi
echo "$NEWSHA" > "$STATE/.state-sha"
# The setsid fallback can take a beat to fork — give the final check a moment.
for _ in $(seq 20); do alive mymuxd >/dev/null && break; sleep 0.2; done
alive mymuxd && note "mymuxd running (pid $(alive mymuxd))" || { echo "mymux: mymuxd is NOT running — see /tmp/mymuxd.log or journalctl --user -u mymuxd" >&2; exit 1; }
