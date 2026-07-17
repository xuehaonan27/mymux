#!/usr/bin/env bash
# agenthook-remote.sh — install/uninstall/status of mymux agent-notify hooks on
# the host, all four agents in one script (self-contained; no repo needed).
# The mymux app uploads this once and runs it per agent over SSH.
#
#   agenthook-remote.sh status    <claude|codex|kimi|opencode>
#   agenthook-remote.sh install   <claude|codex|kimi|opencode> /abs/report[/handler]
#   agenthook-remote.sh uninstall <claude|codex|kimi|opencode>
#
# Reporter payloads (uploaded next to it by the app):
#   ~/.local/bin/mymux-agent-report.sh  (claude/kimi share; codex invokes it too)
#   ~/.local/bin/mymux-codex-notify.sh  (codex's notify handler)
#   ~/.config/opencode/plugins/mymux.js (opencode plugin)
#
# Transfer rules: only OUR blocks land in user files; uninstall removes only
# OUR blocks (never a user's own notify/hooks or their replacements).
set -e
agent="${1:-}"
action="${2:-}"
report="${3:-$HOME/.local/bin/mymux-agent-report.sh}"
handler="${3:-$HOME/.local/bin/mymux-codex-notify.sh}"

fail() { echo "agenthook: $*" >&2; exit 1; }
[ -n "$agent" ] && [ -n "$action" ] || fail "usage: agenthook-remote.sh <agent> <status|install|uninstall> [payload]"

case "$agent" in

claude)
  case "$action" in
    status)
      python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except Exception:
    d = {}
found = "mymux" in json.dumps(d.get("hooks", {}))
print("installed" if found else "missing")
PY
      ;;
    install)
      python3 - "$report" <<'PY'
import json, os, sys
report, = sys.argv[1:]
path = os.path.expanduser("~/.claude/settings.json")
data = json.load(open(path)) if os.path.exists(path) else {}
hooks = data.setdefault("hooks", {})
def add(event, state):
    cmd = f"{report} {state}"
    arr = hooks.setdefault(event, [])
    # idempotency: drop stale our-report entries, then append the current path.
    arr[:] = [x for x in arr if "mymux-agent-report" not in json.dumps(x)]
    arr.append({"hooks": [{"type": "command", "command": cmd}]})
add("UserPromptSubmit", "running")
add("Notification", "waiting")
add("Stop", "done")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, "w"), indent=2)
print("installed claude hooks into", path)
PY
      ;;
    uninstall)
      python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.claude/settings.json")
if not os.path.exists(path):
    print("nothing to remove")
    raise SystemExit
data = json.load(open(path))
hooks = data.get("hooks", {})
gone = []
for event, arr in list(hooks.items()):
    keep = [x for x in arr if "mymux-agent-report" not in json.dumps(x)]
    if len(keep) != len(arr):
        gone.append(event)
        if keep:
            hooks[event] = keep
        else:
            del hooks[event]
json.dump(data, open(path, "w"), indent=2)
print("removed claude hook entries from" if gone else "nothing to remove", path)
PY
      ;;
    *) fail "unknown action $action" ;;
  esac
  ;;

codex)
  CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
  case "$action" in
    status)
      if [ -f "$CFG" ] && grep -q "mymux-codex-notify" "$CFG"; then echo installed; else echo missing; fi
      ;;
    install)
      mkdir -p "$(dirname "$CFG")"
      touch "$CFG"
      if grep -qE '^[[:space:]]*notify[[:space:]]*=' "$CFG"; then
        if grep -q "mymux-codex-notify" "$CFG"; then
          echo "already installed (our handler)"
        else
          echo "NOTE: 'notify' is already set to a DIFFERENT handler in $CFG — not touching it."
          echo "      to route Codex through mymux, change it to:  notify = [\"$handler\"]"
        fi
        exit 0
      fi
      tmp=$(mktemp)
      printf 'notify = ["%s"]\n' "$handler" >"$tmp"
      cat "$CFG" >>"$tmp"
      mv "$tmp" "$CFG"
      echo "installed codex notify into $CFG"
      ;;
    uninstall)
      [ -f "$CFG" ] || { echo "nothing to remove"; exit 0; }
      # Remove ONLY our notify line; anything else (user's own or replaced handler) stays.
      tmp=$(mktemp)
      grep -v "mymux-codex-notify" "$CFG" >"$tmp" || true
      if cmp -s "$tmp" "$CFG"; then
        rm -f "$tmp"
        echo "nothing to remove"
      else
        mv "$tmp" "$CFG"
        echo "removed codex notify from $CFG"
      fi
      ;;
    *) fail "unknown action $action" ;;
  esac
  ;;

kimi)
  CONF="${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml"
  case "$action" in
    status)
      if [ -f "$CONF" ] && grep -q "mymux-agent-report" "$CONF"; then echo installed; else echo missing; fi
      ;;
    install)
      mkdir -p "$(dirname "$CONF")"
      touch "$CONF"
      if grep -q "mymux-agent-report" "$CONF"; then
        echo "already installed"
        exit 0
      fi
      cat >> "$CONF" <<EOF

# mymux agent-status badges (agenthook-remote.sh)
[[hooks]]
event = "UserPromptSubmit"
command = "$report running"

[[hooks]]
event = "PermissionRequest"
command = "$report waiting"

[[hooks]]
event = "Stop"
command = "$report done"
EOF
      echo "installed kimi hooks into $CONF"
      ;;
    uninstall)
      [ -f "$CONF" ] || { echo "nothing to remove"; exit 0; }
      python3 - "$CONF" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
text = text.replace("# mymux agent-status badges (agenthook-remote.sh)\n", "")
blocks = text.split("[[hooks]]")
out = blocks[0]
removed = False
for b in blocks[1:]:
    if "mymux-agent-report" in b:
        removed = True
        continue
    out += "[[hooks]]" + b
if removed:
    open(path, "w").write(out.rstrip() + "\n")
    print("removed kimi hook blocks from", path)
else:
    print("nothing to remove")
PY
      ;;
    *) fail "unknown action $action" ;;
  esac
  ;;

opencode)
  JS="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/mymux.js"
  case "$action" in
    status)
      if [ -f "$JS" ]; then echo installed; else echo missing; fi
      ;;
    install)
      # The upload itself IS the install — the app put the plugin at its final
      # path already; this run just verifies that it's really there.
      if [ -f "$JS" ]; then echo installed "$JS"; else fail "plugin payload missing at $JS (upload step must land it first)"; fi
      ;;
    uninstall)
      if [ -f "$JS" ]; then rm -f "$JS"; echo "removed opencode plugin ($JS)"; else echo "nothing to remove"; fi
      ;;
    *) fail "unknown action $action" ;;
  esac
  ;;

*) fail "unknown agent $agent (claude|codex|kimi|opencode)" ;;
esac
