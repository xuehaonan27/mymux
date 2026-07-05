import '@xterm/xterm/css/xterm.css';
import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { measureCell } from './metrics';
import type { CodePanel, CodePanelOpts } from './code';
import { initProcPanel } from './proc';
import { initHostManager } from './hostmanager';
import { Workspace, WinInfo, WsState } from './workspace';
import { ACTIONS, directAction, leaderAction, helpRows, KeyDeps } from './keymap';

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

// ---- user prefs (client-side; a fuller settings store is on the backlog) ----

interface Prefs {
  hostBarAlways?: boolean;
}
function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}');
  } catch {
    return {};
  }
}
let prefs: Prefs = loadPrefs();
function savePrefs(p: Prefs) {
  prefs = p;
  localStorage.setItem('mymux.prefs', JSON.stringify(p));
  renderHosts();
}

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
      .map((x) => [x.id, x.agent_pane]),
  );
  attentionQueue = attentionQueue.filter((e) => e.hostId !== w.id || needy.has(e.windowId));
  for (const [winId, pane] of needy) {
    const existing = attentionQueue.find((e) => e.hostId === w.id && e.windowId === winId);
    if (existing) existing.paneId = pane; // keep position, refresh the target pane
    else attentionQueue.push({ hostId: w.id, windowId: winId, paneId: pane, since: Date.now() });
  }
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
  const w = workspaces.get(entry.hostId)!;
  if (w !== activeWs) switchTo(w.id);
  w.sendJson({ t: 'select_window', id: entry.windowId });
  // Land keyboard focus on the agent's pane (no manual click). The daemon
  // orders this after the window switch; the resulting state focuses locally.
  if (entry.paneId != null) w.sendJson({ t: 'focus', pane: entry.paneId });
}

// Transient notice (bottom center, auto-fades).
const toastEl = document.createElement('div');
toastEl.className = 'toast';
document.body.appendChild(toastEl);
let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
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

// New-window-in-directory prompt (⌘K ⇧C): spawn a shell elsewhere WITHOUT
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
      ([desc, app, leader]) =>
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
helpEl.addEventListener('click', () => helpEl.classList.remove('show'));
function toggleHelp() {
  helpEl.classList.toggle('show');
}

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
        updateQueue(w);
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
    tab.title = 'double-click to rename · drag to reorder';
    tabsEl.appendChild(tab);
  }
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
  const show = workspaces.size >= 2 || (prefs.hostBarAlways === true && workspaces.size >= 1);
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
    });
  },
  quickOpen: () => codeReal?.quickOpen(),
  escape: () => codeReal?.escape() ?? false,
};
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

    // With the code panel open, only ⌘E / ⌘P / Esc are ours — the rest goes to
    // the editor (or the quick-open input).
    if (codePanel.isOpen()) {
      if (mod(e) && e.key.toLowerCase() === 'e' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        codePanel.toggle();
      } else if (mod(e) && e.key.toLowerCase() === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        codePanel.quickOpen();
      } else if (e.key === 'Escape') {
        if (!codePanel.escape()) codePanel.toggle();
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
    prefs: {
      hostBarAlways: () => prefs.hostBarAlways === true,
      setHostBarAlways: (v) => savePrefs({ ...prefs, hostBarAlways: v }),
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
