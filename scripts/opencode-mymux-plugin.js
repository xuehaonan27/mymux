// mymux agent-status reporter for Open Code — installed by
// scripts/install-opencode-plugin.sh into ~/.config/opencode/plugins/mymux.js
// (https://opencode.ai/docs/plugins/). Maps lifecycle events to mymuxd's
// /agent endpoint:
//   permission.asked → waiting   (a tool needs your decision — the ask)
//   session.idle     → done      (the turn finished)
// "running" is deliberately left to mymuxd's output heuristic — the same
// model as the Codex `notify` wiring (noisy per-message events buy nothing).
const PORT = process.env.MYMUX_AGENT_PORT || '8088';

function report(state) {
  // Same pane resolution as scripts/mymux-agent-report.sh: tmux pane id, else
  // a native (non-tmux) mymux pane id; outside mymux this reports nothing.
  const pane = (process.env.TMUX_PANE || '').replace(/^%/, '') || process.env.MYMUX_PANE;
  if (!pane) return;
  fetch(`http://127.0.0.1:${PORT}/agent?pane=${pane}&state=${state}`).catch(() => {});
}

export const MymuxPlugin = async () => ({
  event: async ({ event }) => {
    if (event.type === 'permission.asked') report('waiting');
    else if (event.type === 'session.idle') report('done');
  },
});
