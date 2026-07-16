import '@xterm/xterm/css/xterm.css';
import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { measureCell } from './metrics';
import type { CodePanel, CodePanelOpts } from './code';
import { initProcPanel } from './proc';
import { initPkgsPanel } from './pkgs';
import { initHostManager, type HostManager } from './hostmanager';
import { Workspace, WinInfo, WsState } from './workspace';
import { ACTIONS, directAction, leaderAction, helpRows, KeyDeps } from './keymap';
import { initNotify } from './notify';
import { getPrefs, setPrefs, onPrefsChange } from './prefs';
import { initSettingsPanel } from './settings';
import { presetById } from './theme';
import type { ITheme } from '@xterm/xterm';

// The shell: a registry of per-host Workspaces (each owns its WS + panes; see
// workspace.ts), the shared bar (host chips / window tabs / agent counts), the
// overlays, and keybindings routed to the visible workspace.

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

/** The preset's term theme for the current translucency state. While anything
 * is see-through (alpha < 1) the xterm canvas must carry NO background of its
 * own — opacity lives on the .pane surface (--surface-alpha), so "pane
 * opacity" means "how solid the terminal SURFACE is" instead of just shading
 * the canvas. Opaque default = the preset's solid color, as before. */
function termThemeWithOpacity(theme: ITheme, alpha: number): ITheme {
  if (alpha >= 1) return theme;
  return { ...theme, background: 'transparent' };
}

// Terminal colors come from the active theme preset (see theme.ts); the whole
// app re-themes live when the user switches presets in settings.
const THEME = presetById(getPrefs().theme).term;
const { cellW, cellH } = measureCell(FONT, FONT_SIZE, LINE_HEIGHT);
const STYLE = { font: FONT, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, theme: THEME, cellW, cellH };

/** The single source of truth for the see-through state. The sliders are
 * INERT unless there is a backdrop to reveal — without one, dragging them
 * must change nothing (previously the xterm canvas still went transparent,
 * over the stock opaque viewport it read as "the terminal just darkens").
 * Two mutually exclusive backdrop modes: image (desktop app or browser) and
 * whole-window transparency (desktop app only, image yields to it). */
function backdropState(): {
  hasImg: boolean;
  winTranslucent: boolean;
  /** Effective .pane surface alpha: paneOpacity × windowOpacity, else 1. */
  surfaceAlpha: number;
} {
  const p = getPrefs();
  const winTranslucent = isTauri && p.windowOpacity < 1;
  const hasImg = p.bgImage.trim().length > 0 && !winTranslucent;
  const active = winTranslucent || hasImg;
  return {
    hasImg,
    winTranslucent,
    surfaceAlpha: active ? p.paneOpacity * (winTranslucent ? p.windowOpacity : 1) : 1,
  };
}

/** The xterm canvas alpha for the current state: solid unless a backdrop is
 * active — see backdropState for why the sliders are otherwise inert. */
function currentTermAlpha(): number {
  const { surfaceAlpha } = backdropState();
  return surfaceAlpha;
}

/** Apply the active preset everywhere: chrome (body[data-theme]), every
 * workspace's terminals, and the code panel's editors. */
function applyTheme(id: string) {
  const preset = presetById(id);
  document.body.dataset.theme = preset.id;
  const term = termThemeWithOpacity(preset.term, currentTermAlpha());
  for (const w of workspaces.values()) w.setTermTheme(term);
  codePanel.retheme();
}

/** Apply the backdrop prefs, driven by backdropState(). Backdrop IMAGE: a
 * (dimmed) image painted ON the body's own background (a ::before would be
 * covered BY the body background). WINDOW transparency: html+body go fully
 * transparent so the desktop shows through; the image yields to it. Shared
 * plumbing: #term transparent, the .pane SURFACE carries --surface-alpha,
 * the xterm canvas goes backgroundless (termThemeWithOpacity), and xterm's
 * stock opaque viewport is CSS-overridden in these modes. */
function applyBackground() {
  const p = getPrefs();
  const { hasImg, winTranslucent, surfaceAlpha } = backdropState();
  document.body.classList.toggle('has-bgimage', hasImg);
  document.body.classList.toggle('has-winalpha', winTranslucent);
  document.documentElement.style.background = winTranslucent ? 'transparent' : '';
  const img = p.bgImage.trim();
  document.body.style.backgroundImage = hasImg
    ? `linear-gradient(rgba(5, 8, 12, ${p.bgDim}), rgba(5, 8, 12, ${p.bgDim})), url('${img.replace(/'/g, '%27')}')`
    : '';
  document.body.style.backgroundSize = hasImg ? 'cover' : '';
  document.body.style.backgroundPosition = hasImg ? 'center' : '';
  document.body.style.setProperty('--surface-alpha', String(surfaceAlpha));
  document.body.style.setProperty('--win-alpha', String(winTranslucent ? p.windowOpacity : 1));
}

const termArea = document.getElementById('term') as HTMLDivElement;
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const hostsEl = document.getElementById('hostbar') as HTMLElement;
const statusEl = document.getElementById('status')!;
const metaEl = document.getElementById('meta')!;
const agentsEl = document.getElementById('agents')!;
const hintEl = document.getElementById('hint')!;

// The empty state: shown when every session has ended and the host picker was
// dismissed without connecting — instead of a void window (reported bug).
const emptyEl = document.createElement('div');
emptyEl.id = 'empty';
{
  const t = document.createElement('div');
  t.className = 'empty-title';
  t.textContent = 'No windows';
  const s = document.createElement('div');
  s.className = 'empty-sub';
  s.textContent = 'All sessions ended.';
  const b = document.createElement('button');
  b.className = 'pkgs-btn primary';
  b.textContent = 'Connect to a host…';
  b.addEventListener('click', () => hostManager?.open());
  emptyEl.append(t, s, b);
  termArea.appendChild(emptyEl);
}
function renderEmpty() {
  emptyEl.classList.toggle('show', workspaces.size === 0);
}

/** macOS transparent-webview ghost buster: when content disappears in a
 * translucent window, the compositor can keep the last frame (dead terminal
 * text lingers). Nudge the layer so the region actually repaints. */
function forceRepaint(el: HTMLElement) {
  el.style.opacity = '0.999';
  void el.offsetHeight; // reflow: the sub-1 opacity flip re-composites
  el.style.opacity = '';
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const mod = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
// Dev knob: `?port=N` points the browser UI at a throwaway daemon started
// with MYMUX_ADDR (instead of the main one on 8088) — safe UX iteration.
const daemonPort = Number(new URLSearchParams(location.search).get('port')) || 8088;
// In the Tauri app there is no browser reserving Cmd+T/W/1-9, so we bind the
// full iTerm2 set there; in a browser those stay on the ⌘K leader.
const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

// ---- attention queue --------------------------------------------------------
// Windows whose agent needs a human (waiting for approval/input, or done),
// across ALL hosts, ordered by when they FIRST needed you. Entries leave on
// their own once handled: answering flips waiting→running (hook), and focusing
// a window clears its done badge (daemon) — so the queue is a pure derivation
// of the badge lifecycle.

interface AttnEntry {
  hostId: string;
  windowId: number;
  /** Pane to land keyboard focus on (kept fresh while queued). */
  paneId?: number;
  since: number;
}
let attentionQueue: AttnEntry[] = [];

function updateQueue(w: Workspace) {
  const needy = new Map(
    w.windowList
      .filter((x) => x.agent === 'waiting' || x.agent === 'done')
      .map((x) => [x.id, x]),
  );
  attentionQueue = attentionQueue.filter((e) => e.hostId !== w.id || needy.has(e.windowId));
  for (const [winId, win] of needy) {
    const existing = attentionQueue.find((e) => e.hostId === w.id && e.windowId === winId);
    if (existing) {
      existing.paneId = win.agent_pane; // keep position, refresh the target pane
      if (win.agent_since != null) existing.since = win.agent_since;
    } else {
      attentionQueue.push({
        hostId: w.id,
        windowId: winId,
        paneId: win.agent_pane,
        // The daemon's timestamp is authoritative: it survives UI reconnects
        // and orders correctly when one state carries several new entries
        // (an approval storm) or entries span hosts.
        since: win.agent_since ?? Date.now(),
      });
    }
  }
  attentionQueue.sort((a, b) => a.since - b.since);
}

// Bring the user to a specific window on a specific host: app focus (app
// only), host switch, window select, and keyboard focus on the target pane.
function jumpTo(t: { hostId: string; windowId: number; paneId?: number }) {
  // Lazy: getCurrentWindow() reads Tauri internals that don't exist in a
  // plain browser, so it must only run in the app.
  if (isTauri) void getCurrentWindow().setFocus();
  const w = workspaces.get(t.hostId);
  if (!w) return;
  if (w !== activeWs) switchTo(w.id);
  w.sendJson({ t: 'select_window', id: t.windowId });
  // Land keyboard focus on the agent's pane (no manual click). The daemon
  // orders this after the window switch; the resulting state focuses locally.
  if (t.paneId != null) w.sendJson({ t: 'focus', pane: t.paneId });
}

// Jump to the oldest item that isn't the window you're already looking at.
function jumpToAttention() {
  attentionQueue = attentionQueue.filter((e) => workspaces.has(e.hostId));
  const entry = attentionQueue.find(
    (e) => !(workspaces.get(e.hostId) === activeWs && e.windowId === activeWs?.activeWindow),
  );
  if (!entry) {
    toast(
      attentionQueue.length
        ? 'The only thing waiting on you is this window.'
        : 'All clear — no agent needs you right now.',
    );
    return;
  }
  jumpTo(entry);
}

// Transient notice (bottom center, auto-fades).
const toastEl = document.createElement('div');
toastEl.className = 'toast';
document.body.appendChild(toastEl);
let toastTimer: number | undefined;
function toast(msg: string, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}

// Busy-pane close confirmation (the daemon refused a non-forced close).
// Mouse-only, like every inline control: keys stay with the terminal.
const confirmEl = document.createElement('div');
confirmEl.className = 'confirm-bar';
document.body.appendChild(confirmEl);
function showConfirmClose(w: Workspace, pane: number, cmd: string) {
  confirmEl.replaceChildren();
  const label = document.createElement('span');
  label.textContent = `Pane is running ${cmd || 'a job'} — close it anyway?`;
  const mk = (text: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = cls;
    b.addEventListener('click', () => {
      confirmEl.classList.remove('show');
      fn();
    });
    return b;
  };
  confirmEl.append(
    label,
    mk('Close', 'danger', () => w.sendJson({ t: 'close_pane', pane, force: true })),
    mk('Keep', '', () => {}),
  );
  confirmEl.classList.add('show');
}

// ∞→⌁ demotion gives up the survives-restarts guarantee: confirm it (mouse
// only, per house rules) before telling the daemon.
function showDemoteConfirm(w: Workspace, id: number) {
  confirmEl.replaceChildren();
  const label = document.createElement('span');
  label.textContent = 'Make this window throwaway (⌁)? It will die when mymuxd stops.';
  const mk = (text: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = cls;
    b.addEventListener('click', () => {
      confirmEl.classList.remove('show');
      fn();
    });
    return b;
  };
  confirmEl.append(
    label,
    mk('Make ⌁', 'danger', () => {
      w.sendJson({ t: 'demote_window', id });
      toast('Demoted to ⌁ — dies with the daemon now.');
    }),
    mk('Keep ∞', '', () => {}),
  );
  confirmEl.classList.add('show');
}

// New-window-in-directory prompt (⌘K o): spawn a shell elsewhere WITHOUT
// cd-ing the current pane (its agent keeps running). Keys follow house rules
// (Enter/Esc swallowed); creation is explicit via ✓-style buttons, and blur
// CANCELS here — unlike rename's blur-saves, accidentally creating a window
// is worse than retyping a path.
const cwdEl = document.createElement('div');
cwdEl.className = 'confirm-bar';
document.body.appendChild(cwdEl);
function openCwdPrompt() {
  const w = active();
  if (!w) return;
  cwdEl.replaceChildren();
  const label = document.createElement('span');
  label.textContent = 'New ∞ window in:';
  const input = document.createElement('input');
  input.className = 'cwd-input';
  input.placeholder = '~/some/dir — empty or invalid = current pane’s dir';
  input.spellcheck = false;
  let done = false;
  const finish = (create: boolean) => {
    if (done) return;
    done = true;
    const dir = input.value.trim();
    cwdEl.classList.remove('show');
    if (create) w.sendJson({ t: 'new_persistent', cwd: dir || undefined });
    w.refocusActive();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') e.preventDefault(); // swallowed
  });
  input.addEventListener('blur', () => finish(false));
  const mk = (text: string, cls: string, create: boolean) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = cls;
    // mousedown+preventDefault: don't blur the input before we decide.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish(create);
    });
    return b;
  };
  cwdEl.append(label, input, mk('Create', '', true), mk('Cancel', '', false));
  cwdEl.classList.add('show');
  input.focus();
}

// Keymap help (⌘/ or ⌘K /). Generated from the keymap tables so it can never
// drift from the actual bindings. Click anywhere to dismiss — no Esc.
const helpEl = document.createElement('div');
helpEl.className = 'help-panel';
{
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = helpRows()
    .map(
      ([app, leader, desc]) =>
        `<tr><td>${esc(app)}</td><td>${esc(leader)}</td><td>${esc(desc)}</td></tr>`,
    )
    .join('');
  helpEl.innerHTML = `<div class="help-card">
  <h2>mymux keys — app column works in the desktop app; ⌘K works everywhere</h2>
  <table>
    <tr><th>app</th><th>⌘K …</th><th></th></tr>
    ${rows}
    <tr><td>⌘1–9</td><td>⌘K 1–9</td><td>switch window</td></tr>
    <tr><td>⌘⇧1–9</td><td></td><td>switch host</td></tr>
    <tr><td>⌘⌥arrows</td><td>⌘K arrows</td><td>move focus between panes</td></tr>
    <tr><td colspan="2">double-click tab</td><td>rename (✓ or click away = save, ✕ = cancel)</td></tr>
    <tr><td colspan="2">drag tab</td><td>reorder windows (persists across restarts)</td></tr>
  </table>
</div>`;
}
document.body.appendChild(helpEl);
helpEl.addEventListener('click', () => {
  helpEl.classList.remove('show');
  noteModal('help', false);
});
function toggleHelp() {
  helpEl.classList.toggle('show');
  noteModal('help', helpEl.classList.contains('show'));
}

// ---- modal stack ------------------------------------------------------------
// Overlays register here so Esc (and modal-scoped keys) always hit the TOP
// layer, never one underneath (was a fixed-order cascade: opening settings
// over the editor, then Esc, closed the EDITOR). Every open/close path calls
// noteModal; entries whose panel closed out-of-band self-prune on read.
interface Modal {
  isOpen(): boolean;
  close(): void;
  /** Modal-scoped keys (e.g. the code panel's ⌘E/⌘P/Esc). true = consumed. */
  onKey?(e: KeyboardEvent): boolean;
}
const modalOrder: string[] = []; // bottom → top
const modalRegistry = new Map<string, Modal>();
function registerModal(id: string, m: Modal) {
  modalRegistry.set(id, m);
}
function noteModal(id: string, open: boolean) {
  const i = modalOrder.indexOf(id);
  if (i >= 0) modalOrder.splice(i, 1);
  if (open) modalOrder.push(id);
}
function topModal(): Modal | null {
  while (modalOrder.length) {
    const m = modalRegistry.get(modalOrder[modalOrder.length - 1]);
    if (m?.isOpen()) return m;
    modalOrder.pop(); // stale (closed out-of-band) or never registered
  }
  return null;
}
registerModal('help', {
  isOpen: () => helpEl.classList.contains('show'),
  close: () => toggleHelp(),
});

// ---- workspace registry ----------------------------------------------------

const workspaces = new Map<string, Workspace>();
let activeWs: Workspace | null = null;
const active = () => activeWs;
let hostManager: HostManager | null = null;

function ensureWorkspace(id: string, label: string, port: number): Workspace {
  const existing = workspaces.get(id);
  if (existing) return existing;
  renderEmpty(); // a workspace arriving hides the empty state
  const w = new Workspace({
    id,
    label,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    apiBase: `http://127.0.0.1:${port}`,
    container: termArea,
    // A workspace born after the user set pane opacity must not flash solid.
    style: { ...STYLE, theme: termThemeWithOpacity(STYLE.theme, currentTermAlpha()) },
    hooks: {
      onUpdate(w) {
        updateQueue(w);
        notifier.watch(w);
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
      onConfirmClose(w, pane, cmd) {
        showConfirmClose(w, pane, cmd);
      },
      onError(_w, msg) {
        toast(msg, 6000); // errors the user must act on linger longer
      },
      onOpenHosts: isTauri ? () => hostManager?.open() : undefined,
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
  // Keyboard follows the switch (a chip click would otherwise leave focus on
  // the chip button; a fresh host's panes focus on their first state).
  w.refocusActive();
}

// Hosts open right now, persisted so the next launch can offer to restore
// the whole set (the host manager guides through their passphrases).
function saveOpenHosts() {
  localStorage.setItem('mymux.openHosts', JSON.stringify([...workspaces.keys()]));
}

// A workspace is over (its session ended, or the user disconnected the host).
function endWorkspace(w: Workspace, disconnectTunnel: boolean) {
  workspaces.delete(w.id);
  saveOpenHosts();
  attentionQueue = attentionQueue.filter((e) => e.hostId !== w.id);
  notifier.forget(w.id);
  w.destroy();
  if (document.body.classList.contains('has-winalpha')) forceRepaint(termArea);
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
      ensureWorkspace('local', 'local', daemonPort);
      switchTo('local');
    }
    renderEmpty();
    return;
  }
  renderHosts();
  renderAgents();
  renderEmpty();
}

// ---- shared bar rendering ----------------------------------------------------

// Drag state for tab reordering: while a drag is live, renderTabs must not
// rebuild the bar (that would destroy the dragged element mid-flight).
let draggingTab: number | null = null;

function renderTabs(w: Workspace | null) {
  // A rename is in progress: don't rebuild the bar under the input (state
  // updates arrive constantly — e.g. the dblclick's own select_window echo).
  // finish() re-renders with the then-current windowList.
  if (tabsEl.querySelector('input.tab-rename')) return;
  if (draggingTab != null) return;
  tabsEl.replaceChildren();
  if (!w) return;
  const low = (id: number) => id % 0x40000000;
  for (const win of w.windowList) {
    const tab = document.createElement('button');
    tab.className =
      'tab' +
      (win.active ? ' active' : '') +
      (win.ephemeral ? ' ephemeral' : '') +
      (win.persistent ? ' persist' : '');
    if (win.agent) {
      const dot = document.createElement('span');
      dot.className = `adot agent-${win.agent}`;
      tab.appendChild(dot);
    }
    const glyph = win.ephemeral ? '⌁ ' : win.persistent ? '∞ ' : '';
    const label =
      win.name || (win.ephemeral || win.persistent ? String(low(win.id)) : `@${win.id}`);
    const zoomMark = win.active && w.zoomed ? ' ⤢' : '';
    tab.appendChild(document.createTextNode(glyph + label + zoomMark));
    tab.addEventListener('click', (e) => {
      // The 2nd click of a double-click must not re-select (its state echo
      // would race the rename input).
      if (e.detail > 1) return;
      w.sendJson({ t: 'select_window', id: win.id });
    });
    tab.addEventListener('dblclick', (e) => {
      e.preventDefault();
      beginRename(tab, w, win);
    });
    // Drag to reorder (any engine — the daemon owns one global tab order).
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      draggingTab = win.id;
      e.dataTransfer?.setData('text/plain', String(win.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', () => {
      draggingTab = null;
      tabsEl
        .querySelectorAll('.tab.drop-target')
        .forEach((t) => t.classList.remove('drop-target'));
      renderTabs(active()); // catch up on any state that arrived mid-drag
    });
    tab.addEventListener('dragover', (e) => {
      if (draggingTab == null || draggingTab === win.id) return;
      e.preventDefault(); // allow dropping here
      tab.classList.add('drop-target');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drop-target');
      if (draggingTab == null || draggingTab === win.id) return;
      const to = w.windowList.findIndex((x) => x.id === win.id);
      if (to >= 0) w.sendJson({ t: 'reorder_window', id: draggingTab, to });
    });
    tab.title =
      win.agent != null
        ? `${win.agent}${win.agent_since != null ? ` for ${agoMs(win.agent_since)}` : ''} · double-click to rename · drag to reorder`
        : 'double-click to rename · drag to reorder';
    tabsEl.appendChild(tab);
  }
}

/** Compact relative age for tooltips: 12s, 3m, 2h, 4d. */
function agoMs(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Inline tab rename (native dialogs are unreliable in the Tauri webview).
// Mouse-only contract: click away or ✓ saves, ✕ cancels. Enter AND Esc are
// deliberately swallowed — both carry hot semantics in a terminal (\r runs
// the prompt line, Esc interrupts coding agents), so while renaming they must
// go nowhere; muscle-memory presses die safely in the input.
function beginRename(tab: HTMLElement, w: Workspace, win: WinInfo) {
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = win.name || '';
  const mkBtn = (cls: string, label: string, title: string, commit: boolean) => {
    const b = document.createElement('span');
    b.className = `tab-rename-btn ${cls}`;
    b.textContent = label;
    b.title = title;
    // mousedown, not click: a click would first blur the input (= save),
    // making ✕ commit before it could cancel. preventDefault keeps focus in
    // the input, so no blur fires and the outcome is exactly ours.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish(commit);
      active()?.refocusActive();
    });
    return b;
  };
  const btnOk = mkBtn('ok', '✓', 'save', true);
  const btnCancel = mkBtn('cancel', '✕', 'cancel', false);
  tab.replaceChildren(input, btnOk, btnCancel);
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    // Remove the input BEFORE re-rendering: renderTabs skips rebuilds while a
    // rename input is present, so leaving it attached would wedge the bar.
    input.remove();
    if (commit && name !== (win.name || '')) {
      w.sendJson({ t: 'rename_window', id: win.id, name });
    }
    renderTabs(active()); // restore now; the server state re-renders with the new name
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') e.preventDefault(); // swallowed, see above
  });
  // Clicks inside the input must not bubble to the tab (select_window /
  // re-entering beginRename on a double-click-to-select-word).
  for (const ev of ['mousedown', 'click', 'dblclick'] as const) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
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
  const show = workspaces.size >= 2 || (getPrefs().hostBarAlways && workspaces.size >= 1);
  hostsEl.style.display = show ? 'flex' : 'none';
  document.body.classList.toggle('has-hostbar', show);
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
    // Many hosts overflow into a horizontal scroll — keep the active one visible.
    if (w === activeWs) chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
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

// The ⏳/✓ summary doubles as the "take me there" button.
agentsEl.title = 'Jump to the next window that needs you (⌘J)';
agentsEl.addEventListener('click', jumpToAttention);

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
  active()?.sendJson({ t: 'new_persistent' }),
);
document.getElementById('btn-splith')?.addEventListener('click', () => active()?.splitActive('h'));
document.getElementById('btn-splitv')?.addEventListener('click', () => active()?.splitActive('v'));

// ---- overlays ------------------------------------------------------------------

const codeOpts: CodePanelOpts = {
  getActivePane: () => active()?.activePane ?? null,
  getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
  getScope: () => active()?.id ?? 'local',
  getDefaultRoot: () => getPrefs().codeRoot,
};
// CodeMirror is heavy, so the code panel loads on first use (vite splits the
// chunk); the wrapper keeps the synchronous interface the shell expects.
let codeReal: CodePanel | null = null;
let codeLoading = false;
const codePanel = {
  isOpen: () => codeReal?.isOpen() ?? false,
  toggle: () => {
    if (codeReal) return codeReal.toggle();
    if (codeLoading) return;
    codeLoading = true;
    void import('./code').then((m) => {
      codeReal = m.initCodePanel(codeOpts);
      codeReal.toggle();
      // The panel materializes HERE (async chunk) — this is when the modal
      // stack can truthfully record it (a synchronous noteModal at the call
      // site would read isOpen()=false and drop the entry).
      noteModal('code', codeReal.isOpen());
    });
  },
  quickOpen: () => codeReal?.quickOpen(),
  escape: () => codeReal?.escape() ?? false,
  retheme: () => codeReal?.retheme(),
};
const procPanel = initProcPanel({
  getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
});
const pkgsPanel = initPkgsPanel({
  getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
});
// The git graph is a plugin-shaped module (ui/src/gitgraph.ts) behind a
// lazy dynamic import, same contract shape as the code panel's wrapper.
let gitReal: import('./gitgraph').GitGraphPanel | null = null;
let gitLoading = false;
const gitPanel = {
  isOpen: () => gitReal?.isOpen() ?? false,
  toggle: () => {
    if (gitReal) return gitReal.toggle();
    if (gitLoading) return;
    gitLoading = true;
    void import('./gitgraph').then((m) => {
      gitReal = m.initGitGraph({
        getActivePane: () => active()?.activePane ?? null,
        getApiBase: () => active()?.apiBase ?? 'http://127.0.0.1:8088',
        toast,
      });
      gitReal.toggle();
      noteModal('gitgraph', gitReal.isOpen());
    });
  },
};
function toggleGitGraph() {
  gitPanel.toggle();
  if (gitReal) noteModal('gitgraph', gitReal.isOpen());
  setLeader(false);
}
registerModal('gitgraph', { isOpen: () => gitPanel.isOpen(), close: () => toggleGitGraph() });
// The overlays are full-screen and share a z-band, so they're mutually exclusive.
function closeOtherPanels(keep: 'code' | 'proc' | 'pkgs') {
  if (keep !== 'code' && codePanel.isOpen()) codePanel.toggle();
  if (keep !== 'proc' && procPanel.isOpen()) procPanel.toggle();
  if (keep !== 'pkgs' && pkgsPanel.isOpen()) pkgsPanel.toggle();
}
function toggleCode() {
  closeOtherPanels('code');
  codePanel.toggle();
  // codeReal is null while the chunk loads — the stack entry lands in the
  // wrapper's .then above; here we only keep a LOADED panel's record exact.
  if (codeReal) noteModal('code', codeReal.isOpen());
  setLeader(false);
}
function toggleProc() {
  closeOtherPanels('proc');
  procPanel.toggle();
  noteModal('proc', procPanel.isOpen());
  setLeader(false);
}
function togglePlugins() {
  closeOtherPanels('pkgs');
  pkgsPanel.toggle();
  noteModal('pkgs', pkgsPanel.isOpen());
  setLeader(false);
}
registerModal('code', {
  isOpen: () => codePanel.isOpen(),
  close: () => codePanel.toggle(),
  onKey: (e) => {
    const lower = e.key.toLowerCase();
    if (mod(e) && lower === 'e' && !e.shiftKey && !e.altKey) {
      toggleCode();
      return true;
    }
    if (mod(e) && lower === 'p' && !e.shiftKey && !e.altKey) {
      codePanel.quickOpen();
      return true;
    }
    if (e.key === 'Escape') {
      // The editor's own layers (quick-open, code-action menu) consume first.
      if (!codePanel.escape()) codePanel.toggle();
      return true;
    }
    return false;
  },
});
registerModal('proc', { isOpen: () => procPanel.isOpen(), close: () => toggleProc() });
registerModal('pkgs', { isOpen: () => pkgsPanel.isOpen(), close: () => togglePlugins() });
document.getElementById('btn-code')?.addEventListener('click', toggleCode);
document.getElementById('btn-proc')?.addEventListener('click', toggleProc);
document.getElementById('btn-pkgs')?.addEventListener('click', togglePlugins);
document.getElementById('btn-git')?.addEventListener('click', toggleGitGraph);

// Agent attention notifications (see notify.ts): the bell arms a system-level
// alert for agents that enter waiting/done while the app is unfocused. Off by
// default — enabling asks the OS/browser for permission (which needs this
// user gesture anyway).
const notifier = initNotify({
  isTauri,
  jumpTo,
  hostLabel: (id) => workspaces.get(id)?.label ?? id,
  getEnabled: () => getPrefs().notify,
  setEnabled: (v) => setPrefs({ notify: v }),
});
const notifyBtn = document.getElementById('btn-notify')!;
function renderNotifyBtn() {
  const s = notifier.state();
  notifyBtn.classList.toggle('on', s === 'on');
  notifyBtn.classList.toggle('denied', s === 'denied');
  notifyBtn.title =
    s === 'on'
      ? 'Agent notifications ON — waiting/done agents alert you while unfocused (click to mute)'
      : s === 'denied'
        ? 'Notifications are blocked — allow them in the browser/OS site settings first'
        : 'Agent notifications OFF — click to get alerted when an agent needs you';
}
notifyBtn.addEventListener('click', () => {
  void notifier.toggle().then(renderNotifyBtn);
});
renderNotifyBtn();

const settingsPanel = initSettingsPanel();
function toggleSettings() {
  settingsPanel.toggle();
  noteModal('settings', settingsPanel.isOpen());
  setLeader(false);
}
registerModal('settings', {
  isOpen: () => settingsPanel.isOpen(),
  close: () => toggleSettings(),
});
document.getElementById('btn-settings')?.addEventListener('click', toggleSettings);
// Prefs written anywhere (settings panel, bell, host manager) re-render the
// surfaces they affect.
onPrefsChange(() => {
  renderHosts();
  renderNotifyBtn();
  applyTheme(getPrefs().theme);
  applyBackground();
});
applyTheme(getPrefs().theme); // boot: dataset + (no workspaces yet, but code panel later reads prefs)
applyBackground();
renderEmpty(); // boot with no workspace (Tauri gate) shows the empty state

// ---- keybindings — dispatch driven by the keymap tables (see keymap.ts) -------

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
  ArrowLeft: 'L',
  ArrowRight: 'R',
  ArrowUp: 'U',
  ArrowDown: 'D',
};

// ⌁↔∞ toggle on the active window: promote silently, demote with a confirm.
function keepToggle() {
  const w = active();
  if (!w) return;
  const win = w.windowList.find((x) => x.active);
  if (!win) return;
  if (win.ephemeral) {
    w.sendJson({ t: 'promote_window', id: win.id });
    toast('Promoted to ∞ — this shell now survives restarts.');
  } else if (win.persistent) {
    showDemoteConfirm(w, win.id);
  } else {
    toast('tmux windows are managed by tmux.');
  }
}

const keyDeps: KeyDeps = {
  ws: () => active(),
  openCwdPrompt,
  toggleHelp,
  toggleProc: () => toggleProc(),
  toggleCode: () => toggleCode(),
  jumpAttention: () => jumpToAttention(),
  keepToggle,
  togglePlugins: () => togglePlugins(),
  toggleGitGraph: () => toggleGitGraph(),
  toggleSettings: () => toggleSettings(),
};

function handleLeaderKey(e: KeyboardEvent) {
  const k = e.key;
  if (k === 'Escape') return;
  const w = active();
  if (!w) return;
  const a = leaderAction(k.toLowerCase()) ?? leaderAction(k);
  if (a) return ACTIONS[a].run(keyDeps);
  if (k >= '1' && k <= '9') return w.switchWindowIndex(parseInt(k, 10) - 1);
  const d = ARROWS[k];
  if (d) w.navPane(d);
}

document.addEventListener(
  'keydown',
  (e) => {
    // Modal stack first: the TOP overlay owns Esc and its scoped keys; while
    // any overlay is open the app keymap (leader, ⌘ actions) is suspended.
    // Keys it doesn't consume still reach the focused element (editor, input).
    const top = topModal();
    if (top) {
      const consumed = top.onKey?.(e) ?? false;
      if (consumed) {
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        top.close();
      }
      return;
    }

    if (leaderActive) {
      // Ignore modifier-only keydowns so a chorded second key still works.
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

    if (!mod(e)) return;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const lower = e.key.toLowerCase();

    // The leader itself, and the two parameterized families the tables don't
    // model: ⌘1-9 windows (app), ⌘⇧1-9 hosts (app; the one shift exception),
    // ⌘⌥arrows pane nav, and ⌘C copy-when-selected.
    if (lower === 'k' && !e.shiftKey && !e.altKey) {
      stop();
      setLeader(true);
      return;
    }
    if (lower === 'c' && !e.shiftKey && !e.altKey) {
      if (active()?.selection()) {
        stop();
        copySelection();
      }
      return; // no selection → let ⌘C reach the terminal (SIGINT etc.)
    }
    if (e.altKey && ARROWS[e.key]) {
      stop();
      active()?.navPane(ARROWS[e.key]);
      return;
    }
    if (isTauri) {
      if (e.shiftKey && !e.altKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
        stop();
        const ids = [...workspaces.keys()];
        const id = ids[parseInt(e.code.slice(5), 10) - 1];
        if (id) switchTo(id);
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        stop();
        active()?.switchWindowIndex(parseInt(e.key, 10) - 1);
        return;
      }
    }

    // Same letter as the leader layer, bound directly under ⌘ where the
    // platform allows it (shift-free by design).
    if (!e.shiftKey && !e.altKey) {
      const action = directAction(e.key.toLowerCase(), isTauri);
      if (action) {
        stop();
        ACTIONS[action].run(keyDeps);
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
      saveOpenHosts();
    },
    onDisconnected(hostId) {
      const w = workspaces.get(hostId);
      if (w) endWorkspace(w, false); // tunnel already torn down by the manager
    },
    onVisibility(open) {
      noteModal('host', open);
    },
    prefs: {
      hostBarAlways: () => getPrefs().hostBarAlways,
      setHostBarAlways: (v) => setPrefs({ hostBarAlways: v }),
    },
  });
  registerModal('host', {
    isOpen: () => hostManager!.isOpen(),
    close: () => hostManager!.close(),
  });
  const hostBtn = document.getElementById('btn-host');
  if (hostBtn) {
    hostBtn.style.display = '';
    hostBtn.addEventListener('click', () => hostManager!.open());
  }
} else {
  ensureWorkspace('local', 'local', daemonPort);
  switchTo('local');
}
