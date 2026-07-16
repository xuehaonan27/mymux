// The git graph panel — Git Graph (mhutchie) for mymux, as a deliberately
// PLUGIN-SHAPED module: a narrow entry over explicit opts, no imports of
// code.ts internals. When a second UI module wants the same contract, both
// extract into the mymux-pkg "ui-module" kind untouched.
//
// Layout (mirrors the extension): a toolbar (repo, upstream ahead/behind,
// all-refs toggle, refresh), a left swim-lane graph (uncommitted card +
// commit topology from /git/log), and a right detail column (commit meta +
// files + inline diff from /git/show; uncommitted diffs from /git/diff).

export interface GitGraphOpts {
  /** The focused pane, for repo resolution (its cwd's toplevel). */
  getActivePane: () => number | null;
  getApiBase: () => string;
  /** Transient notices (op results, failures). */
  toast: (msg: string) => void;
}

export interface GitGraphPanel {
  toggle(): void;
  isOpen(): boolean;
}

interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string;
}
interface LogResp {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  commits: LogCommit[];
}
interface StatusFile {
  status: string;
  path: string;
}
interface ShowResp {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: StatusFile[];
  diff: string;
}

const ROW_H = 26;
const LANE_W = 14;
const PAD_X = 10;
const LANE_COLORS = 8; // lane-0..7 classes in style.css

export function initGitGraph(opts: GitGraphOpts): GitGraphPanel {
  const panel = document.createElement('div');
  panel.className = 'git-panel';
  document.body.appendChild(panel);
  let open = false;
  let seq = 0; // stale-response guard
  // Repo/session state, resolved on open.
  let root: string | null = null;
  let pane: number | null = null;
  let showAll = true;
  let selected = ''; // '' = uncommitted card; else commit hash
  let uncommitted: StatusFile[] = [];
  let logData: LogResp | null = null;

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await fetch(`${opts.getApiBase()}${path}`);
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  };
  const getText = async (path: string): Promise<string | null> => {
    try {
      const r = await fetch(`${opts.getApiBase()}${path}`);
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  };
  const qs = (params: Record<string, string | number | boolean | null | undefined>): string =>
    Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ---- swim-lane topology ----------------------------------------------------
  interface LayRow {
    c: LogCommit;
    lane: number;
    /** Lane column per parent (index-aligned with c.parents). */
    targets: number[];
    lanesAfter: (string | null)[];
  }

  /** Assign every commit a lane so parent links draw as column lines/curves:
   * a commit takes the lane expecting it (else a free one); its first parent
   * inherits that lane, extra parents claim free lanes; parents already
   * expected by another child curve into the existing column. */
  function layout(commits: LogCommit[]): LayRow[] {
    const lanes: (string | null)[] = [];
    const rows: LayRow[] = [];
    for (const c of commits) {
      let lane = lanes.indexOf(c.hash);
      if (lane < 0) {
        lane = lanes.indexOf(null);
        if (lane < 0) {
          lanes.push(null);
          lane = lanes.length - 1;
        }
      }
      lanes[lane] = null;
      const targets: number[] = [];
      for (let pi = 0; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        const at = lanes.indexOf(p);
        if (at >= 0) {
          targets.push(at);
        } else if (pi === 0) {
          lanes[lane] = p;
          targets.push(lane);
        } else {
          let free = lanes.indexOf(null);
          if (free < 0) {
            lanes.push(p);
            free = lanes.length - 1;
          } else {
            lanes[free] = p;
          }
          targets.push(free);
        }
      }
      rows.push({ c, lane, targets, lanesAfter: lanes.slice() });
    }
    return rows;
  }

  function laneX(lane: number): number {
    return PAD_X + lane * LANE_W + LANE_W / 2;
  }

  function renderGraph(rows: LayRow[]): HTMLElement {
    const wrap = el('div', 'git-graph');
    const nLanes = rows.reduce((m, r) => Math.max(m, r.lanesAfter.length), 1);
    const svgW = PAD_X * 2 + nLanes * LANE_W;
    const H = rows.length * ROW_H;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'git-lanes');
    svg.setAttribute('width', String(svgW));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${svgW} ${H}`);
    const NS = 'http://www.w3.org/2000/svg';

    rows.forEach((r, i) => {
      const yMid = i * ROW_H + ROW_H / 2;
      const yNext = (i + 1) * ROW_H + ROW_H / 2;
      // Lane columns continuing down through this row.
      r.lanesAfter.forEach((h, j) => {
        if (!h || i === rows.length - 1) return;
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', String(laneX(j)));
        ln.setAttribute('y1', String(yMid));
        ln.setAttribute('x2', String(laneX(j)));
        ln.setAttribute('y2', String(yNext));
        ln.setAttribute('class', `lane-${j % LANE_COLORS}`);
        svg.appendChild(ln);
      });
      // Curves from this commit's dot to off-lane parents (merges, joins).
      r.targets.forEach((t, pi) => {
        if (t === r.lane || !r.c.parents[pi]) return;
        const p = document.createElementNS(NS, 'path');
        const yBend = yMid + ROW_H / 2;
        p.setAttribute(
          'd',
          `M ${laneX(r.lane)} ${yMid} C ${laneX(r.lane)} ${yBend}, ${laneX(t)} ${yBend}, ${laneX(t)} ${yNext}`,
        );
        p.setAttribute('class', `lane-${t % LANE_COLORS}`);
        svg.appendChild(p);
      });
      // The commit dot (uncommitted = dashed ring).
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(laneX(r.lane)));
      dot.setAttribute('cy', String(yMid));
      dot.setAttribute('r', '4');
      dot.setAttribute('class', `lane-${r.lane % LANE_COLORS}${r.c.hash ? '' : ' git-dot-uncommitted'}`);
      svg.appendChild(dot);
    });
    wrap.appendChild(svg);

    const rowsEl = el('div', 'git-rows');
    for (const r of rows) {
      const row = el('div', 'git-row' + (r.c.hash === selected || (!r.c.hash && !selected) ? ' sel' : ''));
      row.style.paddingLeft = `${svgW + 6}px`;
      const subj = el('span', 'git-subject', r.c.subject);
      row.appendChild(subj);
      if (r.c.refs) {
        for (const ref of r.c.refs.split(', ')) {
          const cls = ref.startsWith('tag:')
            ? 'tag'
            : ref.includes('->')
              ? 'head'
              : ref.includes('/')
                ? 'remote'
                : 'branch';
          row.appendChild(el('span', `git-ref git-ref-${cls}`, ref.replace('tag: ', '')));
        }
      }
      row.appendChild(el('span', 'git-author', r.c.author));
      row.appendChild(el('span', 'git-date', r.c.hash ? fmtDate(r.c.date) : ''));
      row.addEventListener('click', () => {
        selected = r.c.hash;
        rowsEl.querySelectorAll('.git-row.sel').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        void renderDetail();
      });
      rowsEl.appendChild(row);
    }
    wrap.appendChild(rowsEl);
    return wrap;
  }

  // ---- detail column ---------------------------------------------------------
  const detailEl = el('div', 'git-detail');

  /** Minimal unified-diff renderer (the same classes the code panel styles). */
  function renderUnifiedDiff(diff: string): HTMLElement {
    const box = el('div', 'git-diff');
    let inHunks = false;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        box.appendChild(el('div', 'dl dmeta', line));
        inHunks = false;
      } else if (line.startsWith('@@')) {
        box.appendChild(el('div', 'dl dhunk', line));
        inHunks = true;
      } else if (line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index') || line.startsWith('rename ')) {
        box.appendChild(el('div', 'dl dmeta', line));
      } else {
        const cls = inHunks && line.startsWith('+') ? ' dadd' : inHunks && line.startsWith('-') ? ' ddel' : '';
        box.appendChild(el('div', `dl${cls}`, line));
      }
    }
    return box;
  }

  async function renderDetail() {
    const my = ++seq;
    if (!selected) {
      // The uncommitted card: working-tree + staged changes and their diffs.
      const files = uncommitted;
      detailEl.replaceChildren(
        el('div', 'git-detail-title', `Uncommitted Changes (${files.length})`),
        el(
          'div',
          'git-detail-hint',
          files.length ? 'click a file for its diff' : 'working tree clean',
        ),
      );
      const list = el('div', 'git-files');
      for (const f of files) {
        const row = el('div', 'git-file');
        row.appendChild(el('span', `gbadge g${f.status.includes('?') ? 'new' : f.status.includes('D') ? 'del' : 'mod'}`, f.status.trim() || 'M'));
        row.appendChild(el('span', 'git-file-path', f.path));
        row.addEventListener('click', async () => {
          const staged = !f.status.startsWith(' ') && f.status[0] !== '?' && !f.status.endsWith(' ');
          const diff = await getText(`/git/diff?${qs({ pane, path: f.path, staged })}`);
          detailEl.querySelector('.git-diff')?.remove();
          detailEl.appendChild(renderUnifiedDiff(diff ?? '(no diff)'));
        });
        list.appendChild(row);
      }
      detailEl.appendChild(list);
      return;
    }
    detailEl.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
    const d = await get<ShowResp>(`/git/show?${qs({ root, rev: selected })}`);
    if (my !== seq) return;
    if (!d) {
      detailEl.replaceChildren(el('div', 'git-detail-hint', 'could not load this commit'));
      return;
    }
    const title = el('div', 'git-detail-title');
    title.appendChild(el('span', 'git-hash', d.hash.slice(0, 8)));
    title.append(' ' + d.subject);
    detailEl.replaceChildren(
      title,
      el('div', 'git-detail-meta', `${d.author} · ${fmtDate(d.date)}`),
    );
    if (d.body.trim()) detailEl.appendChild(el('div', 'git-detail-body', d.body.trim()));
    const list = el('div', 'git-files');
    for (const f of d.files) {
      const row = el('div', 'git-file');
      row.appendChild(el('span', `gbadge g${f.status === 'A' ? 'new' : f.status === 'D' ? 'del' : 'mod'}`, f.status));
      row.appendChild(el('span', 'git-file-path', f.path));
      row.addEventListener('click', async () => {
        const fd = await get<ShowResp>(
          `/git/show?${qs({ root, rev: d.hash, path: f.path })}`,
        );
        detailEl.querySelector('.git-diff')?.remove();
        detailEl.appendChild(renderUnifiedDiff(fd?.diff ?? '(no diff)'));
      });
      list.appendChild(row);
    }
    detailEl.appendChild(list);
    detailEl.appendChild(renderUnifiedDiff(d.diff));
  }

  // ---- toolbar + load ----------------------------------------------------------
  function toolbar(): HTMLElement {
    const bar = el('div', 'git-toolbar');
    const repo = el('span', 'git-repo', root ?? '(no git repo)');
    bar.appendChild(repo);
    if (logData?.branch) {
      bar.appendChild(el('span', 'git-ref git-ref-head', logData.branch));
      if (logData.upstream) {
        const bits: string[] = [];
        if (logData.ahead) bits.push(`↑${logData.ahead}`);
        if (logData.behind) bits.push(`↓${logData.behind}`);
        bar.appendChild(el('span', 'git-upstream', `${logData.upstream} ${bits.join(' ')}`.trim()));
      }
    }
    const spacer = el('span', 'git-spacer');
    bar.appendChild(spacer);
    const allLab = el('label', 'git-allrefs');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = showAll;
    cb.addEventListener('change', () => {
      showAll = cb.checked;
      void load();
    });
    allLab.append(cb, document.createTextNode(' all refs'));
    bar.appendChild(allLab);
    const refresh = el('button', 'pkgs-btn', 'Refresh');
    refresh.addEventListener('click', () => void load());
    bar.appendChild(refresh);
    return bar;
  }

  async function load() {
    const my = ++seq;
    panel.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
    pane = opts.getActivePane();
    const top = await get<{ toplevel: string | null }>(`/git/toplevel?${qs({ pane })}`);
    root = top?.toplevel ?? null;
    if (!root) {
      panel.replaceChildren(
        toolbar(),
        el('div', 'git-detail-hint', 'the focused pane is not inside a git repository'),
      );
      return;
    }
    const [log, status] = await Promise.all([
      get<LogResp>(`/git/log?${qs({ root, all: showAll, limit: 400 })}`),
      get<StatusFile[]>(`/git/status?${qs({ root })}`),
    ]);
    if (my !== seq) return;
    logData = log;
    uncommitted = status ?? [];
    const commits = log?.commits ?? [];
    const rows: LayRow[] = layout([
      // The uncommitted card rides as a pseudo-commit parenting HEAD so its
      // lane flows into the real topology, exactly like the extension's.
      ...(uncommitted.length && commits.length
        ? [
            {
              hash: '',
              parents: [commits[0].hash],
              author: '',
              date: '',
              subject: `Uncommitted Changes (${uncommitted.length})`,
              refs: '',
            } satisfies LogCommit,
          ]
        : []),
      ...commits,
    ]);
    const main = el('div', 'git-main');
    main.appendChild(renderGraph(rows));
    main.appendChild(detailEl);
    panel.replaceChildren(toolbar(), main);
    await renderDetail();
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      panel.classList.toggle('show', open);
      if (open) {
        selected = '';
        void load();
      }
    },
  };
}
