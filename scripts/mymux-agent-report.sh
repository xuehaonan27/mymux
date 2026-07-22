#!/usr/bin/env bash
# Report agent state to mymuxd from an agent hook (Claude Code, Codex, …).
# Usage: mymux-agent-report.sh <running|waiting|done|idle>
state="${1:-running}"
# $TMUX_PANE is set by ANY tmux — including a personal tmux the user nested
# INSIDE a mymux pane. Reporting that pane id would badge an unrelated mymux
# window (its ids live in the same space). Trust $TMUX_PANE only when THIS
# tmux is mymux's own server (its -L socket), else fall back to the injected
# MYMUX_PANE (mymux's native panes carry it; a nested tmux inherits it).
pane=""
sock="${MYMUX_SOCKET:-mymux}"
case "${TMUX%%,*}" in
  */"$sock") pane="${TMUX_PANE#%}" ;; # "%3" -> "3", only in mymux's tmux
esac
[ -z "$pane" ] && pane="${MYMUX_PANE:-}"  # native pane, or nested-in-native
[ -z "$pane" ] && exit 0                  # not identifiably a mymux pane
port="${MYMUX_AGENT_PORT:-8088}"
curl -fsS --max-time 1 "http://127.0.0.1:${port}/agent?pane=${pane}&state=${state}" >/dev/null 2>&1 || true
exit 0
