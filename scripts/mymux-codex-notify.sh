#!/usr/bin/env bash
# Codex `notify` handler for mymux.
#
# Codex invokes its notify program with a single JSON argument describing an
# event (currently only "agent-turn-complete"). We map a completed turn to
# "done" and report via the shared reporter, which resolves the pane from
# $TMUX_PANE (tmux) or $MYMUX_PANE (ephemeral). "running" is left to the daemon's
# output heuristic — Codex's notify has no turn-start event.
#
# Enable with scripts/install-codex-notify.sh, or manually in ~/.codex/config.toml:
#   notify = ["/abs/path/to/scripts/mymux-codex-notify.sh"]
DIR="$(cd "$(dirname "$0")" && pwd)"
json="${1:-}"
type=$(printf '%s' "$json" | python3 -c 'import sys, json
try:
    print(json.load(sys.stdin).get("type", ""))
except Exception:
    pass' 2>/dev/null)
case "$type" in
  agent-turn-complete) exec "$DIR/mymux-agent-report.sh" done ;;
  *) exit 0 ;;
esac
