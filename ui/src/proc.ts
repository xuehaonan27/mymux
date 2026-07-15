// Mini-htop overlay: window → pane → process tree, polled from the daemon's
// /proc/tree, with a scoped per-row kill (POST /proc/kill). Follows the same
// overlay pattern as code.ts.

// Resolved per call so the panel follows the active workspace's daemon.
let apiBase = () => 'http://127.0.0.1:8088';

interface ProcNode {
  pid: number;
  ppid: number;
  depth: number;
  comm: string;
  cmd: string;
  state: string;
  rss_kb: number;
  cpu_jiffies: number;
}
interface PaneProcs {
  pane: number;
  pid: number;
  procs: ProcNode[];
}
interface WinProcs {
  id: number;
  name: string;
  ephemeral?: boolean;
  panes: PaneProcs[];
}
interface ProcTree {
  clk_tck: number;
  windows: WinProcs[];
}

export interface ProcPanel {
  toggle(): void;
  isOpen(): boolean;
}

const fmtMem = (kb: number) =>
  kb >= 1048576
    ? (kb / 1048576).toFixed(1) + 'G'
    : kb >= 1024
      ? (kb / 1024).toFixed(0) + 'M'
      : kb + 'K';

/** The process-tree overlay (a lightweight, scoped top/htop). */
export function initProcPanel(opts: { getApiBase: () => string }): ProcPanel {
  apiBase = opts.getApiBase;
  const panel = document.createElement('div');
  panel.id = 'proc';
  panel.className = 'proc-panel';
  panel.innerHTML = `
    <div class="proc-hd"><span>processes</span><span class="proc-hint">✕ SIGTERM · ⇧✕ SIGKILL · esc / ⌘K i close</span></div>
    <div class="proc-body" id="proc-body"></div>`;
  document.body.appendChild(panel);
  const body = panel.querySelector('#proc-body') as HTMLElement;

  let open = false;
  let timer: number | undefined;
  // pid → last cpu_jiffies, for the %CPU delta between polls.
  let prev = new Map<number, number>();
  let prevAt = 0;

  async function kill(pid: number, hard: boolean) {
    try {
      await fetch(`${apiBase()}/proc/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid, signal: hard ? 'KILL' : 'TERM' }),
      });
    } catch {
      /* ignore; next poll reflects reality */
    }
    void poll();
  }

  function procRow(p: ProcNode, clkTck: number, dt: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'prow';

    const last = prev.get(p.pid);
    const cpu =
      last != null && dt > 0 ? Math.max(0, ((p.cpu_jiffies - last) / clkTck / dt) * 100) : 0;
    const cpuEl = document.createElement('span');
    cpuEl.className = 'pcpu' + (cpu >= 50 ? ' hot' : cpu >= 5 ? ' warm' : '');
    cpuEl.textContent = `${cpu.toFixed(0)}%`;

    const memEl = document.createElement('span');
    memEl.className = 'pmem';
    memEl.textContent = fmtMem(p.rss_kb);

    const stEl = document.createElement('span');
    stEl.className = `pstate st-${p.state}`;
    stEl.textContent = p.state;

    const cmdEl = document.createElement('span');
    cmdEl.className = 'pcmd';
    cmdEl.style.paddingLeft = `${p.depth * 14}px`;
    cmdEl.textContent = p.cmd;
    cmdEl.title = `pid ${p.pid} · ppid ${p.ppid}`;

    const killEl = document.createElement('button');
    killEl.className = 'pkill';
    killEl.textContent = '✕';
    killEl.title = `kill ${p.pid}  (⇧ = SIGKILL)`;
    killEl.addEventListener('click', (e) => {
      e.stopPropagation();
      void kill(p.pid, e.shiftKey);
    });

    row.append(cpuEl, memEl, stEl, cmdEl, killEl);
    return row;
  }

  async function poll() {
    let tree: ProcTree;
    try {
      const r = await fetch(`${apiBase()}/proc/tree`);
      if (!r.ok) return;
      tree = await r.json();
    } catch {
      return;
    }
    if (!open) return; // closed while the request was in flight

    const now = Date.now();
    const dt = prevAt ? (now - prevAt) / 1000 : 0;

    body.replaceChildren();
    for (const w of tree.windows) {
      // High-bit ids are daemon-native tabs; the kind flag tells ⌁ from ∞
      // (a promoted shell keeps its birth id but reports ephemeral=false).
      const native = w.id >= 0x40000000;
      const glyph = w.ephemeral ? '⌁' : native ? '∞' : '▸';
      const wh = document.createElement('div');
      wh.className = 'pwin' + (native ? ' eph' : '');
      wh.textContent = native
        ? `${glyph} ${w.name || w.id % 0x40000000}`
        : `▸ @${w.id} ${w.name}`;
      body.appendChild(wh);
      for (const pane of w.panes) {
        // Native windows hide the pane header while single-pane; splits get one.
        if (!native || w.panes.length > 1) {
          const ph = document.createElement('div');
          ph.className = 'ppane';
          ph.textContent = native ? `pane ${pane.pane % 0x40000000}` : `pane %${pane.pane}`;
          body.appendChild(ph);
        }
        for (const p of pane.procs) body.appendChild(procRow(p, tree.clk_tck, dt));
      }
    }
    if (!tree.windows.length) body.textContent = 'no panes';

    // Remember this sample for the next %CPU delta.
    const next = new Map<number, number>();
    for (const w of tree.windows)
      for (const pane of w.panes) for (const p of pane.procs) next.set(p.pid, p.cpu_jiffies);
    prev = next;
    prevAt = now;
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      panel.classList.toggle('show', open);
      if (open) {
        prev = new Map(); // fresh %CPU baseline
        prevAt = 0;
        body.textContent = 'loading…';
        void poll();
        timer = window.setInterval(() => void poll(), 1500);
      } else if (timer != null) {
        window.clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
