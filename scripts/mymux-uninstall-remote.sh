#!/usr/bin/env bash
# mymux-uninstall-remote.sh — remove mymux from THIS box. Self-contained
# (nothing here needs the repo), the mirror of mymux-install-remote.sh.
#
#   bash mymux-uninstall-remote.sh --probe   # read-only work/artifact report
#   bash mymux-uninstall-remote.sh --yes     # actually uninstall
#   bash mymux-uninstall-remote.sh           # probe + usage; refuses to act
#
# The mymux app drives this over SSH: --probe first (its report becomes the
# "work is running" warning in the UI), --yes only after the user confirms.
#
# Probe output is TAB-delimited, one row per line (parsed by mymux-connect):
#   pane  tmux|ptyd  <ref>   <detail…>     a live shell/process mymux holds
#   svc   <unit>     <state>               systemd --user unit state
#   proc  <name>     <count>               stray processes (non-systemd too)
#   bin|unit|dir|file  <path>              artifact that --yes removes
#   keep  <path>                           artifact deliberately left behind
set -uo pipefail
note() { printf 'mymux: %s\n' "$*"; }
row() { printf '%s\n' "$*"; }
# $USER is not guaranteed (docker exec, some ssh forced-commands): fall back.
USER_NAME="${USER:-$(id -un 2>/dev/null || echo unknown)}"

BINS="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
STATE="$HOME/.local/share/mymux"
HISTORY="$HOME/.local/state/mymux"
SRC="$HOME/.local/src/mymux"
CONF="$HOME/.config/mymux"
RTSOCK="${XDG_RUNTIME_DIR:-}/mymux"
USOCK="/tmp/mymux-ptyd-${USER_NAME}.sock"

have_systemd() { systemctl --user show-environment >/dev/null 2>&1; }

svc_state() { # <unit> → active|inactive|failed|<systemctl text>|not-installed
  systemctl --user cat "$1" >/dev/null 2>&1 || { echo not-installed; return; }
  systemctl --user is-active "$1" 2>/dev/null || true
}

WORK=0 # live panes the uninstall would kill (read by the --yes preamble)

probe() {
  # --- live work: tmux windows (mymuxd's side) ---
  # Loops read from here-strings, not pipelines: WORK must survive in THIS shell.
  if tmux -L mymux has-session 2>/dev/null; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      ref="${line%%|*}"; rest="${line#*|}"; cmd="${rest%%|*}"; win="${rest#*|}"
      row "pane	tmux	$ref	$cmd	$win"
      WORK=$((WORK + 1))
    done <<< "$(tmux -L mymux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}|#{pane_current_command}|#{window_name}' 2>/dev/null)"
  fi
  # --- live work: persistent panes (ptyd's side) ---
  for attach in "$BINS/mymux-attach" "$(command -v mymux-attach 2>/dev/null || true)"; do
    [ -x "$attach" ] || continue
    # `ls` prints to stderr: "  <short> <⌁|∞> <name, col 20> pid <pid> …"
    while IFS="$(printf '\t')" read -r short kind name pid; do
      [ -n "$short" ] || continue
      name="$(printf '%s' "$name" | sed 's/ *$//')"
      row "pane	ptyd	$short	$kind	$name	pid $pid"
      WORK=$((WORK + 1))
    done <<< "$("$attach" ls 2>&1 | sed -n 's/^  \([0-9][0-9]*\) *\(.\) *\(.\{1,20\}\)  *pid \([0-9][0-9]*\).*/\1\t\2\t\3\t\4/p')"
    break
  done
  # --- services + stray processes ---
  if have_systemd; then
    row "svc	mymuxd.service	$(svc_state mymuxd.service)"
    row "svc	mymux-ptyd.service	$(svc_state mymux-ptyd.service)"
  else
    row "svc	systemd	absent (processes are detached)"
  fi
  for p in mymuxd mymux-ptyd; do
    # Count live processes only: pgrep also matches zombies (a setsid orphan
    # under a sleep-PID-1 container stays <defunct> until reaped).
    n=0
    for pid in $(pgrep -x "$p" 2>/dev/null); do
      grep -q ') Z' "/proc/$pid/stat" 2>/dev/null && continue
      n=$((n + 1))
    done
    row "proc	$p	$n"
  done
  # --- artifacts on disk ---
  for b in mymuxd mymux-ptyd mymux-pkg mymux-attach; do
    [ -e "$BINS/$b" ] && row "bin	$BINS/$b"
  done
  for u in mymuxd.service mymux-ptyd.service; do
    [ -e "$UNITS/$u" ] && row "unit	$UNITS/$u"
  done
  for d in "$STATE" "$HISTORY" "$SRC"; do
    [ -d "$d" ] && row "dir	$d"
  done
  [ -f /tmp/mymuxd.log ] && row "file	/tmp/mymuxd.log"
  [ -S "$USOCK" ] && row "file	$USOCK"
  [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$RTSOCK" ] && row "dir	$RTSOCK"
  [ -f "$CONF/env" ] && row "keep	$CONF/env (your env/proxy settings)"
  return 0
}

uninstall() {
  # 1. Services first (clean stop: Restart=on-failure won't re-fire), then any
  #    strays the systemd path didn't own (setsid fallback launches). Unit
  #    FILES are ours even where systemd --user never existed — remove always.
  if have_systemd; then
    systemctl --user stop mymuxd.service mymux-ptyd.service 2>/dev/null
    systemctl --user disable mymuxd.service mymux-ptyd.service 2>/dev/null
    systemctl --user daemon-reload 2>/dev/null
    note "services stopped + disabled"
  fi
  rm -f "$UNITS/mymuxd.service" "$UNITS/mymux-ptyd.service"
  # Stopping ptyd kills every persistent pane it held — the user was warned.
  pkill -x mymuxd 2>/dev/null
  pkill -x mymux-ptyd 2>/dev/null
  # 2. The tmux server mymuxd drove (its sessions were warned about too).
  tmux -L mymux kill-server 2>/dev/null
  # 3. Everything mymux put on disk (exact paths only — never globbed $HOME).
  rm -f "$BINS/mymuxd" "$BINS/mymux-ptyd" "$BINS/mymux-pkg" "$BINS/mymux-attach"
  rm -rf "$STATE" "$HISTORY" "$SRC"
  rm -f /tmp/mymuxd.log "$USOCK"
  [ -n "${XDG_RUNTIME_DIR:-}" ] && rm -rf "$RTSOCK"
  note "binaries, units, state, packages and history removed"
  [ -f "$CONF/env" ] && note "left in place: $CONF/env (delete it yourself if unwanted)"
  if loginctl show-user "$USER_NAME" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    note "linger is still enabled for $USER_NAME (may predate mymux / serve other services);"
    note "  disable with: loginctl disable-linger $USER_NAME"
  fi
  note "done — mymux is gone from this box"
}

case "${1:-}" in
  --probe) probe ;;
  --yes)
    # The caller (app UI, or a human who read the probe) already confirmed.
    probe >/dev/null
    [ "$WORK" -gt 0 ] && note "$WORK live pane(s) are being terminated"
    uninstall
    ;;
  *)
    probe
    cat >&2 <<'EOF'

usage: bash mymux-uninstall-remote.sh --probe   # this report, machine-readable
       bash mymux-uninstall-remote.sh --yes     # kill the work above and uninstall

--yes stops mymuxd/mymux-ptyd, kills the tmux server AND every persistent
pane listed above, then removes binaries, systemd units, state, packages
and scrollback history. ~/.config/mymux/env is left in place.
EOF
    exit 1
    ;;
esac
