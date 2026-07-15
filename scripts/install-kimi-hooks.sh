#!/usr/bin/env bash
# Register mymux agent-status hooks in Kimi Code's config.toml, non-destructively:
# appends three [[hooks]] entries (running/waiting/done) only if absent.
# Events (https://moonshotai.github.io/kimi-code/en/customization/hooks.html):
#   UserPromptSubmit  → running   (you sent a prompt)
#   PermissionRequest → waiting   (about to wait for your approval — the ask)
#   Stop              → done      (the turn finished)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$DIR/mymux-agent-report.sh"
CONF="${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml"

mkdir -p "$(dirname "$CONF")"
touch "$CONF"
if grep -q "mymux-agent-report" "$CONF"; then
  echo "mymux: hooks already present in $CONF — nothing to do"
  exit 0
fi
cat >> "$CONF" <<EOF

# mymux agent-status badges (scripts/install-kimi-hooks.sh)
[[hooks]]
event = "UserPromptSubmit"
command = "$REPORT running"

[[hooks]]
event = "PermissionRequest"
command = "$REPORT waiting"

[[hooks]]
event = "Stop"
command = "$REPORT done"
EOF
echo "mymux: appended agent hooks to $CONF"
echo "Done. Run /reload (or restart Kimi Code) inside a mymux pane to pick them up."
