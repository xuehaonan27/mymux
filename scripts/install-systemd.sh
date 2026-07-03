#!/usr/bin/env bash
# Install mymuxd as a persistent systemd --user service.
#
# Why: run under the user manager (not an SSH session scope) + linger, so the
# daemon and your tmux sessions survive an SSH disconnect. Restarting the daemon
# (systemctl --user restart mymuxd) then preserves the tmux server thanks to
# KillMode=process in the unit.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"        # repo root
BIN_SRC="$DIR/target/release/mymuxd"
BIN_DST="$HOME/.local/bin/mymuxd"
UNIT_DST="$HOME/.config/systemd/user/mymuxd.service"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "mymux: systemd --user is not available here." >&2
  echo "       Skip this — the connector's built-in 'setsid mymuxd' launcher is the fallback." >&2
  exit 1
fi

echo "mymux: building the release daemon…"
( cd "$DIR" && cargo build --release -p mymuxd )

mkdir -p "$(dirname "$BIN_DST")" "$(dirname "$UNIT_DST")"
install -m 0755 "$BIN_SRC" "$BIN_DST"
cp "$DIR/systemd/mymuxd.service" "$UNIT_DST"

# Survive SSH logout. enable-linger for your own user needs no root on most systems.
if loginctl enable-linger "$USER" 2>/dev/null; then
  echo "mymux: lingering enabled — the daemon survives logout."
else
  echo "mymux: could not enable-linger (the daemon will stop when you log out); ask an admin to run: loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable mymuxd.service
# restart (not start) so an update picks up the new binary — and proves the
# tmux-preserving restart path.
systemctl --user restart mymuxd.service

echo
echo "mymux: mymuxd.service is enabled + running:"
systemctl --user --no-pager --lines=0 status mymuxd.service 2>/dev/null | head -4 || true
echo
echo "  logs:     journalctl --user -u mymuxd -f"
echo "  restart:  systemctl --user restart mymuxd   # keeps your tmux sessions"
