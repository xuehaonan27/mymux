#!/usr/bin/env bash
# Report agent state to mymuxd from an agent hook (Claude Code, Codex, …).
# Usage: mymux-agent-report.sh <running|waiting|done|idle>
state="${1:-running}"
pane="${TMUX_PANE#%}"        # "%3" -> "3"
[ -z "$pane" ] && exit 0     # not inside a (mymux) tmux pane
curl -fsS --max-time 1 "http://127.0.0.1:8088/agent?pane=${pane}&state=${state}" >/dev/null 2>&1 || true
exit 0
