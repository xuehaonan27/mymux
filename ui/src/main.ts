import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { measureCell } from './metrics';
import { initCodePanel } from './code';
import { initProcPanel } from './proc';
import { initHostManager } from './hostmanager';

// M1.2: render tmux's full window layout. The daemon pushes a JSON state
// snapshot (window list + layout tree + active pane) and pane-addressed output;
// we mirror it with one xterm per pane, absolutely positioned by cell geometry
// (faithful to tmux, the authoritative sizer).

type Kind = 'leaf' | 'cols' | 'rows';
interface LayoutNode {
  kind: Kind;
  pane?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  children?: LayoutNode[];
}
interface WinInfo {
  id: number;
  name: string;
  active: boolean;
  agent?: 'running' | 'waiting' | 'done';
  ephemeral?: boolean;
}
interface StateMsg {
  t: string;
  active_window: number | null;
  active_pane: number | null;
  windows: WinInfo[];
  layout: LayoutNode | null;
}

// 127.0.0.1 works both under the port-forwarded browser and inside the Tauri
// app (whose webview host is tauri.localhost, not the machine itself).
const WS_URL = 'ws://127.0.0.1:8088/ws';
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;
const THEME = { background: '#0b0e14', foreground: '#c5cdd9' };

const { cellW, cellH } = measureCell(FONT, FONT_SIZE, LINE_HEIGHT);

const termArea = document.getElementById('term') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;
const agentsEl = document.getElementById('agents')!;

interface Pane {
  term: Terminal;
  el: HTMLDivElement;
}
const panes = new Map<number, Pane>();
let activePane: number | null = null;
let activeWindow: number | null = null;
let windowList: WinInfo[] = [];
let ws: WebSocket | undefined;

function makePane(id: number): Pane {
  const el = document.createElement('div');
  el.className = 'pane';
  el.addEventListener('mousedown', () => focusPane(id));
  termArea.appendChild(el);

  const term = new Terminal({
    fontFamily: FONT,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    scrollback: 10000,
    cursorBlink: true,
    theme: THEME,
  });
  term.open(el);
  term.onData((d) => sendInput(id, d));

  const pane: Pane = { term, el };
  panes.set(id, pane);
  return pane;
}

function focusPane(id: number) {
  sendJson({ t: 'focus', pane: id });
  setActivePane(id);
  panes.get(id)?.term.focus();
}

function setActivePane(id: number | null) {
  const changed = id !== activePane;
  activePane = id;
  for (const [pid, p] of panes) p.el.classList.toggle('active', pid === id);
  // Give the newly-active pane keyboard focus so typing and nav land there.
  if (changed && id != null) panes.get(id)?.term.focus();
}

// Place each leaf pane at its exact cell rectangle; dispose panes that vanished.
function applyLayout(root: LayoutNode) {
  const seen = new Set<number>();
  const place = (n: LayoutNode) => {
    if (n.kind === 'leaf' && n.pane != null) {
      const p = panes.get(n.pane) ?? makePane(n.pane);
      p.el.style.left = `${n.x * cellW}px`;
      p.el.style.top = `${n.y * cellH}px`;
      p.el.style.width = `${n.w * cellW}px`;
      p.el.style.height = `${n.h * cellH}px`;
      if (p.term.cols !== n.w || p.term.rows !== n.h) {
        p.term.resize(Math.max(1, n.w), Math.max(1, n.h));
      }
      seen.add(n.pane);
    } else {
      n.children?.forEach(place);
    }
  };
  place(root);

  for (const [pid, p] of [...panes]) {
    if (!seen.has(pid)) {
      p.term.dispose();
      p.el.remove();
      panes.delete(pid);
    }
  }
}

function renderTabs(windows: WinInfo[]) {
  tabsEl.replaceChildren();
  for (const w of windows) {
    const tab = document.createElement('button');
    tab.className = 'tab' + (w.active ? ' active' : '') + (w.ephemeral ? ' ephemeral' : '');
    if (w.agent) {
      const dot = document.createElement('span');
      dot.className = `adot agent-${w.agent}`;
      tab.appendChild(dot);
    }
    tab.appendChild(document.createTextNode((w.ephemeral ? '⌁ ' : '') + (w.name || `@${w.id}`)));
    tab.addEventListener('click', () => sendJson({ t: 'select_window', id: w.id }));
    tabsEl.appendChild(tab);
  }
  // Glance summary: how many windows want your attention.
  const waiting = windows.filter((w) => w.agent === 'waiting').length;
  const done = windows.filter((w) => w.agent === 'done').length;
  const parts: string[] = [];
  if (waiting) parts.push(`⏳ ${waiting} waiting`);
  if (done) parts.push(`✓ ${done} done`);
  agentsEl.textContent = parts.join('  ·  ');
}

function updateMeta(windows: number) {
  metaEl.textContent = `${windows} win · pane ${activePane ?? '?'}`;
}

function onState(json: string) {
  let msg: StateMsg;
  try {
    msg = JSON.parse(json);
  } catch {
    return;
  }
  if (msg.t !== 'state') return;
  windowList = msg.windows;
  activeWindow = msg.active_window;
  renderTabs(msg.windows);
  if (msg.layout) applyLayout(msg.layout);
  setActivePane(msg.active_pane);
  updateMeta(msg.windows.length);
}

function onBinary(buf: ArrayBuffer) {
  if (buf.byteLength < 4) return;
  const pane = new DataView(buf).getUint32(0, true);
  // Only render output for panes in the active window's layout. Output for a
  // background pane is dropped (switching to that window triggers a fresh
  // snapshot); creating a pane here would overlap, unpositioned.
  const p = panes.get(pane);
  if (p) p.term.write(new Uint8Array(buf, 4));
}

function sendJson(obj: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendInput(pane: number, data: string) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const payload = new TextEncoder().encode(data);
  const buf = new Uint8Array(4 + payload.length);
  new DataView(buf.buffer).setUint32(0, pane, true);
  buf.set(payload, 4);
  ws.send(buf);
}

// We are the screen; tmux is the authoritative sizer. Report the whole-window
// size in cells; tmux splits it and pushes back the per-pane layout.
function sendResize() {
  const cols = Math.max(20, Math.floor(termArea.clientWidth / cellW));
  const rows = Math.max(5, Math.floor(termArea.clientHeight / cellH));
  sendJson({ t: 'resize', cols, rows });
}

function setStatus(state: 'connecting' | 'open' | 'closed') {
  statusEl.className = `dot ${state}`;
}

let reconnectPending = false;
function scheduleReconnect() {
  if (reconnectPending) return;
  reconnectPending = true;
  setStatus('closed');
  window.setTimeout(() => {
    reconnectPending = false;
    connect();
  }, 1000);
}

function connect() {
  setStatus('connecting');
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    setStatus('open');
    sendResize();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') onState(ev.data);
    else if (ev.data instanceof ArrayBuffer) onBinary(ev.data);
  };
  // Reconnect on both close and error: a connection refused during the tunnel's
  // down-window may fire only one of them.
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => scheduleReconnect();
}

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(sendResize, 100);
}).observe(termArea);

// Temporary toolbar buttons so M1.2 is demonstrable; M1.3 adds keybindings.
function cmdBtn(id: string, make: () => unknown) {
  document.getElementById(id)?.addEventListener('click', () => {
    const m = make();
    if (m) sendJson(m);
  });
}
cmdBtn('btn-newwin', () => ({ t: 'new_window' }));
cmdBtn('btn-splith', () => (activePane != null ? { t: 'split', pane: activePane, dir: 'h' } : null));
cmdBtn('btn-splitv', () => (activePane != null ? { t: 'split', pane: activePane, dir: 'v' } : null));
cmdBtn('btn-eph', () => ({ t: 'new_ephemeral' }));

// ---- Keybindings (M1.3): a Cmd/Ctrl+K leader for everything, plus a few
// non-conflicting direct combos. The Tauri app (M2) can bind the rest of the
// iTerm2-style direct combos that the browser reserves (Cmd+T/W/1-9). ----
const hintEl = document.getElementById('hint')!;
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
// In the Tauri app there is no browser reserving Cmd+T/W/1-9, so we bind the
// full iTerm2 set there; in a browser those stay on the ⌘K leader.
const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

const codePanel = initCodePanel(() => activePane);
const procPanel = initProcPanel();
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

let leaderActive = false;
function setLeader(on: boolean) {
  leaderActive = on;
  hintEl.classList.toggle('show', on);
}

function splitActive(dir: 'h' | 'v') {
  if (activePane != null) sendJson({ t: 'split', pane: activePane, dir });
}
function closeActive() {
  if (activePane != null) sendJson({ t: 'close_pane', pane: activePane });
}
function navPane(dir: 'L' | 'R' | 'U' | 'D') {
  sendJson({ t: 'select_pane', dir });
}
function switchWindowIndex(i: number) {
  const w = windowList[i];
  if (w) sendJson({ t: 'select_window', id: w.id });
}
function switchWindowRel(delta: number) {
  if (!windowList.length) return;
  const idx = Math.max(0, windowList.findIndex((w) => w.id === activeWindow));
  const next = windowList[(idx + delta + windowList.length) % windowList.length];
  sendJson({ t: 'select_window', id: next.id });
}
function copySelection() {
  const sel = activePane != null ? panes.get(activePane)?.term.getSelection() : '';
  if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
}

const ARROWS: Record<string, 'L' | 'R' | 'U' | 'D'> = {
  ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D',
  h: 'L', l: 'R', k: 'U', j: 'D',
};

function handleLeaderKey(e: KeyboardEvent) {
  const k = e.key;
  if (k === 'Escape') return;
  const lower = k.toLowerCase();
  if (lower === 'c') return sendJson({ t: 'new_window' });
  if (lower === 'x') return closeActive();
  if (lower === 't') return toggleProc();
  if (lower === 's') return sendJson({ t: 'new_ephemeral' });
  if (lower === 'd') return splitActive(e.shiftKey ? 'v' : 'h');
  if (k === '|' || k === '\\') return splitActive('h');
  if (k === '-') return splitActive('v');
  if (k === 'n' || k === ']') return switchWindowRel(1);
  if (k === 'p' || k === '[') return switchWindowRel(-1);
  if (k >= '1' && k <= '9') return switchWindowIndex(parseInt(k, 10) - 1);
  const d = ARROWS[k] ?? ARROWS[lower];
  if (d) navPane(d);
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
      splitActive(e.shiftKey ? 'v' : 'h');
      return;
    }
    if (lower === 'c' && !e.shiftKey && !e.altKey) {
      const sel = activePane != null ? panes.get(activePane)?.term.getSelection() : '';
      if (sel) {
        stop();
        copySelection();
      }
      return;
    }

    // Full iTerm2 direct combos — only in the Tauri app (a browser reserves these):
    if (isTauri) {
      if (lower === 't' && !e.shiftKey && !e.altKey) {
        stop();
        sendJson({ t: 'new_window' });
      } else if (lower === 'w' && !e.shiftKey && !e.altKey) {
        stop();
        closeActive();
      } else if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        stop();
        switchWindowIndex(parseInt(e.key, 10) - 1);
      } else if (e.altKey) {
        const ad = ARROWS[e.key];
        if (ad) {
          stop();
          navPane(ad);
        }
      }
    }
    // Cmd/Ctrl+V paste falls through to xterm, which applies bracketed paste.
  },
  true,
);

// In the Tauri app the host manager owns the SSH tunnel: on `connected` we start
// the terminal WS. In a browser (dev) the WS talks to a manually-forwarded :8088.
if (isTauri) {
  let terminalStarted = false;
  const hostManager = initHostManager(() => {
    if (!terminalStarted) {
      terminalStarted = true;
      connect();
    }
  });
  const hostBtn = document.getElementById('btn-host');
  if (hostBtn) {
    hostBtn.style.display = '';
    hostBtn.addEventListener('click', () => hostManager.open());
  }
} else {
  connect();
}
