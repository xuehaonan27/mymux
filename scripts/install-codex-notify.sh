#!/usr/bin/env bash
# Point Codex's `notify` at the mymux handler so Codex turn-completions badge the
# pane's tab (🟢 done). Non-destructive: only adds `notify` if it isn't already set.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
HANDLER="$DIR/mymux-codex-notify.sh"
CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
mkdir -p "$(dirname "$CFG")"
touch "$CFG"

if grep -qE '^[[:space:]]*notify[[:space:]]*=' "$CFG"; then
  echo "mymux: 'notify' already set in $CFG — not touching it."
  echo "       To route Codex through mymux, set:  notify = [\"$HANDLER\"]"
  exit 0
fi

# Prepend so the key lands in the top-level table (a key after a [section] header
# would otherwise belong to that section).
tmp=$(mktemp)
printf 'notify = ["%s"]\n' "$HANDLER" >"$tmp"
cat "$CFG" >>"$tmp"
mv "$tmp" "$CFG"
echo "mymux: added  notify = [\"$HANDLER\"]  to $CFG"
echo "Restart Codex to pick it up. (approval prompts stay inline in Codex's TUI.)"
