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
  /** Conflict jump: open a file in the code panel's editor. */
  openInCode?: (root: string, path: string) => void;
}

export interface GitGraphPanel {
  toggle(): void;
  isOpen(): boolean;
  /** Open (if needed) with this commit selected — the blame gutter's jump-in. */
  show(hash: string): void;
  /** Open (if needed) showing ONE FILE's history (renames followed) — the
   * code panel's History button jump-in. */
  showFileHistory(root: string, path: string): void;
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
  branches: string[];
}
interface StatusFile {
  status: string;
  path: string;
  /** Gitlink (submodule boundary) — badged S. */
  submodule?: boolean;
}
interface StashEntry {
  sel: string;
  msg: string;
}
interface GitStateResp {
  state: string | null;
  conflicts: string[];
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
  /** '' = every ref, '~current' = HEAD only, else this branch's history. */
  let branchFilter = '';
  /** Free-text filter over the loaded commits (subject/author/hash/refs). */
  let filterText = '';
  /** Non-null = file-history mode: only commits touching this repo-relative
   * path (renames followed). Set by the code panel's History button. */
  let fileFilter: string | null = null;
  /** Repo root override for jump-ins (file history may come from another
   * pane's repo); cleared on every toggle-open. */
  let rootOverride: string | null = null;
  let selected = ''; // '' = uncommitted card; else commit hash; 'stash@{n}' = stash
  /** Compare mode: base set via a row's menu → highlighted; a second pick
   * turns it into an A..B view in the detail column. */
  let compareBase: string | null = null;
  let compareView: { a: string; b: string } | null = null;
  let uncommitted: StatusFile[] = [];
  let stashes: StashEntry[] = [];
  let gitState: GitStateResp = { state: null, conflicts: [] };
  let logData: LogResp | null = null;
  // History pagination: PAGE-sized fetches, more underneath via a scroll
  // sentinel. loadedAll = the server answered short (no older commits).
  const PAGE = 200;
  let loadedAll = false;
  let paging = false;

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
  interface WriteResp {
    ok: boolean;
    out: string;
  }
  let opBusy = false;
  /** One user-initiated git write (add/unstage/commit/fetch/pull/push/
   * rebase). Serialized, toasts the git output, reloads the graph on success. */
  async function op(path: string, body: Record<string, string | number | null>, okMsg: string) {
    if (opBusy) return;
    opBusy = true;
    try {
      const r = await fetch(`${opts.getApiBase()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane, root, ...body }),
      });
      const res = (await r.json().catch(() => ({ ok: false, out: 'bad response' }))) as WriteResp;
      opts.toast(res.out.split('\n').slice(0, 3).join(' · ') || (res.ok ? okMsg : 'failed'));
      if (res.ok) await load();
    } catch {
      opts.toast('operation failed (daemon unreachable)');
    }
    opBusy = false;
  }
  // ---- context menu (commit rows + branch badges) ---------------------------
  // One menu at a time, body-appended (escapes the panel's overflow). Outside
  // mousedown and Esc close it; Esc is capture+stopPropagation so the modal
  // stack keeps the PANEL open (VS Code behaviour: Esc closes the menu only).
  let menuEl: HTMLElement | null = null;
  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
  };
  interface MenuItem {
    label: string;
    danger?: boolean;
    /** Two-click confirm for destructive verbs: first click arms (this text),
     * second click runs. */
    confirm?: string;
    /** Renders as an inline input + submit row instead of a plain button
     * (branch/tag creation needs a name). */
    prompt?: { placeholder: string; apply: string; run: (name: string) => void };
    action: () => void;
  }
  function openMenu(x: number, y: number, items: MenuItem[]) {
    closeMenu();
    const m = el('div', 'git-menu');
    for (const it of items) {
      if (it.prompt) {
        const row = el('div', 'git-menu-prompt');
        const inp = document.createElement('input');
        inp.className = 'git-menu-input';
        inp.placeholder = it.prompt.placeholder;
        const go = el('button', 'git-menu-go', it.prompt.apply);
        const submit = () => {
          const name = inp.value.trim();
          if (!name) return;
          closeMenu();
          it.prompt!.run(name);
        };
        go.addEventListener('click', (e) => {
          e.stopPropagation();
          submit();
        });
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
        });
        row.append(inp, go);
        m.appendChild(row);
        continue;
      }
      const b = el('button', 'git-menu-item' + (it.danger ? ' danger' : ''), it.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (it.confirm && b.dataset.armed !== '1') {
          b.dataset.armed = '1';
          b.textContent = it.confirm;
          return;
        }
        closeMenu();
        it.action();
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
    m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
    menuEl = m;
  }
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });
  // WINDOW capture, not document: main.ts's modal-stack keydown is a document
  // bubble listener, and document-level capture loses to it by registration
  // order whenever the event target IS document. Window is higher in the
  // capture path, so this always runs first and the Esc is eaten here.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && menuEl) {
        e.stopPropagation();
        closeMenu();
      }
    },
    true,
  );
  /** Prompt row: create a branch at `at` (null = HEAD). */
  const branchPrompt = (at: string | null): MenuItem => ({
    label: '',
    prompt: {
      placeholder: at ? `new branch @ ${at.slice(0, 8)}…` : 'new branch name…',
      apply: 'Create',
      run: (name) => void op('/git/branch', { rev: name, at }, `created branch ${name}`),
    },
    action: () => {},
  });
  /** Prompt row: create a lightweight tag at `at` (null = HEAD). */
  const tagPrompt = (at: string | null): MenuItem => ({
    label: '',
    prompt: {
      placeholder: at ? `new tag @ ${at.slice(0, 8)}…` : 'new tag name…',
      apply: 'Create',
      run: (name) => void op('/git/tag', { rev: name, at }, `tagged ${name}`),
    },
    action: () => {},
  });
  /** The right-click menu for one branch (or "HEAD -> x") badge. */
  function branchMenu(x: number, y: number, branch: string, isHead: boolean) {
    openMenu(x, y, [
      {
        label: `Check out ${branch}`,
        action: () => void op('/git/checkout', { rev: branch }, `on ${branch}`),
      },
      {
        label: `Merge ${branch} into current`,
        action: () => void op('/git/merge', { rev: branch }, 'merged'),
      },
      branchPrompt(null),
      tagPrompt(null),
      ...(isHead
        ? []
        : ([
            {
              label: `Delete ${branch}`,
              danger: true,
              confirm: `delete branch ${branch}? click again`,
              action: () => void op('/git/branch/delete', { rev: branch }, 'deleted'),
            },
          ] as MenuItem[])),
    ]);
  }
  /** The right-click menu for one tag badge. */
  function tagMenu(x: number, y: number, tagName: string) {
    openMenu(x, y, [
      {
        label: `Check out (detach at ${tagName})`,
        action: () => void op('/git/checkout', { rev: tagName }, `detached at ${tagName}`),
      },
      tagPrompt(null),
      {
        label: `Delete tag ${tagName}`,
        danger: true,
        confirm: `delete tag ${tagName}? click again`,
        action: () => void op('/git/tag/delete', { rev: tagName }, 'tag deleted'),
      },
    ]);
  }
  /** The right-click menu for one commit row. */
  function commitMenu(x: number, y: number, hash: string, subject: string) {
    openMenu(x, y, [
      {
        label: 'Cherry-pick onto HEAD',
        action: () => void op('/git/cherry-pick', { rev: hash }, 'cherry-picked'),
      },
      {
        label: 'Revert this commit',
        action: () => void op('/git/revert', { rev: hash }, 'reverted'),
      },
      {
        label: 'Copy hash',
        action: () => {
          void navigator.clipboard.writeText(hash).then(
            () => opts.toast(`copied ${hash.slice(0, 8)}`),
            () => opts.toast('clipboard write failed'),
          );
        },
      },
      {
        label: 'Check out (detach HEAD)',
        action: () => void op('/git/checkout', { rev: hash }, `detached at ${hash.slice(0, 8)}`),
      },
      {
        label:
          compareBase === hash
            ? 'Clear compare base'
            : compareBase
              ? `Compare with ${compareBase.slice(0, 8)}`
              : 'Mark as compare base',
        action: () => {
          if (compareBase === hash) {
            compareBase = null;
            softReload();
            return;
          }
          if (!compareBase) {
            compareBase = hash;
            opts.toast(`compare base @ ${hash.slice(0, 8)} — right-click another commit to compare`);
            softReload();
            return;
          }
          compareView = { a: compareBase, b: hash };
          compareBase = null;
          softReload();
        },
      },
      branchPrompt(hash),
      tagPrompt(hash),
      {
        label: 'Reset --soft here',
        action: () => void op('/git/reset', { rev: hash, mode: 'soft' }, 'reset --soft'),
      },
      {
        label: 'Reset --mixed here',
        action: () => void op('/git/reset', { rev: hash, mode: 'mixed' }, 'reset --mixed'),
      },
      {
        label: 'Reset --hard here',
        danger: true,
        confirm: `discard ALL changes back to “${subject.slice(0, 40)}”? click again`,
        action: () => void op('/git/reset', { rev: hash, mode: 'hard' }, 'reset --hard'),
      },
    ]);
  }
  /** The right-click menu for one stash row. */
  function stashMenu(x: number, y: number, stashSel: string) {
    openMenu(x, y, [
      {
        label: 'Apply (keep entry)',
        action: () => void op('/git/stash/apply', { rev: stashSel }, 'applied'),
      },
      {
        label: 'Pop (apply + drop)',
        action: () => void op('/git/stash/pop', { rev: stashSel }, 'popped'),
      },
      {
        label: 'Drop this stash',
        danger: true,
        confirm: `drop ${stashSel} for good? click again`,
        action: () => void op('/git/stash/drop', { rev: stashSel }, 'dropped'),
      },
    ]);
  }
  const isStashRow = (hash: string) => hash.startsWith('stash@{');
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
      const row = el(
        'div',
        'git-row' +
          (r.c.hash === selected || (!r.c.hash && !selected) ? ' sel' : '') +
          (r.c.hash === compareBase ? ' compare-base' : ''),
      );
      row.style.paddingLeft = `${svgW + 6}px`;
      const subj = el('span', 'git-subject', r.c.subject);
      row.appendChild(subj);
      if (isStashRow(r.c.hash)) {
        row.appendChild(el('span', 'git-ref git-ref-stash', r.c.hash));
      }
      if (r.c.refs) {
        for (const ref of r.c.refs.split(', ')) {
          const cls = ref.startsWith('tag:')
            ? 'tag'
            : ref.includes('->')
              ? 'head'
              : ref.includes('/')
                ? 'remote'
                : 'branch';
          const badge = el('span', `git-ref git-ref-${cls}`, ref.replace('tag: ', ''));
          // Local branches (incl. the "HEAD -> x" pair) and tags carry action
          // menus; remote badges stay passive.
          if (cls === 'branch' || cls === 'head') {
            const branch = ref.includes('->') ? ref.split('->')[1].trim() : ref;
            badge.title = 'right-click for branch actions';
            badge.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              branchMenu(e.clientX, e.clientY, branch, cls === 'head');
            });
          } else if (cls === 'tag') {
            badge.title = 'right-click for tag actions';
            badge.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              tagMenu(e.clientX, e.clientY, ref.replace('tag: ', ''));
            });
          }
          row.appendChild(badge);
        }
      }
      row.appendChild(el('span', 'git-author', r.c.author));
      row.appendChild(el('span', 'git-date', r.c.hash ? fmtDate(r.c.date) : ''));
      row.addEventListener('click', () => {
        compareView = null; // any row click leaves compare mode
        selected = r.c.hash;
        rowsEl.querySelectorAll('.git-row.sel').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        void renderDetail();
      });
      // Real commits get the op menu, stashes the stash menu; the
      // uncommitted pseudo-row gets neither.
      if (r.c.hash && isStashRow(r.c.hash)) {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          stashMenu(e.clientX, e.clientY, r.c.hash);
        });
      } else if (r.c.hash) {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          commitMenu(e.clientX, e.clientY, r.c.hash, r.c.subject);
        });
      }
      rowsEl.appendChild(row);
    }
    wrap.appendChild(rowsEl);
    if (!loadedAll) {
      wrap.appendChild(el('div', 'git-more', paging ? 'loading older commits…' : '· scroll for older commits ·'));
    }
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
    /** Files (click → per-file diff) + whole-revision diff, shared by the
     * commit, compare, and stash details. */
    const appendFilesAndDiff = (d: ShowResp, perFile: (path: string) => Promise<ShowResp | null>) => {
      const list = el('div', 'git-files');
      for (const f of d.files) {
        const row = el('div', 'git-file');
        row.appendChild(el('span', `gbadge g${f.status === 'A' ? 'new' : f.status === 'D' ? 'del' : 'mod'}`, f.status));
        row.appendChild(el('span', 'git-file-path', f.path));
        row.addEventListener('click', async () => {
          const fd = await perFile(f.path);
          detailEl.querySelector('.git-diff')?.remove();
          detailEl.appendChild(renderUnifiedDiff(fd?.diff ?? '(no diff)'));
        });
        list.appendChild(row);
      }
      detailEl.appendChild(list);
      detailEl.appendChild(renderUnifiedDiff(d.diff));
    };
    // Compare mode: A..B between two right-click-marked commits.
    if (compareView) {
      const { a, b } = compareView;
      detailEl.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
      const d = await get<ShowResp>(`/git/compare?${qs({ root, rev: a, rev2: b })}`);
      if (my !== seq) return;
      if (!d) {
        compareView = null;
        detailEl.replaceChildren(el('div', 'git-detail-hint', 'could not compare these commits'));
        return;
      }
      detailEl.replaceChildren(
        el('div', 'git-detail-title', `⇄ ${a.slice(0, 8)}..${b.slice(0, 8)}`),
        el('div', 'git-detail-meta', `${d.files?.length ?? 0} file(s) changed · click a row to leave compare`),
      );
      appendFilesAndDiff(d, (p) => get<ShowResp>(`/git/compare?${qs({ root, rev: a, rev2: b, path: p })}`));
      return;
    }
    if (isStashRow(selected)) {
      // Stash detail: the entry's summary, apply/pop/drop actions, its diff.
      detailEl.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
      const d = await get<ShowResp>(`/git/show?${qs({ root, rev: selected })}`);
      if (my !== seq) return;
      const entry = stashes.find((s) => s.sel === selected);
      if (!d) {
        detailEl.replaceChildren(el('div', 'git-detail-hint', 'could not load this stash'));
        return;
      }
      detailEl.replaceChildren(
        el('div', 'git-detail-title', entry?.msg ?? selected),
        el('div', 'git-detail-meta', `${selected} · ${d.author} · ${fmtDate(d.date)}`),
      );
      const actions = el('div', 'git-bulk');
      const ap = el('button', 'pkgs-btn', 'Apply');
      ap.title = 'apply, keep the entry';
      ap.addEventListener('click', () => void op('/git/stash/apply', { rev: selected }, 'applied'));
      const pp = el('button', 'pkgs-btn', 'Pop');
      pp.title = 'apply and drop';
      pp.addEventListener('click', () => void op('/git/stash/pop', { rev: selected }, 'popped'));
      const dr = el('button', 'pkgs-btn git-danger', 'Drop');
      dr.title = 'delete the entry (two clicks)';
      dr.addEventListener('click', () => {
        if (dr.dataset.armed !== '1') {
          dr.dataset.armed = '1';
          dr.textContent = 'Drop for good? click again';
          return;
        }
        void op('/git/stash/drop', { rev: selected }, 'dropped');
      });
      actions.append(ap, pp, dr);
      detailEl.appendChild(actions);
      appendFilesAndDiff(d, (p) => get<ShowResp>(`/git/show?${qs({ root, rev: selected, path: p })}`));
      return;
    }
    if (!selected) {
      // The uncommitted card: stage/unstage per file, stage-all, commit box.
      const files = uncommitted;
      detailEl.replaceChildren(
        el('div', 'git-detail-title', `Uncommitted Changes (${files.length})`),
        el(
          'div',
          'git-detail-hint',
          files.length ? 'click a file for its diff · + stage / − unstage' : 'working tree clean',
        ),
      );
      // Conflict banner: the in-progress sequencer and its driver. Conflicted
      // rows below open in the editor instead of showing a useless diff.
      if (gitState.state || gitState.conflicts.length) {
        const label = gitState.state ? `${gitState.state} in progress` : 'conflicts present';
        const banner = el('div', 'git-conflict-banner');
        banner.appendChild(
          el('span', 'git-conflict-title', `⚡ ${label} · ${gitState.conflicts.length} conflicted file(s)`),
        );
        const btns = el('span', 'git-conflict-actions');
        const cont = el('button', 'pkgs-btn primary', 'Continue');
        cont.title = `git ${gitState.state ?? 'merge'} --continue`;
        cont.addEventListener('click', () => void op('/git/op', { action: 'continue' }, 'continued'));
        const ab = el('button', 'pkgs-btn git-danger', 'Abort');
        ab.title = 'click twice to confirm';
        ab.addEventListener('click', () => {
          if (ab.dataset.armed !== '1') {
            ab.dataset.armed = '1';
            ab.textContent = `Abort the ${gitState.state}? click again`;
            return;
          }
          void op('/git/op', { action: 'abort' }, 'aborted');
        });
        btns.append(cont, ab);
        banner.appendChild(btns);
        detailEl.appendChild(banner);
      }
      if (files.length) {
        const bulk = el('div', 'git-bulk');
        const sa = el('button', 'pkgs-btn', 'Stage all');
        sa.addEventListener('click', () => void op('/git/add', {}, 'staged all'));
        const ua = el('button', 'pkgs-btn', 'Unstage all');
        ua.addEventListener('click', () => void op('/git/unstage', {}, 'unstaged all'));
        bulk.append(sa, ua);
        detailEl.appendChild(bulk);
      }
      const list = el('div', 'git-files');
      for (const f of files) {
        const untracked = f.status.includes('?');
        const staged = !untracked && f.status[0] !== ' ';
        const unstaged = untracked || f.status[1] !== ' ';
        const row = el('div', 'git-file');
        const stageBtn = el(
          'button',
          'git-stage-btn' + (staged ? ' staged' : ''),
          unstaged ? '+' : '−',
        );
        stageBtn.title = unstaged ? 'stage this file' : 'unstage this file';
        stageBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void op(unstaged ? '/git/add' : '/git/unstage', { path: f.path }, unstaged ? 'staged' : 'unstaged');
        });
        row.appendChild(stageBtn);
        // Discard ALL of this file's changes — two-click armed.
        const dbtn = el('button', 'git-discard-btn', '✕');
        dbtn.title = 'discard changes (two clicks)';
        dbtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (dbtn.dataset.armed !== '1') {
            dbtn.dataset.armed = '1';
            dbtn.title = `discard ${f.path}? click again`;
            return;
          }
          void op('/git/discard', { path: f.path }, 'discarded');
        });
        row.appendChild(dbtn);
        if (f.submodule) {
          const sb = el('span', 'gbadge gsub', 'S');
          sb.title = 'submodule — view the gitlink diff here; enter it from the code panel';
          row.appendChild(sb);
        } else {
          row.appendChild(el('span', `gbadge g${untracked ? 'new' : f.status.includes('D') ? 'del' : 'mod'}`, f.status.trim() || 'M'));
        }
        row.appendChild(el('span', 'git-file-path', f.path));
        row.addEventListener('click', async () => {
          // Conflicted file: resolving it beats staring at a marker-pocked
          // diff — jump into the code panel's editor (accept widgets there).
          if (gitState.conflicts.includes(f.path) && opts.openInCode && root) {
            opts.openInCode(root, f.path);
            return;
          }
          const forStaged = staged && !unstaged;
          const diff = await getText(`/git/diff?${qs({ pane, path: f.path, staged: forStaged })}`);
          detailEl.querySelector('.git-diff')?.remove();
          detailEl.appendChild(renderUnifiedDiff(diff ?? '(no diff)'));
        });
        if (gitState.conflicts.includes(f.path)) {
          row.classList.add('git-file-conflict');
          row.title = 'conflict — click to resolve in the editor';
        }
        list.appendChild(row);
      }
      detailEl.appendChild(list);
      // Commit box: commits the staged set; stages everything first when the
      // index is empty (VS Code's smart-commit behaviour, toasted).
      const crow = el('div', 'git-commit-row');
      const msg = document.createElement('input');
      msg.className = 'git-commit-input';
      msg.placeholder = 'Commit message (Enter to commit)';
      const cbtn = el('button', 'pkgs-btn primary', 'Commit');
      const doCommit = () => {
        const message = msg.value.trim();
        if (!message) return;
        const stagedAny = uncommitted.some((f) => !f.status.includes('?') && f.status[0] !== ' ');
        void (async () => {
          if (!stagedAny) {
            opts.toast('nothing staged — staging all first');
            await op('/git/add', {}, 'staged all');
          }
          await op('/git/commit', { message }, 'committed');
          msg.value = '';
        })();
      };
      cbtn.addEventListener('click', doCommit);
      msg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCommit();
        e.stopPropagation();
      });
      crow.append(msg, cbtn);
      // Amend HEAD: folds the staged set into the tip commit (--no-edit).
      // Rewrites history → two-click armed, only offered with a HEAD at all.
      if (logData?.commits.length) {
        const abtn = el('button', 'pkgs-btn git-danger', 'Amend');
        abtn.title = 'amend HEAD with the staged set (--no-edit; two clicks)';
        abtn.addEventListener('click', () => {
          if (abtn.dataset.armed !== '1') {
            abtn.dataset.armed = '1';
            abtn.textContent = 'rewrite HEAD? click again';
            return;
          }
          const stagedAny = uncommitted.some((f) => !f.status.includes('?') && f.status[0] !== ' ');
          void (async () => {
            if (!stagedAny) {
              opts.toast('nothing staged — nothing to amend with');
              abtn.dataset.armed = '';
              abtn.textContent = 'Amend';
              return;
            }
            await op('/git/amend', {}, 'amended HEAD');
          })();
        });
        crow.appendChild(abtn);
      }
      detailEl.appendChild(crow);
      return;
    }
    detailEl.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
    const d = await get<ShowResp>(`/git/show?${qs({ root, rev: selected, path: fileFilter ?? undefined })}`);
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
    appendFilesAndDiff(d, (p) => get<ShowResp>(`/git/show?${qs({ root, rev: d.hash, path: p })}`));
  }

  // ---- toolbar + load ----------------------------------------------------------
  function toolbar(): HTMLElement {
    const bar = el('div', 'git-toolbar');
    const repo = el('span', 'git-repo', root ?? '(no git repo)');
    bar.appendChild(repo);
    if (fileFilter) {
      // File-history mode badge; ✕ clears back to the full graph.
      const chip = el('span', 'git-filefilter', `history: ${fileFilter.split('/').pop()}`);
      chip.title = fileFilter;
      const x = el('button', 'git-chip-x', '✕');
      x.title = 'clear the file history filter';
      x.addEventListener('click', () => {
        fileFilter = null;
        void load();
      });
      chip.appendChild(x);
      bar.appendChild(chip);
    }
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
    for (const [label, path, okMsg] of [
      ['Fetch', '/git/fetch', 'fetched'],
      ['Pull', '/git/pull', 'pulled'],
      ['Push', '/git/push', 'pushed'],
      ['Rebase', '/git/rebase', 'rebased'],
      ['Stash', '/git/stash', 'stashed'],
    ] as const) {
      const b = el('button', 'pkgs-btn', label);
      b.addEventListener('click', () => void op(path, {}, okMsg));
      bar.appendChild(b);
    }
    // Branch filter: all / current / one branch's own history.
    const sel = document.createElement('select');
    sel.className = 'git-branch';
    sel.title = 'which history to show';
    const mkOpt = (v: string, label: string) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    };
    mkOpt('', 'all branches');
    mkOpt('~current', `current (${logData?.branch ?? '—'})`);
    for (const b of logData?.branches ?? []) mkOpt(b, `⎇ ${b}`);
    sel.value = branchFilter;
    sel.addEventListener('change', () => {
      branchFilter = sel.value;
      void load();
    });
    bar.appendChild(sel);
    // Free-text filter: local, soft-reloads only the graph (this toolbar —
    // and its focus — stays put).
    const search = document.createElement('input');
    search.className = 'git-search';
    search.placeholder = 'filter commits…';
    search.value = filterText;
    search.addEventListener('input', () => {
      filterText = search.value;
      softReload();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    bar.appendChild(search);
    const refresh = el('button', 'pkgs-btn', 'Refresh');
    refresh.addEventListener('click', () => void load());
    bar.appendChild(refresh);
    return bar;
  }

  /** All fetched commits, then the search-filtered subset. Topology
   * metadata (pseudo-row parents) always comes from the FULL set. */
  function visibleCommits(): LogCommit[] {
    const all = logData?.commits ?? [];
    if (!filterText) return all;
    const q = filterText.toLowerCase();
    return all.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.hash.startsWith(q) ||
        c.refs.toLowerCase().includes(q),
    );
  }

  function buildRows(): LayRow[] {
    const all = logData?.commits ?? [];
    const head = all[0]?.hash;
    return layout([
      // The uncommitted card rides as a pseudo-commit parenting HEAD so its
      // lane flows into the real topology, exactly like the extension's.
      ...(uncommitted.length && head
        ? [
            {
              hash: '',
              parents: [head],
              author: '',
              date: '',
              subject: `Uncommitted Changes (${uncommitted.length})`,
              refs: '',
            } satisfies LogCommit,
          ]
        : []),
      // Stashes too: one pseudo-row each, also parenting HEAD (their real
      // first parent is whatever HEAD was at stash time — noisy noise).
      ...(head
        ? stashes.map(
            (s): LogCommit => ({
              hash: s.sel,
              parents: [head],
              author: '',
              date: '',
              subject: s.msg,
              refs: '',
            }),
          )
        : []),
      ...visibleCommits(),
    ]);
  }

  /** The bottom sentinel: when it scrolls into view, pull the next page.
   * Auto-chains while the viewport isn't full yet. */
  function attachPager(main: HTMLElement) {
    const foot = main.querySelector('.git-more');
    const graphEl = main.querySelector('.git-graph');
    if (!foot || !graphEl) return;
    new IntersectionObserver(
      (entries, obs) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          void loadMore();
        }
      },
      { root: graphEl },
    ).observe(foot);
  }

  /** The branch/filter params shared by load() and loadMore() — they must
   * page through the SAME view. */
  function logParams(skip: number): Record<string, string | number | boolean> {
    const p: Record<string, string | number | boolean> = { root: root ?? '', limit: PAGE, skip };
    if (fileFilter) p.path = fileFilter;
    if (branchFilter === '') p.all = true;
    else if (branchFilter === '~current') p.all = false;
    else p.rev = branchFilter;
    return p;
  }

  /** Fetch the next PAGE of commits under the SAME branch filter and merge
   * (hash-deduped) — keeps the user's scroll position and selection. */
  async function loadMore() {
    if (paging || loadedAll) return;
    paging = true;
    const my = seq;
    const more = await get<LogResp>(`/git/log?${qs(logParams(logData?.commits.length ?? 0))}`);
    paging = false;
    if (my !== seq) return; // a full reload happened under us
    const fresh = more?.commits ?? [];
    if (!more || fresh.length < PAGE) loadedAll = true;
    if (fresh.length && logData) {
      const seen = new Set(logData.commits.map((c) => c.hash));
      logData.commits = [...logData.commits, ...fresh.filter((c) => !seen.has(c.hash))];
      softReload(true);
    } else if (loadedAll) {
      softReload(true); // drop the sentinel
    }
  }

  /** Rebuild just the graph side (search typing / paging): the toolbar and
   * its focus stay put; selection survives (guarded on load). */
  function softReload(preserveScroll = false) {
    const oldGraph = panel.querySelector('.git-graph');
    const st = preserveScroll ? (oldGraph?.scrollTop ?? 0) : 0;
    const main = el('div', 'git-main');
    main.appendChild(renderGraph(buildRows()));
    main.appendChild(detailEl);
    panel.querySelector('.git-main')?.replaceWith(main);
    if (preserveScroll) {
      const g = panel.querySelector('.git-graph');
      if (g) g.scrollTop = st;
    }
    attachPager(main);
    void renderDetail();
  }

  async function load() {
    const my = ++seq;
    closeMenu();
    panel.replaceChildren(el('div', 'git-detail-hint', 'loading…'));
    pane = opts.getActivePane();
    const top = rootOverride
      ? { toplevel: rootOverride }
      : await get<{ toplevel: string | null }>(`/git/toplevel?${qs({ pane })}`);
    root = top?.toplevel ?? null;
    if (!root) {
      panel.replaceChildren(
        toolbar(),
        el('div', 'git-detail-hint', 'the focused pane is not inside a git repository'),
      );
      return;
    }
    const [log, status, stashList, st] = await Promise.all([
      get<LogResp>(`/git/log?${qs(logParams(0))}`),
      get<StatusFile[]>(`/git/status?${qs({ root })}`),
      get<StashEntry[]>(`/git/stash/list?${qs({ root })}`),
      get<GitStateResp>(`/git/state?${qs({ root })}`),
    ]);
    if (my !== seq) return;
    logData = log;
    uncommitted = status ?? [];
    stashes = stashList ?? [];
    gitState = st ?? { state: null, conflicts: [] };
    const commits = log?.commits ?? [];
    loadedAll = !log || commits.length < PAGE;
    // A selected row may vanish under us (popped stash, reset-away commit).
    if (
      selected &&
      !commits.some((c) => c.hash === selected) &&
      !stashes.some((s) => s.sel === selected)
    ) {
      selected = '';
    }
    const main = el('div', 'git-main');
    main.appendChild(renderGraph(buildRows()));
    main.appendChild(detailEl);
    panel.replaceChildren(toolbar(), main);
    attachPager(main);
    await renderDetail();
  }

  return {
    isOpen: () => open,
    toggle() {
      open = !open;
      closeMenu();
      panel.classList.toggle('show', open);
      if (open) {
        selected = '';
        rootOverride = null;
        fileFilter = null;
        void load();
      }
    },
    show(hash: string) {
      selected = hash;
      if (!open) {
        open = true;
        panel.classList.add('show');
      }
      void load();
    },
    showFileHistory(gr: string, path: string) {
      rootOverride = gr;
      fileFilter = path;
      selected = '';
      if (!open) {
        open = true;
        panel.classList.add('show');
      }
      void load();
    },
  };
}
