// One Workspace per connected host: it owns that host's WebSocket, xterm panes,
// window list, reconnect/suspend logic and size self-healing, and renders into
// its own layer under #term. The shell (main.ts) holds the registry, decides
// which workspace is visible, and renders the shared bar (tabs / chips /
// aggregate agent counts) from workspace data via the hooks.

import { Terminal } from '@xterm/xterm';

export type Kind = 'leaf' | 'cols' | 'rows';
export interface LayoutNode {
  kind: Kind;
  pane?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  children?: LayoutNode[];
}
export interface WinInfo {
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

export type WsState = 'connecting' | 'open' | 'closed';

export interface TermStyle {
  font: string;
  fontSize: number;
  lineHeight: number;
  theme: { background: string; foreground: string };
  cellW: number;
  cellH: number;
}

export interface WorkspaceHooks {
  /** State applied (windows/layout/agents changed) — re-render bar if relevant. */
  onUpdate(w: Workspace): void;
  /** WebSocket connectivity changed. */
  onStatus(w: Workspace, s: WsState): void;
  /** The tmux session ended ("done with this host"); reconnects already stopped. */
  onSessionEnd(w: Workspace): void;
}

interface Pane {
  term: Terminal;
  el: HTMLDivElement;
}

export class Workspace {
  readonly id: string;
  readonly label: string;
  readonly apiBase: string;
  private readonly wsUrl: string;
  private readonly style: TermStyle;
  private readonly hooks: WorkspaceHooks;
  private readonly container: HTMLElement;
  private readonly root: HTMLDivElement;

  private readonly panes = new Map<number, Pane>();
  activePane: number | null = null;
  activeWindow: number | null = null;
  windowList: WinInfo[] = [];
  visible = false;

  private dead = false;
  private ws?: WebSocket;
  private wsState: WsState = 'closed';
  private reconnectPending = false;
  private lastSizeNudge = 0;

  constructor(opts: {
    id: string;
    label: string;
    wsUrl: string;
    apiBase: string;
    container: HTMLElement;
    style: TermStyle;
    hooks: WorkspaceHooks;
  }) {
    this.id = opts.id;
    this.label = opts.label;
    this.wsUrl = opts.wsUrl;
    this.apiBase = opts.apiBase;
    this.container = opts.container;
    this.style = opts.style;
    this.hooks = opts.hooks;
    this.root = document.createElement('div');
    this.root.className = 'workspace';
    this.root.style.display = 'none';
    opts.container.appendChild(this.root);
  }

  // ---- lifecycle -----------------------------------------------------------

  connect() {
    if (this.dead) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.setWsState('connecting');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.setWsState('open');
      this.sendResize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onState(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
    };
    // Reconnect on both close and error: a connection refused during the
    // tunnel's down-window may fire only one of them.
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.dead || this.reconnectPending) return;
    this.reconnectPending = true;
    this.setWsState('closed');
    window.setTimeout(() => {
      this.reconnectPending = false;
      this.connect();
    }, 1000);
  }

  private setWsState(s: WsState) {
    this.wsState = s;
    this.hooks.onStatus(this, s);
  }

  state(): WsState {
    return this.wsState;
  }

  show() {
    this.visible = true;
    this.root.style.display = '';
    // Repaint after display:none and pick up any size drift while hidden.
    for (const p of this.panes.values()) p.term.refresh(0, Math.max(0, p.term.rows - 1));
    this.sendResize();
    if (this.activePane != null) this.panes.get(this.activePane)?.term.focus();
  }

  hide() {
    this.visible = false;
    this.root.style.display = 'none';
  }

  /** Stop reconnecting, close the socket, dispose every terminal, remove DOM. */
  destroy() {
    this.dead = true;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
    }
    for (const [pid, p] of this.panes) {
      p.term.dispose();
      p.el.remove();
      this.panes.delete(pid);
    }
    this.root.remove();
  }

  // ---- protocol ------------------------------------------------------------

  private onState(json: string) {
    let msg: StateMsg;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (msg.t === 'session_end') {
      // "Done with this host": stop touching the socket; the shell decides
      // what replaces this workspace.
      this.dead = true;
      this.ws?.close();
      this.hooks.onSessionEnd(this);
      return;
    }
    if (msg.t !== 'state') return;
    this.windowList = msg.windows;
    this.activeWindow = msg.active_window;
    if (msg.layout) {
      this.applyLayout(msg.layout);
      this.nudgeSizeIfMismatched(msg.layout);
    }
    this.setActivePane(msg.active_pane);
    this.hooks.onUpdate(this);
  }

  private onBinary(buf: ArrayBuffer) {
    if (buf.byteLength < 4) return;
    const pane = new DataView(buf).getUint32(0, true);
    // Only panes in this workspace's active-window layout exist; output for a
    // background window is dropped (switching windows triggers a snapshot).
    const p = this.panes.get(pane);
    if (p) p.term.write(new Uint8Array(buf, 4));
  }

  // Place each leaf pane at its exact cell rectangle; dispose vanished panes.
  private applyLayout(root: LayoutNode) {
    const { cellW, cellH } = this.style;
    const seen = new Set<number>();
    const place = (n: LayoutNode) => {
      if (n.kind === 'leaf' && n.pane != null) {
        const p = this.panes.get(n.pane) ?? this.makePane(n.pane);
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

    for (const [pid, p] of [...this.panes]) {
      if (!seen.has(pid)) {
        p.term.dispose();
        p.el.remove();
        this.panes.delete(pid);
      }
    }
  }

  private makePane(id: number): Pane {
    const el = document.createElement('div');
    el.className = 'pane';
    el.addEventListener('mousedown', () => this.focusPane(id));
    this.root.appendChild(el);

    const term = new Terminal({
      fontFamily: this.style.font,
      fontSize: this.style.fontSize,
      lineHeight: this.style.lineHeight,
      scrollback: 10000,
      cursorBlink: true,
      theme: this.style.theme,
    });
    term.open(el);
    term.onData((d) => this.sendInput(id, d));

    const pane: Pane = { term, el };
    this.panes.set(id, pane);
    return pane;
  }

  focusPane(id: number) {
    this.sendJson({ t: 'focus', pane: id });
    this.setActivePane(id);
    this.panes.get(id)?.term.focus();
  }

  private setActivePane(id: number | null) {
    const changed = id !== this.activePane;
    this.activePane = id;
    for (const [pid, p] of this.panes) p.el.classList.toggle('active', pid === id);
    // Keyboard focus follows the active pane — but only for the workspace the
    // user is looking at (a background host's state must not steal focus).
    if (changed && id != null && this.visible) this.panes.get(id)?.term.focus();
  }

  // ---- output --------------------------------------------------------------

  sendJson(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendInput(pane: number, data: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = new TextEncoder().encode(data);
    const buf = new Uint8Array(4 + payload.length);
    new DataView(buf.buffer).setUint32(0, pane, true);
    buf.set(payload, 4);
    this.ws.send(buf);
  }

  // We are the screen; the daemon is the authoritative sizer. Report the whole
  // container size in cells; it splits it and pushes back the per-pane layout.
  private desiredSize() {
    return {
      cols: Math.max(20, Math.floor(this.container.clientWidth / this.style.cellW)),
      rows: Math.max(5, Math.floor(this.container.clientHeight / this.style.cellH)),
    };
  }

  sendResize() {
    const { cols, rows } = this.desiredSize();
    this.sendJson({ t: 'resize', cols, rows });
  }

  // Size self-healing: if a state snapshot is laid out at a size other than
  // ours (e.g. a session created at tmux's default 80x24 before our resize
  // landed), nudge the daemon. Rate-limited so a size we can't win degrades to
  // a slow nudge instead of a loop.
  private nudgeSizeIfMismatched(root: LayoutNode) {
    const { cols, rows } = this.desiredSize();
    if (root.w === cols && root.h === rows) return;
    const now = Date.now();
    if (now - this.lastSizeNudge < 1500) return;
    this.lastSizeNudge = now;
    this.sendJson({ t: 'resize', cols, rows });
  }

  // ---- command helpers (used by the shell's keybindings/toolbar) -----------

  splitActive(dir: 'h' | 'v') {
    if (this.activePane != null) this.sendJson({ t: 'split', pane: this.activePane, dir });
  }

  closeActive() {
    if (this.activePane != null) this.sendJson({ t: 'close_pane', pane: this.activePane });
  }

  navPane(dir: 'L' | 'R' | 'U' | 'D') {
    this.sendJson({ t: 'select_pane', dir });
  }

  switchWindowIndex(i: number) {
    const w = this.windowList[i];
    if (w) this.sendJson({ t: 'select_window', id: w.id });
  }

  switchWindowRel(delta: number) {
    if (!this.windowList.length) return;
    const idx = Math.max(0, this.windowList.findIndex((w) => w.id === this.activeWindow));
    const next = this.windowList[(idx + delta + this.windowList.length) % this.windowList.length];
    this.sendJson({ t: 'select_window', id: next.id });
  }

  selection(): string {
    return (this.activePane != null && this.panes.get(this.activePane)?.term.getSelection()) || '';
  }
}
