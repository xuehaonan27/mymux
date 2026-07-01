#!/usr/bin/env bash
# Merge mymux agent-status hooks into ~/.claude/settings.json, non-destructively
# (keeps your existing settings/hooks; adds ours only if missing).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
REPORT="$DIR/mymux-agent-report.sh"

python3 - "$REPORT" <<'PY'
import json, os, sys
report = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
data = json.load(open(path)) if os.path.exists(path) else {}
hooks = data.setdefault("hooks", {})

def add(event, state):
    cmd = f"{report} {state}"
    arr = hooks.setdefault(event, [])
    if not any(cmd in json.dumps(x) for x in arr):
        arr.append({"hooks": [{"type": "command", "command": cmd}]})

add("UserPromptSubmit", "running")   # you sent a prompt -> agent is working
add("Notification", "waiting")       # agent needs your attention/approval
add("Stop", "done")                  # a turn finished

os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(data, open(path, "w"), indent=2)
print("mymux: merged agent hooks into", path)
PY

echo "Done. Restart Claude Code inside a mymux pane to pick up the hooks."
