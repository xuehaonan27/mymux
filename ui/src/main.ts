import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { measureCell } from './metrics';

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
}
interface StateMsg {
  t: string;
  active_window: number | null;
  active_pane: number | null;
  windows: WinInfo[];
  layout: LayoutNode | null;
}

const WS_URL = `ws://${location.hostname || '127.0.0.1'}:8088/ws`;
const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;
const THEME = { background: '#0b0e14', foreground: '#c5cdd9' };

const { cellW, cellH } = measureCell(FONT, FONT_SIZE, LINE_HEIGHT);

const termArea = document.getElementById('term') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;

interface Pane {
  term: Terminal;
  el: HTMLDivElement;
}
const panes = new Map<number, Pane>();
let activePane: number | null = null;
let ws: WebSocket | undefined;
let focusedOnce = false;

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
  activePane = id;
  for (const [pid, p] of panes) p.el.classList.toggle('active', pid === id);
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
    tab.className = 'tab' + (w.active ? ' active' : '');
    tab.textContent = w.name || `@${w.id}`;
    tab.addEventListener('click', () => sendJson({ t: 'select_window', id: w.id }));
    tabsEl.appendChild(tab);
  }
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
  renderTabs(msg.windows);
  setActivePane(msg.active_pane);
  if (msg.layout) applyLayout(msg.layout);
  updateMeta(msg.windows.length);
  if (!focusedOnce && msg.active_pane != null && panes.has(msg.active_pane)) {
    panes.get(msg.active_pane)!.term.focus();
    focusedOnce = true;
  }
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
  ws.onclose = () => {
    setStatus('closed');
    focusedOnce = false;
    window.setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
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

connect();
