#!/usr/bin/env bash
# Report agent state to mymuxd from an agent hook (Claude Code, Codex, …).
# Usage: mymux-agent-report.sh <running|waiting|done|idle>
state="${1:-running}"
pane="${TMUX_PANE#%}"                     # "%3" -> "3" (tmux pane)
[ -z "$pane" ] && pane="${MYMUX_PANE:-}"  # ephemeral (non-tmux) pane: no $TMUX_PANE
[ -z "$pane" ] && exit 0                  # not inside a mymux pane
port="${MYMUX_AGENT_PORT:-8088}"
curl -fsS --max-time 1 "http://127.0.0.1:${port}/agent?pane=${pane}&state=${state}" >/dev/null 2>&1 || true
exit 0
