import '@xterm/xterm/css/xterm.css';
import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { measureCell } from './metrics';
import { initCodePanel } from './code';
import { initProcPanel } from './proc';
import { initHostManager } from './hostmanager';
import { Workspace, WinInfo, WsState } from './workspace';

// The shell: a registry of per-host Workspaces (each owns its WS + panes; see
// workspace.ts), the shared bar (host chips / window tabs / agent counts), the
// overlays, and keybindings routed to the visible workspace.

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;
const THEME = { background: '#0b0e14', foreground: '#c5cdd9' };
const { cellW, cellH } = measureCell(FONT, FONT_SIZE, LINE_HEIGHT);
const STYLE = { font: FONT, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, theme: THEME, cellW, cellH };

const termArea = document.getElementById('term') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const hostsEl = document.getElementById('hostbar') as HTMLElement;
const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;
const agentsEl = document.getElementById('agents')!;
const hintEl = document.getElementById('hint')!;

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
// In the Tauri app there is no browser reserving Cmd+T/W/1-9, so we bind the
// full iTerm2 set there; in a browser those stay on the ⌘K leader.
const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

// ---- workspace registry ----------------------------------------------------

const workspaces = new Map<string, Workspace>();
let activeWs: Workspace | null = null;
const active = () => activeWs;
let hostManager: { open(): void } | null = null;

function ensureWorkspace(id: string, label: string, port: number): Workspace {
  const existing = workspaces.get(id);
  if (existing) return existing;
  const w = new Workspace({
    id,
    label,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    apiBase: `http://127.0.0.1:${port}`,
    container: termArea,
    style: STYLE,
    hooks: {
      onUpdate(w) {
        if (w === activeWs) {
          renderTabs(w);
          updateMeta();
        }
        renderHosts();
        renderAgents();
      },
      onStatus(w, s) {
        if (w === activeWs) setStatus(s);
      },
      onSessionEnd(w) {
        endWorkspace(w, true);
      },
    },
  });
  workspaces.set(id, w);
  w.connect();
  return w;
}

function switchTo(id: string) {
  const w = workspaces.get(id);
  if (!w) return;
  if (activeWs !== w) {
    activeWs?.hide();
    activeWs = w;
    w.show();
  }
  renderTabs(w);
  renderHosts();
  renderAgents();
  updateMeta();
  setStatus(w.state());
}

// A workspace is over (its session ended, or the user disconnected the host).
function endWorkspace(w: Workspace, disconnectTunnel: boolean) {
  workspaces.delete(w.id);
  w.destroy();
  if (disconnectTunnel && isTauri) {
    void invoke('disconnect', { host_id: w.id }).catch(() => {});
  }
  if (activeWs === w) activeWs = null;
  if (activeWs === null) {
    const next = [...workspaces.values()].pop();
    if (next) {
      switchTo(next.id);
      return;
    }
    renderTabs(null);
    renderHosts();
    renderAgents();
    updateMeta();
    setStatus('closed');
    if (isTauri) {
      hostManager?.open();
    } else {
      // Browser (no host manager): start a fresh session right away.
      ensureWorkspace('local', 'local', 8088);
      switchTo('local');
    }
    return;
  }
  renderHosts();
  renderAgents();
}

// ---- shared bar rendering ----------------------------------------------------

function renderTabs(w: Workspace | null) {
  tabsEl.replaceChildren();
  if (!w) return;
  for (const win of w.windowList) {
    const tab = document.createElement('button');
    tab.className = 'tab' + (win.active ? ' active' : '') + (win.ephemeral ? ' ephemeral' : '');
    if (win.agent) {
      const dot = document.createElement('span');
      dot.className = `adot agent-${win.agent}`;
      tab.appendChild(dot);
    }
    tab.appendChild(
      document.createTextNode((win.ephemeral ? '⌁ ' : '') + (win.name || `@${win.id}`)),
    );
    tab.addEventListener('click', () => w.sendJson({ t: 'select_window', id: win.id }));
    tabsEl.appendChild(tab);
  }
}

/** The most attention-worthy agent state across a host's windows. */
function topAgent(windows: WinInfo[]): 'waiting' | 'done' | 'running' | undefined {
  let best: 'waiting' | 'done' | 'running' | undefined;
  const prio = { waiting: 3, done: 2, running: 1 } as const;
  for (const w of windows) {
    if (w.agent && (!best || prio[w.agent] > prio[best])) best = w.agent;
  }
  return best;
}

// Host chips live on their own strip above the bar, shown once there's more
// than one connected host (always-show will become a profile setting).
function renderHosts() {
  hostsEl.replaceChildren();
  const show = workspaces.size >= 2;
  hostsEl.style.display = show ? 'flex' : 'none';
  if (!show) return;
  let i = 0;
  for (const w of workspaces.values()) {
    i += 1;
    const chip = document.createElement('button');
    chip.className = 'hostchip' + (w === activeWs ? ' active' : '');
    chip.title = `switch host (⌘⇧${i})`;
    const agent = topAgent(w.windowList);
    if (agent) {
      const dot = document.createElement('span');
      dot.className = `adot agent-${agent}`;
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(w.label));
    chip.addEventListener('click', () => switchTo(w.id));
    hostsEl.appendChild(chip);
  }
}

// Glance summary across ALL hosts: how many windows want your attention.
function renderAgents() {
  let waiting = 0;
  let done = 0;
  for (const w of workspaces.values()) {
    waiting += w.windowList.filter((x) => x.agent === 'waiting').length;
    done += w.windowList.filter((x) => x.agent === 'done').length;
  }
  const parts: string[] = [];
  if (waiting) parts.push(`⏳ ${waiting} waiting`);
  if (done) parts.push(`✓ ${done} done`);
  agentsEl.textContent = parts.join('  ·  ');
}

function updateMeta() {
  metaEl.textContent = activeWs
    ? `${activeWs.windowList.length} win · pane ${activeWs.activePane ?? '?'}`
    : '';
}

function setStatus(state: WsState) {
  statusEl.className = `dot ${state}`;
}

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => active()?.sendResize(), 100);
}).observe(termArea);

// ---- toolbar -----------------------------------------------------------------

document.getElementById('btn-newwin')?.addEventListener('click', () =>
  active()?.sendJson({ t: 'new_window' }),
);
document.getElementById('btn-splith')?.addEventListener('click', () => active()?.splitActive('h'));
document.getElementById('btn-splitv')?.addEventListener('click', () => active()?.splitActive('v'));
document.getElementById('btn-eph')?.addEventListener('click', () =>
  active()?.sendJson({ t: 'new_ephemeral' }),
);

// ---- overlays ------------------------------------------------------------------

const codePanel = initCodePanel({
  getActivePane: () => active()?.activePane ?? null,
  getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
  getScope: () => active()?.id ?? 'local',
});
const procPanel = initProcPanel({
  getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
});
// Both overlays are full-screen and share a z-band, so they're mutually exclusive.
function toggleCode() {
  if (procPanel.isOpen()) procPanel.toggle();
  codePanel.toggle();
}
function toggleProc() {
  if (codePanel.isOpen()) codePanel.toggle();
  procPanel.toggle();
}
document.getElementById('btn-code')?.addEventListener('click', toggleCode);
document.getElementById('btn-proc')?.addEventListener('click', toggleProc);

// ---- keybindings (⌘K leader + direct combos; full iTerm2 set in Tauri) --------

let leaderActive = false;
function setLeader(on: boolean) {
  leaderActive = on;
  hintEl.classList.toggle('show', on);
}

function copySelection() {
  const sel = active()?.selection() ?? '';
  if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
}

const ARROWS: Record<string, 'L' | 'R' | 'U' | 'D'> = {
  ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D',
  h: 'L', l: 'R', k: 'U', j: 'D',
};

function handleLeaderKey(e: KeyboardEvent) {
  const k = e.key;
  if (k === 'Escape') return;
  const w = active();
  if (!w) return;
  const lower = k.toLowerCase();
  if (lower === 'c') return w.sendJson({ t: 'new_window' });
  if (lower === 'x') return w.closeActive();
  if (lower === 't') return toggleProc();
  if (lower === 's') return w.sendJson({ t: 'new_ephemeral' });
  if (lower === 'd') return w.splitActive(e.shiftKey ? 'v' : 'h');
  if (k === '|' || k === '\\') return w.splitActive('h');
  if (k === '-') return w.splitActive('v');
  if (k === 'n' || k === ']') return w.switchWindowRel(1);
  if (k === 'p' || k === '[') return w.switchWindowRel(-1);
  if (k >= '1' && k <= '9') return w.switchWindowIndex(parseInt(k, 10) - 1);
  const d = ARROWS[k] ?? ARROWS[lower];
  if (d) w.navPane(d);
}

document.addEventListener(
  'keydown',
  (e) => {
    if (leaderActive) {
      // Ignore modifier-only keydowns so "leader then Shift+D" works.
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleLeaderKey(e);
      setLeader(false);
      return;
    }

    // With the code panel open, only ⌘E / Esc are ours — the rest goes to the editor.
    if (codePanel.isOpen()) {
      if (mod(e) && e.key.toLowerCase() === 'e' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        codePanel.toggle();
      } else if (e.key === 'Escape') {
        codePanel.toggle();
      }
      return;
    }

    // The process panel is a read-only modal overlay: esc closes it.
    if (procPanel.isOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        procPanel.toggle();
      }
      return;
    }

    if (!mod(e)) return;
    const lower = e.key.toLowerCase();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Works everywhere (browser + Tauri):
    if (lower === 'e' && !e.shiftKey && !e.altKey) {
      stop();
      toggleCode();
      return;
    }
    if (lower === 'k' && !e.shiftKey && !e.altKey) {
      stop();
      setLeader(true);
      return;
    }
    if (lower === 'd' && !e.altKey) {
      stop();
      active()?.splitActive(e.shiftKey ? 'v' : 'h');
      return;
    }
    if (lower === 'c' && !e.shiftKey && !e.altKey) {
      if (active()?.selection()) {
        stop();
        copySelection();
      }
      return;
    }

    // Full iTerm2 direct combos — only in the Tauri app (a browser reserves these):
    if (isTauri) {
      if (e.shiftKey && !e.altKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
        // ⌘⇧1-9: switch host (⌘1-9 stays window switching).
        stop();
        const ids = [...workspaces.keys()];
        const id = ids[parseInt(e.code.slice(5), 10) - 1];
        if (id) switchTo(id);
      } else if (lower === 't' && !e.shiftKey && !e.altKey) {
        stop();
        active()?.sendJson({ t: 'new_window' });
      } else if (lower === 'w' && !e.shiftKey && !e.altKey) {
        stop();
        active()?.closeActive();
      } else if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        stop();
        active()?.switchWindowIndex(parseInt(e.key, 10) - 1);
      } else if (e.altKey) {
        const ad = ARROWS[e.key];
        if (ad) {
          stop();
          active()?.navPane(ad);
        }
      }
    }
    // Cmd/Ctrl+V paste falls through to xterm, which applies bracketed paste.
  },
  true,
);

// ---- boot ----------------------------------------------------------------------

// In the Tauri app the host manager owns the SSH tunnels: each `connected` host
// gets a workspace on its own local port. In a browser (dev) there is a single
// workspace against a manually-forwarded :8088.
if (isTauri) {
  hostManager = initHostManager({
    onConnected(host) {
      ensureWorkspace(host.id, host.label, host.port);
      switchTo(host.id);
    },
    onDisconnected(hostId) {
      const w = workspaces.get(hostId);
      if (w) endWorkspace(w, false); // tunnel already torn down by the manager
    },
  });
  const hostBtn = document.getElementById('btn-host');
  if (hostBtn) {
    hostBtn.style.display = '';
    hostBtn.addEventListener('click', () => hostManager!.open());
  }
} else {
  ensureWorkspace('local', 'local', 8088);
  switchTo('local');
}
