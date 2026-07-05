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

echo "mymux: building the release daemons…"
( cd "$DIR" && cargo build --release -p mymuxd -p mymux-ptyd -p mymux-pkg )

mkdir -p "$(dirname "$BIN_DST")" "$(dirname "$UNIT_DST")"
install -m 0755 "$BIN_SRC" "$BIN_DST"
install -m 0755 "$DIR/target/release/mymux-ptyd" "$HOME/.local/bin/mymux-ptyd"
install -m 0755 "$DIR/target/release/mymux-attach" "$HOME/.local/bin/mymux-attach"
install -m 0755 "$DIR/target/release/mymux-pkg" "$HOME/.local/bin/mymux-pkg"
cp "$DIR/systemd/mymuxd.service" "$UNIT_DST"
cp "$DIR/systemd/mymux-ptyd.service" "$HOME/.config/systemd/user/mymux-ptyd.service"

# Survive SSH logout. enable-linger for your own user needs no root on most systems.
if loginctl enable-linger "$USER" 2>/dev/null; then
  echo "mymux: lingering enabled — the daemon survives logout."
else
  echo "mymux: could not enable-linger (the daemon will stop when you log out); ask an admin to run: loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable mymuxd.service
systemctl --user enable mymux-ptyd.service
# ptyd holds persistent shells: START it if down, but never restart a live one
# from here (that would kill the shells it exists to protect).
if ! systemctl --user is-active --quiet mymux-ptyd.service; then
  systemctl --user start mymux-ptyd.service
else
  echo "mymux: mymux-ptyd left running (a restart would kill persistent shells);"
  echo "       run 'systemctl --user restart mymux-ptyd' yourself when idle."
fi
# restart (not start) so an update picks up the new binary — and proves the
# tmux-preserving restart path.
systemctl --user restart mymuxd.service

echo
echo "mymux: mymuxd.service is enabled + running:"
systemctl --user --no-pager --lines=0 status mymuxd.service 2>/dev/null | head -4 || true
echo
echo "  logs:     journalctl --user -u mymuxd -f"
echo "  restart:  systemctl --user restart mymuxd   # keeps your tmux sessions"
echo "  restart:  systemctl --user restart mymux-ptyd # NOTE: remote your sessions"
