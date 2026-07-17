// One Workspace per connected host: it owns that host's WebSocket, xterm panes,
// window list, reconnect/suspend logic and size self-healing, and renders into
// its own layer under #term. The shell (main.ts) holds the registry, decides
// which workspace is visible, and renders the shared bar (tabs / chips /
// aggregate agent counts) from workspace data via the hooks.

import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { modHeld } from './modkey';
import { pathSpans } from './pathjump';
import { imeFixEnabled, installImeFix } from './imefix';

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
  /** The pane holding the agent state — attention jumps focus it directly. */
  agent_pane?: number;
  /** When the window first became attention-worthy (daemon epoch ms). */
  agent_since?: number;
  ephemeral?: boolean;
  /** ptyd-held native tab: survives mymuxd restarts. */
  persistent?: boolean;
}
interface StateMsg {
  t: string;
  active_window: number | null;
  active_pane: number | null;
  windows: WinInfo[];
  layout: LayoutNode | null;
  zoomed?: boolean;
  // confirm_close payload
  pane?: number;
  cmd?: string;
  // error payload
  msg?: string;
}

export type WsState = 'connecting' | 'open' | 'closed';

export interface TermStyle {
  font: string;
  fontSize: number;
  lineHeight: number;
  theme: ITheme;
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
  /** The daemon wants the user to confirm closing a busy pane. */
  onConfirmClose(w: Workspace, pane: number, cmd: string): void;
  /** The daemon reported an operational error (e.g. a spawn that failed). */
  onError?(w: Workspace, msg: string): void;
  /** Open the host manager (banner escape hatch; absent in the browser). */
  onOpenHosts?(): void;
  /** Open the raw terminal-history pager for a pane (scroll-top chip). */
  onOpenHistory?(w: Workspace, pane: number): void;
  /** ⌘+click on a path-ish token in a terminal (modifier-gated links). The
   * shell resolves it against the pane's cwd and opens the code panel there. */
  onJumpPath?(w: Workspace, pane: number, token: string): void;
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
  private readonly banner: HTMLDivElement;

  private readonly panes = new Map<number, Pane>();
  activePane: number | null = null;
  activeWindow: number | null = null;
  windowList: WinInfo[] = [];
  /** True while the active native window has a maximized pane. */
  zoomed = false;
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
    this.banner = document.createElement('div');
    this.banner.className = 'ws-banner';
    this.banner.style.display = 'none';
    this.root.appendChild(this.banner);
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
    // In-workspace banner, so a background host's trouble is visible the moment
    // you switch to it (the bar dot only reflects the visible workspace).
    if (s === 'open') {
      this.banner.style.display = 'none';
    } else {
      const text =
        s === 'connecting'
          ? `Connecting to ${this.label}…`
          : `Connection to ${this.label} lost — reconnecting…`;
      this.banner.replaceChildren(document.createTextNode(text));
      // Escape hatch: a dead daemon would otherwise leave this banner up
      // forever with nowhere to go.
      if (this.hooks.onOpenHosts) {
        const btn = document.createElement('button');
        btn.className = 'ws-banner-btn';
        btn.textContent = 'Hosts';
        btn.addEventListener('click', () => this.hooks.onOpenHosts?.());
        this.banner.appendChild(btn);
      }
      this.banner.style.display = '';
    }
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
    // Un-hiding a workspace is the same re-composite moment (host switch on a
    // translucent window): nudge once the reflowed content is on screen.
    this.ghostBust(120);
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
    if (msg.t === 'confirm_close') {
      if (msg.pane != null) this.hooks.onConfirmClose(this, msg.pane, msg.cmd ?? '');
      return;
    }
    if (msg.t === 'error') {
      this.hooks.onError?.(this, msg.msg ?? 'unknown daemon error');
      return;
    }
    if (msg.t !== 'state') return;
    this.windowList = msg.windows;
    this.activeWindow = msg.active_window;
    this.zoomed = msg.zoomed ?? false;
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

  /** macOS translucent-compositor nudge (the main.ts forceRepaint twin): an
   * instant re-composite, optionally re-fired after `delayMs` — content that
   * lands in LATER frames (window-switch snapshot bytes) repaints with
   * distorted font colours unless the layer is nudged again once it exists. */
  private ghostBust(delayMs = 0) {
    if (!document.body.classList.contains('has-winalpha')) return;
    const el = this.root;
    const flick = () => {
      el.style.opacity = '0.999';
      void el.offsetHeight; // reflow: the sub-1 opacity flip re-composites
      el.style.opacity = '';
    };
    if (delayMs > 0) window.setTimeout(flick, delayMs);
    else flick();
  }

  // Place each leaf pane at its exact cell rectangle; dispose vanished panes.
  private applyLayout(root: LayoutNode) {
    const { cellW, cellH } = this.style;
    const seen = new Set<number>();
    const idsBefore = new Set(this.panes.keys());
    const place = (n: LayoutNode) => {
      if (n.kind === 'leaf' && n.pane != null) {
        const p = this.panes.get(n.pane) ?? this.makePane(n.pane, n);
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
    // Transparent-window ghost buster: removed pixels linger in the macOS
    // compositor otherwise. A WINDOW SWITCH swaps the pane-ID set — very
    // often with an EQUAL count (1↔1), which a size check misses — and the
    // new window's snapshot bytes land a frame or two later, so the nudge
    // fires both at once and after they have painted.
    const setSwapped = seen.size !== idsBefore.size || [...seen].some((id) => !idsBefore.has(id));
    if (setSwapped) {
      this.ghostBust();
      this.ghostBust(120);
      // xterm bakes letter-spacing into spans when a row first renders; if the
      // dispose/create churn left it a degenerate glyph measurement, every row
      // it baked stays wide-spaced until re-rendered (what interaction heals
      // manually). Re-bake every viewport row once the DOM has settled.
      window.setTimeout(() => {
        for (const p of this.panes.values()) p.term.refresh(0, Math.max(0, p.term.rows - 1));
      }, 150);
    }
    // The active-pane ring exists to tell SPLIT panes apart — around a single
    // full-window pane it's just an ugly frame.
    this.root.classList.toggle('multi', this.panes.size > 1);
    this.renderDividers(root);
  }

  // Split dividers: hit areas along every internal layout boundary. Dragging
  // one shows a ghost line and sends ONE resize on release — the daemon
  // rebroadcasts the new layout, which is what actually moves the panes.
  private dividerDrag: { start: number; delta: number } | null = null;

  private renderDividers(root: LayoutNode) {
    if (this.dividerDrag) return; // a drag owns its ghost right now
    this.root.querySelectorAll('.divider').forEach((d) => d.remove());
    if (this.zoomed) return; // a zoomed window shows a single pane
    const { cellW, cellH } = this.style;
    // The resize target for a boundary: the leaf flush against its left/top
    // side (the deepest leaf of the left/top subtree in that direction).
    const edgeLeaf = (n: LayoutNode): number | null => {
      if (n.kind === 'leaf') return n.pane ?? null;
      const kids = n.children ?? [];
      return kids.length ? edgeLeaf(kids[kids.length - 1]) : null;
    };
    const walk = (n: LayoutNode) => {
      if (!n.children) return;
      const cols = n.kind === 'cols';
      const rows = n.kind === 'rows';
      if ((cols || rows) && n.children.length > 1) {
        const dir = cols ? 'right' : 'down';
        for (let i = 0; i + 1 < n.children.length; i++) {
          const c = n.children[i];
          const pane = edgeLeaf(c);
          if (pane == null) continue;
          const d = document.createElement('div');
          d.className = cols ? 'divider divider-v' : 'divider divider-h';
          if (cols) {
            d.style.left = `${(c.x + c.w) * cellW - 2}px`;
            d.style.top = `${c.y * cellH}px`;
            d.style.height = `${c.h * cellH}px`;
          } else {
            d.style.left = `${c.x * cellW}px`;
            d.style.top = `${(c.y + c.h) * cellH - 2}px`;
            d.style.width = `${c.w * cellW}px`;
          }
          d.addEventListener('pointerdown', (e) => this.startDividerDrag(e, d, dir, pane));
          this.root.appendChild(d);
        }
      }
      n.children.forEach(walk);
    };
    walk(root);
  }

  private startDividerDrag(e: PointerEvent, el: HTMLDivElement, dir: 'right' | 'down', pane: number) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    el.setPointerCapture(e.pointerId);
    const start = dir === 'right' ? e.clientX : e.clientY;
    const drag = { start, delta: 0 };
    this.dividerDrag = drag;
    el.classList.add('drag');
    const move = (ev: PointerEvent) => {
      drag.delta = (dir === 'right' ? ev.clientX : ev.clientY) - start;
      el.style.transform = dir === 'right' ? `translateX(${drag.delta}px)` : `translateY(${drag.delta}px)`;
    };
    const up = (ev: PointerEvent) => {
      move(ev);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const { cellW, cellH } = this.style;
      const cells = Math.round(drag.delta / (dir === 'right' ? cellW : cellH));
      this.dividerDrag = null;
      el.classList.remove('drag');
      if (cells !== 0) this.sendJson({ t: 'resize_pane', pane, dir, cells });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private makePane(id: number, n?: LayoutNode): Pane {
    const el = document.createElement('div');
    el.className = 'pane';
    el.addEventListener('mousedown', () => this.focusPane(id));
    // xterm's DOM renderer bakes letter-spacing from glyph probes AT RENDER
    // TIME — an open() on a 0×0 element is the degenerate measurement window
    // behind the wide-spaced-glyph bug, so the cell rect goes on FIRST.
    if (n) {
      const { cellW, cellH } = this.style;
      el.style.left = `${n.x * cellW}px`;
      el.style.top = `${n.y * cellH}px`;
      el.style.width = `${n.w * cellW}px`;
      el.style.height = `${n.h * cellH}px`;
    }
    this.root.appendChild(el);

    const term = new Terminal({
      fontFamily: this.style.font,
      fontSize: this.style.fontSize,
      lineHeight: this.style.lineHeight,
      scrollback: 10000,
      cursorBlink: true,
      // Lets an rgba() theme background show through (backdrop-image pref).
      allowTransparency: true,
      theme: this.style.theme,
    });
    term.open(el);
    if (n) term.resize(Math.max(1, n.w), Math.max(1, n.h));
    term.onData((d) => this.sendInput(id, d));

    // IME rescue for the macOS app (WKWebView drops Sogou-style non-composition
    // commits — see imefix.ts); a no-op elsewhere.
    if (imeFixEnabled()) installImeFix(term, (d) => this.sendInput(id, d));

    // ⌘+click path links (VS Code-style): provideLinks is modifier-GATED —
    // hold ⌘ and path-ish tokens underline and become clickable; with the
    // modifier up the terminal behaves exactly as before. The shell resolves
    // each token against THIS pane's cwd and opens the code panel there.
    term.registerLinkProvider({
      provideLinks: (y, cb) => {
        if (!modHeld()) {
          cb(undefined);
          return;
        }
        const line = term.buffer.active.getLine(y - 1);
        const spans = line ? pathSpans(line.translateToString(false)) : [];
        cb(
          spans.map((sp) => ({
            range: { start: { x: sp.start + 1, y }, end: { x: sp.start + sp.len, y } },
            text: sp.raw,
            decorations: { underline: true, pointerCursor: true },
            activate: () => {
              if (modHeld()) this.hooks.onJumpPath?.(this, id, sp.raw);
            },
          })),
        );
      },
    });

    // Scroll-top chip: the xterm buffer starts here, but the raw history log
    // goes way further back — offer the pager when the user hits the top.
    if (this.hooks.onOpenHistory) {
      const chip = document.createElement('button');
      chip.className = 'term-older';
      chip.textContent = '⇧ older output';
      chip.title = 'view the raw terminal history log';
      chip.style.display = 'none';
      chip.addEventListener('mousedown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hooks.onOpenHistory?.(this, id);
      });
      el.appendChild(chip);
      term.onScroll((ydisp: number) => {
        chip.style.display = ydisp === 0 ? '' : 'none';
      });
    }

    const pane: Pane = { term, el };
    this.panes.set(id, pane);
    return pane;
  }

  focusPane(id: number) {
    this.sendJson({ t: 'focus', pane: id });
    this.setActivePane(id);
    this.panes.get(id)?.term.focus();
  }

  /** Live-apply a new theme preset to every pane in this workspace. */
  setTermTheme(theme: ITheme) {
    for (const p of this.panes.values()) p.term.options.theme = theme;
  }

  /** Return keyboard focus to the active pane (e.g. after an inline input). */
  refocusActive() {
    if (this.activePane != null && this.visible) this.panes.get(this.activePane)?.term.focus();
  }

  private setActivePane(id: number | null) {
    const changed = id !== this.activePane;
    this.activePane = id;
    for (const [pid, p] of this.panes) p.el.classList.toggle('active', pid === id);
    // Keyboard focus follows the active pane — but only for the workspace the
    // user is looking at (a background host's state must not steal focus).
    // Also refocus when focus fell back to <body>: switching windows disposes
    // the previously-focused terminal, and no one else has claimed focus.
    const orphaned = document.activeElement === document.body;
    // Never steal focus from a text input (tab rename, host manager, …).
    const typing = document.activeElement instanceof HTMLInputElement;
    if ((changed || orphaned) && !typing && id != null && this.visible) {
      this.panes.get(id)?.term.focus();
    }
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
    // #term is an in-flow flex child below the toolbar, so clientHeight is
    // already the pure grid height; paddingTop stays in the math in case a
    // theme ever adds inner padding.
    const padTop = parseFloat(getComputedStyle(this.container).paddingTop) || 0;
    return {
      cols: Math.max(20, Math.floor(this.container.clientWidth / this.style.cellW)),
      rows: Math.max(5, Math.floor((this.container.clientHeight - padTop) / this.style.cellH)),
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
