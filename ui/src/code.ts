import { EditorView, basicSetup } from 'codemirror';
import { MergeView } from '@codemirror/merge';
import { EditorState, Compartment, StateField, type Extension, type Text, type Range } from '@codemirror/state';
import {
  keymap,
  lineNumbers,
  gutter,
  GutterMarker,
  ViewPlugin,
  ViewUpdate,
  Decoration,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import { getPrefs } from './prefs';
import { cmThemeSlot, cmThemeFor, presetById, rethemeState } from './theme';
import { rust } from '@codemirror/lang-rust';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { cpp } from '@codemirror/lang-cpp';
import { yaml } from '@codemirror/lang-yaml';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { StreamLanguage } from '@codemirror/language';
import { go } from '@codemirror/legacy-modes/mode/go';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { lspExtensionFor, notifySaved, setLspFileOpener, requestCodeActions } from './lsp';
import { makeCtx, viewerFor } from './viewers';

// Resolved per call so the panel follows the active workspace's daemon.
let apiBase = () => 'http://127.0.0.1:8088';

// Make the editor fill its (bounded) parent AND scroll on wheel/trackpad — this
// has to be a CodeMirror theme, not just CSS, or the scroller never enables.
const editorTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
});

interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
}
interface GitFile {
  status: string;
  path: string;
  /** Gitlink (submodule boundary): click enters it, never file-diffs it. */
  submodule?: boolean;
}

const paneQ = (pane: number | null) => (pane != null ? `pane=${pane}&` : '');

const rootQ = (root: string | null) => (root ? `root=${encodeURIComponent(root)}&` : '');

async function fsList(
  pane: number | null,
  path: string,
  root: string | null = null,
): Promise<FsEntry[]> {
  const r = await fetch(
    `${apiBase()}/fs/list?${paneQ(pane)}${rootQ(root)}path=${encodeURIComponent(path)}`,
  );
  return r.ok ? r.json() : [];
}
async function fsRead(pane: number | null, path: string, root: string | null = null): Promise<string> {
  const r = await fetch(`${apiBase()}/fs/read?${paneQ(pane)}${rootQ(root)}path=${encodeURIComponent(path)}`);
  if (!r.ok) {
    const err = new Error(`read ${path}: ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.text();
}
async function fsWrite(
  pane: number | null,
  path: string,
  content: string,
  root: string | null = null,
): Promise<boolean> {
  const r = await fetch(`${apiBase()}/fs/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, pane: pane ?? undefined, root: root ?? undefined }),
  });
  return r.ok;
}
async function gitStatus(pane: number | null, root: string | null = null): Promise<GitFile[]> {
  const r = await fetch(`${apiBase()}/git/status?${paneQ(pane)}${rootQ(root)}`);
  return r.ok ? r.json() : [];
}
async function gitDiff(pane: number | null, path: string, staged = false, root: string | null = null): Promise<string> {
  const r = await fetch(
    `${apiBase()}/git/diff?${paneQ(pane)}${rootQ(root)}path=${encodeURIComponent(path)}${staged ? '&staged=true' : ''}`,
  );
  return r.ok ? r.text() : '';
}
async function gitFiles(pane: number | null, root: string | null = null): Promise<string[]> {
  const r = await fetch(`${apiBase()}/git/files?${paneQ(pane)}${rootQ(root)}`);
  return r.ok ? r.json() : [];
}
/** The repo root containing the effective root, or null outside a work tree. */
async function gitToplevel(pane: number | null, root: string | null = null): Promise<string | null> {
  const r = await fetch(`${apiBase()}/git/toplevel?${paneQ(pane)}${rootQ(root)}`);
  if (!r.ok) return null;
  const j = (await r.json()) as { toplevel?: string | null };
  return j.toplevel ?? null;
}
/** The file's HEAD blob (staged=true → its index blob); null when absent. */
async function gitBlob(
  pane: number | null,
  path: string,
  staged: boolean,
  root: string | null = null,
): Promise<string | null> {
  const r = await fetch(
    `${apiBase()}/git/blob?${paneQ(pane)}${rootQ(root)}path=${encodeURIComponent(path)}${staged ? '&staged=true' : ''}`,
  );
  return r.ok ? r.text() : null;
}

// ---- blame gutter ------------------------------------------------------------

interface BlameGroup {
  /** 1-based first covered line. */
  line: number;
  count: number;
  hash: string;
  author: string;
  time: number; // author-time epoch seconds
  summary: string;
}

/** Blame view lives in a Compartment so toggling never rebuilds the buffer's
 * state (undo history survives); the snapshot in Buffer.state carries it. */
const blameSlot = new Compartment();

const relDate = (t: number) => {
  const sec = Math.max(1, Date.now() / 1000 - t);
  const day = sec / 86_400;
  if (day >= 365) return `${Math.floor(day / 365)}y ago`;
  if (day >= 30) return `${Math.floor(day / 30)}mo ago`;
  if (day >= 1) return `${Math.floor(day)}d ago`;
  const hr = sec / 3600;
  if (hr >= 1) return `${Math.floor(hr)}h ago`;
  return `${Math.max(1, Math.floor(sec / 60))}m ago`;
};
const fullDate = (t: number) => {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Heat coloring: newest commit in THIS file's blame → warm accent, oldest →
 * text-dim. Returns a color-mix string for the marker's inline style. */
function heatColor(groups: BlameGroup[], t: number): string {
  let lo = Infinity;
  let hi = 0;
  for (const g of groups) {
    if (g.time < lo) lo = g.time;
    if (g.time > hi) hi = g.time;
  }
  const span = hi - lo;
  const f = span <= 0 ? 1 : (t - lo) / span; // 0 = oldest, 1 = newest
  return `color-mix(in srgb, #e8b04c ${Math.round(20 + f * 80)}%, var(--text-dim))`;
}

// Hover detail card — single instance, body-appended (escapes the gutters),
// stays alive while the pointer is on it (its link is the same jump as the
// marker click).
let blameCard: HTMLElement | null = null;
let blameCardTimer = 0;
function hideBlameCard(delay = 220) {
  window.clearTimeout(blameCardTimer);
  blameCardTimer = window.setTimeout(() => {
    blameCard?.remove();
    blameCard = null;
  }, delay);
}
function showBlameCard(anchor: HTMLElement, g: BlameGroup, onOpen: ((h: string) => void) | null) {
  window.clearTimeout(blameCardTimer);
  blameCard?.remove();
  const c = document.createElement('div');
  c.className = 'cm-blame-card';
  const head = document.createElement('div');
  head.className = 'cm-blame-card-head';
  head.textContent = `${g.hash.slice(0, 10)}  ${g.summary}`;
  const meta = document.createElement('div');
  meta.className = 'cm-blame-card-meta';
  meta.textContent = `${g.author} · ${fullDate(g.time)} (${relDate(g.time)}) · ${g.count} line(s)`;
  c.append(head, meta);
  if (onOpen && !g.hash.startsWith('0000000')) {
    const link = document.createElement('button');
    link.className = 'cm-blame-card-open';
    link.textContent = 'open in the git graph →';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      hideBlameCard(0);
      onOpen(g.hash);
    });
    c.appendChild(link);
  }
  c.addEventListener('mouseenter', () => window.clearTimeout(blameCardTimer));
  c.addEventListener('mouseleave', () => hideBlameCard());
  document.body.appendChild(c);
  const r = anchor.getBoundingClientRect();
  c.style.left = `${Math.min(r.right + 8, innerWidth - c.offsetWidth - 12)}px`;
  c.style.top = `${Math.max(8, Math.min(r.top, innerHeight - c.offsetHeight - 12))}px`;
  blameCard = c;
}

/** One annotation per contiguous same-commit run, Git-Lens-gutter style;
 * heat-colored by age, hover card for details, click jumps to the graph. */
class BlameMarker extends GutterMarker {
  readonly color: string;
  constructor(
    readonly g: BlameGroup,
    readonly onOpen: ((h: string) => void) | null,
    color: string,
  ) {
    super();
    this.color = color;
  }
  override eq(other: BlameMarker): boolean {
    return other.g === this.g && other.color === this.color;
  }
  override toDOM(): Node {
    const d = document.createElement('div');
    d.className = 'cm-blame';
    d.style.color = this.color;
    const g = this.g;
    if (g.hash.startsWith('0000000')) {
      d.classList.add('wip');
      d.textContent = 'uncommitted';
      return d;
    }
    d.classList.add('link');
    d.textContent = `${g.author} · ${relDate(g.time)}`;
    if (this.onOpen) {
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onOpen!(g.hash);
      });
    }
    d.addEventListener('mouseenter', () => showBlameCard(d, g, this.onOpen));
    d.addEventListener('mouseleave', () => hideBlameCard());
    return d;
  }
}

/** Ghost text at the end of the CURSOR's line ("author · date"), like Git
 * Lens's current-line annotation. */
class GhostBlame extends WidgetType {
  constructor(readonly g: BlameGroup) {
    super();
  }
  override eq(other: GhostBlame): boolean {
    return other.g === this.g;
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-blame-ghost';
    s.textContent = `  ${this.g.author} · ${this.g.summary} · ${relDate(this.g.time)}`;
    return s;
  }
}

function currentLineBlame(groups: BlameGroup[]): Extension {
  const byLine = new Map<number, BlameGroup>();
  for (const g of groups) for (let i = 0; i < g.count; i++) byLine.set(g.line + i, g);
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const g = byLine.get(line.number);
        if (!g) return Decoration.none;
        return Decoration.set([Decoration.widget({ widget: new GhostBlame(g), side: 1 }).range(line.to)]);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function blameGutter(groups: BlameGroup[], onOpen: (h: string) => void): Extension {
  const starts = new Map<number, BlameGroup>();
  for (const g of groups) starts.set(g.line, g);
  return [
    gutter({
      class: 'cm-blame-gutter',
      lineMarker: (view, line) => {
        const g = starts.get(view.state.doc.lineAt(line.from).number);
        return g ? new BlameMarker(g, onOpen, heatColor(groups, g.time)) : null;
      },
    }),
    currentLineBlame(groups),
  ];
}

// ---- conflict-marker resolution widgets ----------------------------------------
// VS Code's inline merge flow: a bar above each <<<<<<< block with Accept
// Current / Incoming / Both. Blocks rescan on every edit, so a manual
// resolution (deleting the markers) just melts the UI away.

interface CBlock {
  /** Doc offset of the "<<<<<<<" line start — the block's stable identity. */
  from: number;
  /** Doc offset END of the ">>>>>>>" line. */
  to: number;
  /** Doc offset of the "=======" line start. */
  mid: number;
  /** Doc offset of the "|||||||" base marker, when diff3-style is in use. */
  base?: number;
  oursLabel: string;
  theirsLabel: string;
}

function scanConflicts(doc: Text): CBlock[] {
  const blocks: CBlock[] = [];
  let cur: { from: number; mid: number; base: number; oursLabel: string } | null = null;
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    if (l.text.startsWith('<<<<<<<')) {
      cur = { from: l.from, mid: -1, base: -1, oursLabel: l.text.slice(7).trim() };
    } else if (cur && cur.mid < 0 && l.text.startsWith('|||||||')) {
      cur.base = l.from;
    } else if (cur && cur.mid < 0 && l.text.startsWith('=======')) {
      cur.mid = l.from;
    } else if (cur && cur.mid >= 0 && l.text.startsWith('>>>>>>>')) {
      blocks.push({
        from: cur.from,
        to: l.to,
        mid: cur.mid,
        base: cur.base >= 0 ? cur.base : undefined,
        oursLabel: cur.oursLabel,
        theirsLabel: l.text.slice(7).trim(),
      });
      cur = null;
    }
  }
  return blocks;
}

/** The text between two marker lines (exclusive), trailing newline trimmed. */
function conflictRegion(doc: Text, fromLineStart: number, toLineStart: number): string {
  const from = doc.lineAt(fromLineStart).to + 1;
  const to = doc.lineAt(toLineStart).from - 1;
  return to >= from ? doc.sliceString(from, to) : '';
}

function resolveConflict(view: EditorView, blockFrom: number, take: 'ours' | 'theirs' | 'both') {
  const b = scanConflicts(view.state.doc).find((x) => x.from === blockFrom);
  if (!b) return;
  const doc = view.state.doc;
  const ours = conflictRegion(doc, b.from, b.base ?? b.mid);
  const theirs = conflictRegion(doc, b.mid, b.to);
  const text = take === 'ours' ? ours : take === 'theirs' ? theirs : [ours, theirs].filter(Boolean).join('\n');
  view.dispatch({ changes: { from: b.from, to: b.to, insert: text } });
}

class ConflictBar extends WidgetType {
  constructor(readonly b: CBlock) {
    super();
  }
  override eq(w: ConflictBar): boolean {
    return w.b.from === this.b.from && w.b.oursLabel === this.b.oursLabel && w.b.theirsLabel === this.b.theirsLabel;
  }
  override toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-conflict-bar';
    const hint = document.createElement('span');
    hint.className = 'cm-conflict-hint';
    hint.textContent = '⚡ conflict';
    bar.appendChild(hint);
    for (const [label, take] of [
      [`Accept Current${this.b.oursLabel ? ` (${this.b.oursLabel})` : ''}`, 'ours'],
      [`Accept Incoming${this.b.theirsLabel ? ` (${this.b.theirsLabel})` : ''}`, 'theirs'],
      ['Accept Both', 'both'],
    ] as const) {
      const btn = document.createElement('button');
      btn.className = 'cm-conflict-btn';
      btn.textContent = label;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep the editor's focus + selection
        resolveConflict(view, this.b.from, take);
      });
      bar.appendChild(btn);
    }
    return bar;
  }
}

function buildConflictBars(doc: Text): DecorationSet {
  const specs: Range<Decoration>[] = [];
  for (const b of scanConflicts(doc)) {
    specs.push(Decoration.widget({ widget: new ConflictBar(b), block: true, side: -1 }).range(b.from));
    for (let pos = b.from; pos <= b.to; ) {
      const l = doc.lineAt(pos);
      const t = l.text;
      const isMarker =
        t.startsWith('<<<<<<<') || t.startsWith('=======') || t.startsWith('>>>>>>>') || t.startsWith('|||||||');
      const region = isMarker
        ? ''
        : l.from < (b.base ?? b.mid)
          ? 'cm-conflict-ours'
          : l.from > b.mid
            ? 'cm-conflict-theirs'
            : '';
      if (region) specs.push(Decoration.line({ class: region }).range(l.from));
      pos = l.to + 1;
    }
  }
  return Decoration.set(specs);
}

const conflictBars = StateField.define<DecorationSet>({
  // Block widgets may only come from state fields (plugins are inline-only).
  create: (s) => buildConflictBars(s.doc),
  update: (v, tr) => (tr.docChanged ? buildConflictBars(tr.state.doc) : v),
  provide: (f) => EditorView.decorations.from(f),
});

/** Rebuild a REDUCED unified patch from a file's diff, keeping only the
 * chosen +/- lines (unchosen '+' dropped, unchosen '-' rewritten as context
 * — git add -p's edit-hunk semantics; counts recomputed, starts kept so
 * `git apply --cached` applies it cleanly). */
function buildPatch(lines: string[], chosen: Set<number>): string {
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk < 0) return '';
  const out = lines.slice(0, firstHunk);
  let i = firstHunk;
  while (i < lines.length) {
    const head = lines[i];
    if (!head.startsWith('@@')) {
      i++;
      continue;
    }
    let j = i + 1;
    const body: { idx: number; text: string }[] = [];
    while (j < lines.length && !lines[j].startsWith('@@') && !lines[j].startsWith('diff --git')) {
      if (lines[j] !== '') body.push({ idx: j, text: lines[j] });
      j++;
    }
    let anyChosen = false;
    const kept: string[] = [];
    for (const l of body) {
      const c = l.text[0];
      if (c === '+') {
        if (chosen.has(l.idx)) {
          kept.push(l.text);
          anyChosen = true;
        }
      } else if (c === '-') {
        if (chosen.has(l.idx)) {
          kept.push(l.text);
          anyChosen = true;
        } else {
          kept.push(' ' + l.text.slice(1));
        }
      } else {
        kept.push(l.text); // context + "\ No newline" tails
      }
    }
    if (anyChosen) {
      const m = /@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(head);
      const start = m ? m[1] : '0';
      const oldCount = kept.filter((l) => l[0] === ' ' || l[0] === '-').length;
      const newCount = kept.filter((l) => l[0] === ' ' || l[0] === '+').length;
      out.push(`@@ -${start},${oldCount} +${start},${newCount} @@`);
      out.push(...kept);
    }
    i = j;
  }
  return out.join('\n') + '\n';
}

// Highlighting covers every language the package index installs a server
// for (go, c/cpp, bash, yaml…) plus the daily config/web formats — official
// @codemirror/lang-* packages where they exist, CM5 legacy-modes otherwise
// (P2.5's ratified route: no TextMate pipeline, one language at a time).
function langFor(path: string): Extension {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  const ext = name.split('.').pop() ?? '';
  switch (ext) {
    case 'rs':
      return rust();
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: ext === 'jsx' });
    case 'py':
      return python();
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'c':
    case 'h':
    case 'cpp':
    case 'cxx':
    case 'cc':
    case 'hpp':
    case 'hxx':
    case 'hh':
      return cpp();
    case 'go':
      return StreamLanguage.define(go);
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell);
    case 'yaml':
    case 'yml':
      return yaml();
    case 'toml':
      return StreamLanguage.define(toml);
    case 'css':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'xml':
    case 'svg':
      return xml();
    case 'sql':
      return sql();
    case 'lua':
      return StreamLanguage.define(lua);
    case 'rb':
      return StreamLanguage.define(ruby);
    case 'pl':
    case 'pm':
      return StreamLanguage.define(perl);
    case 'r':
      return StreamLanguage.define(r);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    default:
      break;
  }
  // Extension-less names that are languages in disguise.
  switch (name) {
    case 'dockerfile':
    case 'containerfile':
      return StreamLanguage.define(dockerFile);
    case 'nginx.conf':
      return StreamLanguage.define(nginx);
    case '.bashrc':
    case '.zshrc':
    case '.bash_profile':
    case '.bash_aliases':
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

export interface CodePanel {
  toggle(): void;
  isOpen(): boolean;
  /** ⌘P: fuzzy-open a file from the repo. */
  quickOpen(): void;
  /** Esc pressed: returns true if consumed (e.g. closed quick-open). */
  escape(): boolean;
  /** Re-apply the current theme preset to every editor and buffer. */
  retheme(): void;
  /** Open the panel at (pane-root session, path) — the git graph's conflict
   * jump-in. */
  openAt(root: string, path: string): void;
}

// One code view per pane. The tree, the changes list and the editor are all
// rooted at the same pane cwd, so they live together in a Session rather than
// as separate loose variables that have to be reset in lockstep by hand.
//
// Every opened file gets its own Buffer that is NEVER discarded by opening
// another file — so there is no "discard your edits?" prompt anywhere. Text
// buffers carry doc + undo history; viewer buffers (pdf, images, binaries)
// just mark the file open so it has a tab like any other.
type Buffer =
  | {
      kind: 'text';
      savedDoc: string; // last saved contents (dirty = editor doc differs)
      state: EditorState; // doc + history + selection
      dirty: boolean; // cached for background buffers; live one uses isDirty()
      /** Non-null while the blame gutter is on for this buffer. */
      blame?: BlameGroup[] | null;
    }
  | { kind: 'viewer' };
interface Session {
  pane: number | null;
  /** Root-switcher override (absolute); null = the pane's cwd. */
  root: string | null;
  path: string | null; // buffer currently in the editor, or null
  buffers: Map<string, Buffer>;
  /** The override the last fsRoot fetch was for (cache key for read-back). */
  fsRootReq?: string | null;
  /** Effective absolute root the daemon actually honored (LSP-URI mapping +
   * root bar display). */
  fsRoot?: string;
  /** .gitmodules registry (uninitialized dirs get init rows in the tree). */
  submodules?: { path: string; initialized: boolean }[];
}

export interface CodePanelOpts {
  getActivePane: () => number | null;
  /** The active workspace's daemon base URL (multi-host: differs per host). */
  getApiBase: () => string;
  /** Scope key for per-pane sessions — pane ids collide across hosts. */
  getScope: () => string;
  /** The default root before any manual switch: the pane's cwd or its repo. */
  getDefaultRoot: () => 'pane' | 'repo';
  /** Blame-gutter click-through: open this commit in the git graph. */
  onBlameHash?: (hash: string) => void;
  /** History-button click-through: open the file's history in the git graph. */
  onFileHistory?: (root: string, path: string) => void;
}

/** The ⌘E code overlay, rooted at the focused pane's cwd. */
export function initCodePanel(opts: CodePanelOpts): CodePanel {
  apiBase = opts.getApiBase;
  const panel = document.createElement('div');
  panel.id = 'code';
  panel.className = 'code-panel';
  panel.innerHTML = `
    <div class="code-side">
      <div class="code-side-hd">changes</div>
      <div class="code-changes" id="code-changes"></div>
      <div class="code-side-hd">files</div>
      <div class="code-root" id="code-root">
        <button id="root-up" title="up one level">↑</button>
        <button id="root-home" title="back to the pane's cwd">⌂</button>
        <button id="root-repo" title="git repo root">⎇</button>
        <span id="code-root-path"></span>
      </div>
      <div class="code-tree" id="code-tree"></div>
    </div>
    <div class="code-main">
      <div class="code-hd"><span id="code-path">no file open</span><button id="code-history" class="pkgs-btn" title="file history in the git graph">Hist</button><button id="code-blame" class="pkgs-btn" title="git blame gutter (needs a saved file)">Blame</button><span id="code-hint" title="⌘P open · ⌘S save · ⌘. fix · F12 def · F2 rename · esc/⌘E close">⌘P open · ⌘S save · ⌘. fix · F12 def · F2 rename · esc/⌘E close</span></div>
      <div class="code-bufs" id="code-bufs"></div>
      <div class="code-editor" id="code-editor"></div>
      <div class="code-diff" id="code-diff"></div>
      <div class="code-viewer" id="code-viewer"></div>
      <div class="code-ph" id="code-ph"></div>
    </div>`;
  document.body.appendChild(panel);

  const treeEl = panel.querySelector('#code-tree') as HTMLElement;
  const changesEl = panel.querySelector('#code-changes') as HTMLElement;
  const rootEl = panel.querySelector('#code-root') as HTMLElement;
  const rootPathEl = panel.querySelector('#code-root-path') as HTMLElement;
  const pathEl = panel.querySelector('#code-path') as HTMLElement;
  const bufsEl = panel.querySelector('#code-bufs') as HTMLElement;
  const editorParent = panel.querySelector('#code-editor') as HTMLElement;
  const diffEl = panel.querySelector('#code-diff') as HTMLElement;
  const viewerEl = panel.querySelector('#code-viewer') as HTMLElement;
  const phEl = panel.querySelector('#code-ph') as HTMLElement;
  diffEl.style.display = 'none';

  panel.querySelector('#root-up')!.addEventListener('click', () => {
    const s = current;
    const abs = s?.root ?? s?.fsRoot;
    if (!s || !abs) return;
    const parent = abs.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
    if (parent !== abs) switchRoot(parent);
  });
  panel.querySelector('#root-home')!.addEventListener('click', () => switchRoot(null));
  panel.querySelector('#root-repo')!.addEventListener('click', () => {
    const s = current;
    if (!s) return;
    void gitToplevel(s.pane, s.root).then((top) => {
      if (top) switchRoot(top);
      else flashHint('not a git repo');
    });
  });

  let editor: EditorView | null = null;
  const sessions = new Map<string, Session>();
  let current: Session | null = null;
  let open = false;

  const keyOf = (p: number | null, root: string | null) =>
    `${opts.getScope()}:${p ?? -1}|${root ?? ''}`;
  const paneKey = (p: number | null) => `${opts.getScope()}:${p ?? -1}`;
  // Every root (pane cwd, repo root, a parent) gets its OWN session — buffers,
  // tree and changes are per-root, so switching roots never strands edits or
  // saves to the wrong place. The switcher remembers the last root per pane.
  const lastRoot = new Map<string, string | null>();
  function sessionFor(p: number | null, root: string | null): Session {
    const k = keyOf(p, root);
    let s = sessions.get(k);
    if (!s) {
      s = { pane: p, root, path: null, buffers: new Map() };
      sessions.set(k, s);
    }
    return s;
  }

  const curBuf = () => (current?.path ? current.buffers.get(current.path) : undefined);

  // Derived, never stored — the single source of "unsaved?" truth.
  const isDirty = () => {
    const b = curBuf();
    return !!(
      b &&
      b.kind === 'text' &&
      editor &&
      editor.state.doc.toString() !== b.savedDoc
    );
  };

  // Snapshot the visible editor back into its buffer (edits + undo history).
  function stash() {
    const b = curBuf();
    if (b && b.kind === 'text' && editor) {
      b.state = editor.state;
      b.dirty = editor.state.doc.toString() !== b.savedDoc;
    }
  }

  function renderHeader() {
    if (!current?.path) {
      pathEl.textContent = 'no file open';
      pathEl.style.color = '';
      renderBufs();
      renderBlameBtn();
      return;
    }
    if (curBuf()?.kind !== 'viewer') {
      const d = isDirty();
      pathEl.textContent = (d ? '● ' : '') + current.path;
      pathEl.style.color = d ? '#d6a04c' : '';
    }
    renderBufs();
    renderBlameBtn();
  }

  // The Blame toggle mirrors the live buffer's gutter state (and hides for
  // viewers / the empty state).
  const blameBtn = panel.querySelector('#code-blame') as HTMLButtonElement;
  blameBtn.addEventListener('click', () => void toggleBlame());
  const histBtn = panel.querySelector('#code-history') as HTMLButtonElement;
  histBtn.addEventListener('click', () => void openFileHistory());
  function renderBlameBtn() {
    const b = curBuf();
    blameBtn.classList.toggle('on', !!(b && b.kind === 'text' && b.blame));
    blameBtn.style.display = b && b.kind === 'text' ? '' : 'none';
    histBtn.style.display = b && b.kind === 'text' && opts.onFileHistory ? '' : 'none';
  }

  /** Resolve (repo toplevel, repo-relative path) for a session file — shared
   * by Blame and History. null when the file sits outside the work tree. */
  async function repoPathFor(s: Session, path: string): Promise<{ top: string; rel: string } | null> {
    const top = await gitToplevel(s.pane, s.root);
    if (!top) return null;
    const absRoot = (s.root ?? s.fsRoot)?.replace(/\/+$/, '');
    if (!absRoot) return null;
    const abs = `${absRoot}/${path}`;
    if (!abs.startsWith(`${top}/`)) return null;
    return { top, rel: abs.slice(top.length + 1) };
  }

  /** Toggle the per-buffer blame gutter. Kept off dirty buffers: blame line
   * numbers would lie against unsaved edits. */
  async function toggleBlame() {
    const s = current;
    const b = curBuf();
    if (!s || !s.path || !b || b.kind !== 'text' || !editor) return;
    const path = s.path;
    if (b.blame) {
      b.blame = null;
      editor.dispatch({ effects: blameSlot.reconfigure([]) });
      renderBlameBtn();
      return;
    }
    if (isDirty()) {
      flashHint('save the file before blaming (⌘S)');
      return;
    }
    const rp = await repoPathFor(s, path);
    if (!rp) {
      flashHint('not in a git repo (or root unresolved)');
      return;
    }
    const { top, rel } = rp;
    let groups: BlameGroup[];
    try {
      const r = await fetch(
        `${apiBase()}/git/blame?${paneQ(s.pane)}path=${encodeURIComponent(rel)}&root=${encodeURIComponent(top)}`,
      );
      if (!r.ok) {
        flashHint(r.status === 404 ? 'no blame yet (untracked file?)' : `blame failed (${r.status})`);
        return;
      }
      groups = ((await r.json()) as { groups: BlameGroup[] }).groups;
    } catch {
      flashHint('blame failed (daemon unreachable)');
      return;
    }
    // The buffer may have switched while we fetched.
    if (current !== s || s.path !== path || !editor) return;
    b.blame = groups;
    editor.dispatch({
      effects: blameSlot.reconfigure(blameGutter(groups, (h) => opts.onBlameHash?.(h))),
    });
    renderBlameBtn();
  }

  /** The History button: hand the file's repo (top, rel) to the git graph. */
  async function openFileHistory() {
    const s = current;
    if (!s?.path || !opts.onFileHistory) return;
    const rp = await repoPathFor(s, s.path);
    if (!rp) {
      flashHint('not in a git repo (or root unresolved)');
      return;
    }
    opts.onFileHistory(rp.top, rp.rel);
  }

  // Open-buffer chips: click to switch, ✕ to close. A dirty buffer's ✕ needs
  // a second click within 1.6s (mouse-only confirm, per house rules).
  function renderBufs() {
    const s = current;
    if (!s || s.buffers.size === 0) {
      bufsEl.style.display = 'none';
      return;
    }
    bufsEl.style.display = 'flex';
    bufsEl.replaceChildren();
    for (const [path, buf] of s.buffers) {
      const active = path === s.path;
      const dirty = buf.kind === 'text' && (active ? isDirty() : buf.dirty);
      const chip = document.createElement('span');
      chip.className = 'bufchip' + (active ? ' active' : '') + (dirty ? ' dirty' : '');
      chip.textContent = (dirty ? '● ' : '') + path.slice(path.lastIndexOf('/') + 1);
      chip.title = path;
      chip.addEventListener('click', () => void openFile(path));
      const x = document.createElement('span');
      x.className = 'bufx';
      x.textContent = '✕';
      x.title = dirty ? 'unsaved — click twice to discard' : 'close';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeBuffer(path, chip);
      });
      chip.appendChild(x);
      bufsEl.appendChild(chip);
    }
  }

  function closeBuffer(path: string, chip: HTMLElement) {
    const s = current;
    if (!s) return;
    const buf = s.buffers.get(path);
    const dirty =
      buf?.kind === 'text' && (path === s.path ? isDirty() : buf.dirty);
    if (dirty && !chip.classList.contains('confirm')) {
      chip.classList.add('confirm');
      setTimeout(() => chip.classList.remove('confirm'), 1600);
      return;
    }
    s.buffers.delete(path);
    if (s.path === path) {
      s.path = null;
      const rest = [...s.buffers.keys()];
      if (rest.length) {
        void openFile(rest[rest.length - 1]);
        return;
      }
      mount(emptyState());
      pathEl.textContent = 'no file open';
      pathEl.style.color = '';
    }
    renderHeader();
  }

  // Placeholder shown when a pane has no file open — read-only so it can't be
  // mistaken for an editable buffer.
  const themed = () => cmThemeSlot.of(cmThemeFor(presetById(getPrefs().theme)));
  const emptyState = () =>
    EditorState.create({
      doc: '',
      extensions: [basicSetup, editorTheme, themed(), EditorView.editable.of(false)],
    });

  function fileState(path: string, doc: string, lsp: Extension | null): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        editorTheme,
        themed(),
        langFor(path),
        blameSlot.of([]), // the blame gutter toggles in here, never a rebuild
        ...(lsp ? [lsp] : []),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
          { key: 'Mod-.', preventDefault: true, run: () => (void openCodeActions(), true) },
        ]),
        conflictBars, // no-op unless the doc actually carries conflict markers
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            renderHeader();
            // Edits misalign blame line numbers — drop the gutter (and its
            // buffer flag) on the first change rather than annotating lies.
            const buf = current?.buffers.get(path);
            if (buf?.kind === 'text' && buf.blame) {
              buf.blame = null;
              renderBlameBtn();
              setTimeout(() => {
                if (editor && current?.path === path) {
                  editor.dispatch({ effects: blameSlot.reconfigure([]) });
                }
              }, 0);
            }
          }
        }),
      ],
    });
  }

  function mount(state: EditorState) {
    if (editor) editor.setState(state);
    else editor = new EditorView({ state, parent: editorParent });
    editorParent.style.display = '';
    diffEl.style.display = 'none';
    destroyMerge();
    viewerEl.style.display = 'none';
    phEl.style.display = '';
  }

  // A registered viewer takes over files the text editor can't show (binary,
  // too large): images render, everything else gets a hex dump.
  function showViewer(path: string) {
    const s = current;
    if (!s) return;
    const v = viewerFor(path);
    if (!v) return; // (hex claims everything, but stay defensive)
    pathEl.textContent = `${path} — ${v.name}`;
    pathEl.style.color = '';
    viewerEl.replaceChildren();
    void v.render(makeCtx(apiBase(), s.pane, path), viewerEl);
    editorParent.style.display = 'none';
    diffEl.style.display = 'none';
    destroyMerge();
    phEl.style.display = '';
    viewerEl.style.display = 'flex';
  }

  // VSCode-style stand-in for files the editor can't show — replaces the editor
  // area (never leaves the previous file's text on screen under an error).
  function showPlaceholder(path: string, status?: number) {
    pathEl.textContent = `${path} — can't display`;
    pathEl.style.color = '';
    const reason =
      status === 404 ? 'It no longer exists.' : 'It could not be read.';
    const line = (cls: string, text: string) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      return d;
    };
    phEl.replaceChildren(
      line('ph-title', 'This file is not displayed in the editor.'),
      line('ph-reason', reason),
    );
    editorParent.style.display = 'none';
    diffEl.style.display = 'none';
    destroyMerge();
    viewerEl.style.display = 'none';
    phEl.style.display = 'flex';
  }

  async function save() {
    if (!editor || !current?.path) return;
    const s = current;
    const b = curBuf();
    if (!b || b.kind !== 'text') return;
    const doc = editor.state.doc.toString();
    const ok = await fsWrite(s.pane, s.path!, doc, s.root);
    if (ok) {
      b.savedDoc = doc;
      b.dirty = false;
      b.state = editor.state;
      // The disk now matches the buffer: let the language server know
      // (rust-analyzer runs cargo check off didSave → compiler-tier errors).
      notifySaved(editor);
      const p = s.path;
      pathEl.textContent = `${p}   ✓ saved`;
      renderBufs();
      setTimeout(() => {
        if (current === s && current.path === p) renderHeader();
      }, 1200);
    } else {
      pathEl.textContent = `${s.path}   ✗ save failed`;
    }
  }

  async function openFile(path: string) {
    if (!current) return;
    const s = current;
    const existing = s.buffers.get(path);
    // Viewer buffers re-render fresh (they hold no local state worth keeping).
    if (existing?.kind === 'viewer') {
      stash();
      s.path = path;
      showViewer(path);
      renderHeader();
      return;
    }
    // A dirty buffer restores as-is — edits and undo history intact, no disk
    // read (the user's changes outrank whatever is on disk right now).
    if (existing && (existing.dirty || (s.path === path && isDirty()))) {
      if (s.path === path) return; // already showing it
      stash();
      s.path = path;
      mount(existing.state);
      renderHeader();
      editor!.focus();
      return;
    }
    // Clean (or new) buffers read the disk so agent-made edits show up.
    let content: string;
    try {
      content = await fsRead(s.pane, path, s.root);
    } catch (e) {
      if (current !== s) return;
      const status = (e as { status?: number }).status;
      if (status === 415 || status === 400) {
        // Binary / too large → a viewer (pdf, image, hex) — and a real tab,
        // same as any text file.
        stash();
        s.buffers.set(path, { kind: 'viewer' });
        s.path = path;
        showViewer(path);
        renderHeader();
      } else {
        s.buffers.delete(path); // a stale buffer of a now-unreadable file
        showPlaceholder(path, status);
        renderBufs();
      }
      return;
    }
    if (current !== s) return; // switched panes mid-read
    stash();
    if (existing && content === existing.savedDoc) {
      // Disk unchanged: restore the old state (keeps undo history).
      s.path = path;
      mount(existing.state);
    } else {
      // Language smarts when available; absent/failed → plain editor. (No
      // auto-nagging about missing servers — the packages panel is where
      // installs live, at the user's initiative.)
      const lsp = await lspExtensionFor(apiBase(), s.pane, path);
      if (current !== s) return;
      s.path = path;
      const state = fileState(path, content, lsp);
      s.buffers.set(path, { kind: 'text', savedDoc: content, state, dirty: false });
      mount(state);
    }
    renderHeader();
    editor!.focus();
  }

  // The diff is a transient view over the current pane; it leaves the editor
  // session untouched, so switching back restores the open file and its edits.
  // Two modes: the classic unified view, or a side-by-side MergeView
  // (HEAD/index on the left, working tree on the right).
  let mergeView: MergeView | null = null;
  function destroyMerge() {
    mergeView?.destroy();
    mergeView = null;
  }
  async function showDiff(path: string, staged = false, mode: 'unified' | 'split' = 'unified') {
    if (!current) return;
    const s = current;
    pathEl.textContent = `diff · ${path}`;
    pathEl.style.color = '';
    destroyMerge();
    const text = (await gitDiff(s.pane, path, staged, s.root)) || '(no textual diff)';
    if (current !== s) return;
    diffEl.replaceChildren();
    // Controls: staged/unstaged toggle (hidden for new files), unified/split
    // view modes, and a jump into the editor.
    const ctl = document.createElement('div');
    ctl.className = 'diff-ctl';
    const isNew = text.includes('new file mode');
    const mkBtn = (label: string, on: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'diff-ctl-btn' + (on ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    if (!isNew) {
      ctl.append(
        mkBtn('unstaged', !staged, () => void showDiff(path, false, mode)),
        mkBtn('staged', staged, () => void showDiff(path, true, mode)),
      );
    }
    ctl.append(
      mkBtn('unified', mode === 'unified', () => void showDiff(path, staged, 'unified')),
      mkBtn('split', mode === 'split', () => void showDiff(path, staged, 'split')),
      mkBtn('open in editor', false, () => void openFile(path)),
    );
    diffEl.appendChild(ctl);
    if (mode === 'split') {
      // Left = HEAD; right = the index (staged) or the working tree (unstaged).
      const aText = (await gitBlob(s.pane, path, false, s.root)) ?? '';
      let bText = '';
      if (staged) bText = (await gitBlob(s.pane, path, true, s.root)) ?? '';
      else bText = await fsRead(s.pane, path, s.root).catch(() => '');
      if (current !== s) return;
      const ro = [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        editorTheme,
        themed(),
        langFor(path),
      ];
      mergeView = new MergeView({
        a: { doc: aText, extensions: ro },
        b: { doc: bText, extensions: ro },
        parent: diffEl,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
    } else if (text !== '(no textual diff)') {
      renderStageableUnified(text, path, staged, ctl);
    } else {
      const el = document.createElement('div');
      el.className = 'dl';
      el.textContent = text;
      diffEl.appendChild(el);
    }
    editorParent.style.display = 'none';
    diffEl.style.display = '';
    viewerEl.style.display = 'none';
    phEl.style.display = '';
  }

  /** Unified diff with hunk/line-level staging: every '+'/'-' row toggles
   * into a selection on click, every @@ carries a whole-hunk action, and the
   * ctl row drives "N selected". Rebuilds a REDUCED patch (unchosen '+'
   * dropped, unchosen '-' rewritten as context — the git add -p edit
   * semantics) and applies it via /git/apply (--cached; --reverse from the
   * staged side). */
  function renderStageableUnified(text: string, path: string, staged: boolean, ctl: HTMLElement) {
    const s = current;
    if (!s) return;
    const lines = text.split('\n');
    const word = staged ? 'unstage' : 'stage';
    const sel = new Set<number>();
    const selBtn = document.createElement('button');
    selBtn.className = 'diff-ctl-btn';
    selBtn.style.display = 'none';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'diff-ctl-btn';
    clearBtn.style.display = 'none';
    clearBtn.textContent = 'clear';
    clearBtn.addEventListener('click', () => {
      sel.clear();
      diffEl.querySelectorAll('.dl.sline.sel').forEach((x) => x.classList.remove('sel'));
      refreshSelCtl();
    });
    ctl.append(selBtn, clearBtn);
    const refreshSelCtl = () => {
      selBtn.style.display = sel.size ? '' : 'none';
      clearBtn.style.display = sel.size ? '' : 'none';
      selBtn.textContent = sel.size ? `${word} ${sel.size} selected` : '';
    };
    let inHunks = false;
    let hunkBody: number[] = [];
    lines.forEach((line, idx) => {
      const isHunk = line.startsWith('@@');
      const isMeta =
        /^(diff |index |--- |\+\+\+ |new file|deleted |similarity |rename )/.test(line);
      const row = document.createElement('div');
      row.className =
        'dl ' +
        (isHunk ? 'dhunk' : isMeta ? 'dmeta' : inHunks && line[0] === '+' ? 'dadd' : inHunks && line[0] === '-' ? 'ddel' : '');
      row.textContent = line || ' ';
      if (isHunk) {
        inHunks = true;
        hunkBody = [];
        const hb = document.createElement('button');
        hb.className = 'dl-hunk-btn';
        hb.textContent = `${word} hunk`;
        const idxs = hunkBody;
        hb.addEventListener('click', (e) => {
          e.stopPropagation();
          void applyLines(new Set(idxs));
        });
        row.appendChild(hb);
      } else if (!isMeta && inHunks && (line[0] === '+' || line[0] === '-')) {
        hunkBody.push(idx);
        row.classList.add('sline');
        row.title = `click to ${word === 'stage' ? 'select' : 'select'} — ${word} selected ranges below`;
        row.addEventListener('click', () => {
          if (sel.has(idx)) sel.delete(idx);
          else sel.add(idx);
          row.classList.toggle('sel');
          refreshSelCtl();
        });
      }
      diffEl.appendChild(row);
    });
    selBtn.addEventListener('click', () => {
      const chosen = new Set(sel);
      sel.clear();
      void applyLines(chosen);
    });
    async function applyLines(chosen: Set<number>) {
      const sess = s;
      if (!chosen.size || !sess) return;
      const patch = buildPatch(lines, chosen);
      let ok = false;
      try {
        const r = await fetch(`${apiBase()}/git/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pane: sess.pane ?? undefined, root: sess.root ?? undefined, patch, reverse: staged }),
        });
        const res = (await r.json()) as { ok: boolean; out: string };
        ok = r.ok && res.ok;
        if (!ok) flashHint(res.out.split('\n')[0] || 'apply failed');
      } catch {
        flashHint('daemon unreachable');
      }
      if (!ok) return;
      loadChanges();
      await showDiff(path, staged, 'unified');
    }
  }

  function treeItem(path: string, name: string, dir: boolean, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'trow' + (dir ? ' tdir' : ' tfile');
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    row.textContent = (dir ? '▸ ' : '') + name;
    wrap.appendChild(row);

    if (dir) {
      const kids = document.createElement('div');
      kids.style.display = 'none';
      wrap.appendChild(kids);
      let loaded = false;
      let expanded = false;
      const renderKids = async () => {
        kids.replaceChildren();
        const pane = current?.pane ?? null;
        const sroot = current?.root ?? null;
        const entries = await fsList(pane, path, sroot);
        for (const c of entries) {
          kids.appendChild(treeItem(path ? `${path}/${c.name}` : c.name, c.name, c.dir, depth + 1));
        }
        // An EMPTY dir that's a registered-but-uninitialized submodule offers
        // a one-click `submodule update --init`.
        if (entries.length === 0) {
          const sm = current?.submodules?.find((x) => x.path === path && !x.initialized);
          if (sm) {
            const initRow = document.createElement('div');
            initRow.className = 'trow tsubinit';
            initRow.style.paddingLeft = `${(depth + 1) * 12 + 8}px`;
            initRow.textContent = '⬇ uninitialized submodule — click to init';
            initRow.title = 'git submodule update --init';
            initRow.addEventListener('click', async (ev) => {
              ev.stopPropagation();
              initRow.textContent = 'initializing (clone)…';
              try {
                const r = await fetch(`${apiBase()}/git/submodule/update`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ pane: pane ?? undefined, root: sroot ?? undefined, path }),
                });
                if (!r.ok) {
                  initRow.textContent = 'init failed — click to retry';
                  return;
                }
              } catch {
                initRow.textContent = 'init failed — click to retry';
                return;
              }
              sm.initialized = true;
              await renderKids();
            });
            kids.appendChild(initRow);
          }
        }
      };
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        expanded = !expanded;
        row.textContent = (expanded ? '▾ ' : '▸ ') + name;
        kids.style.display = expanded ? '' : 'none';
        if (expanded && !loaded) {
          loaded = true;
          await renderKids();
        }
      });
    } else {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void openFile(path);
      });
    }
    return wrap;
  }

  async function loadTree() {
    const s = current;
    void refreshSubmodules(s);
    treeEl.replaceChildren();
    const items = await fsList(s?.pane ?? null, '', s?.root ?? null);
    if (current !== s) return; // switched panes mid-fetch
    for (const c of items) treeEl.appendChild(treeItem(c.name, c.name, c.dir, 0));
  }

  /** .gitmodules registry for the session (used by the tree's init rows). */
  async function refreshSubmodules(s: Session | null) {
    if (!s) return;
    try {
      const r = await fetch(`${apiBase()}/git/submodules?${paneQ(s.pane)}${rootQ(s.root)}`);
      if (!r.ok) return;
      const list = (await r.json()) as { path: string; initialized: boolean }[];
      if (current === s) s.submodules = list;
    } catch {
      /* optional metadata */
    }
  }

  async function loadChanges() {
    const s = current;
    const files = await gitStatus(s?.pane ?? null, s?.root ?? null);
    if (current !== s) return;
    changesEl.replaceChildren();
    if (!files.length) {
      changesEl.textContent = 'clean';
      return;
    }
    for (const f of files) {
      const st = f.status.trim();
      const cls = st.includes('?') || st.includes('A') ? 'gnew' : st.includes('D') ? 'gdel' : 'gmod';
      const row = document.createElement('div');
      row.className = 'grow';
      const badge = document.createElement('span');
      badge.className = `gbadge ${cls}`;
      badge.textContent = st || '·';
      row.appendChild(badge);
      row.appendChild(document.createTextNode(' ' + f.path));
      if (f.submodule) {
        // A gitlink: its "diff" is just two commit hashes. The useful action
        // is entering the submodule as the panel's root (its own status /
        // diffs / files then work, git resolves the nested repo itself).
        badge.className = 'gbadge gsub';
        badge.textContent = 'S';
        row.title = 'submodule — click to switch root into it';
        row.addEventListener('click', () => void enterSubmodule(f.path));
      } else {
        row.addEventListener('click', () => void showDiff(f.path));
      }
      changesEl.appendChild(row);
    }
  }

  async function enterSubmodule(subPath: string) {
    const s = current;
    if (!s) return;
    const top = await gitToplevel(s.pane, s.root);
    if (!top || current !== s) return;
    switchRoot(`${top}/${subPath}`);
  }

  // Swap the whole view to a pane's session: snapshot the outgoing editor, then
  // restore (or create) the incoming one. This is the only place "which pane"
  // changes, so there is nothing to reset by hand elsewhere. A root override
  // selects the per-root session for that pane (see the root switcher).
  function showSession(p: number | null, root?: string | null) {
    stash(); // snapshot outgoing edits into their buffer
    const pk = paneKey(p);
    const fresh = !lastRoot.has(pk);
    const eff = root !== undefined ? root : (lastRoot.get(pk) ?? null);
    lastRoot.set(pk, eff);
    current = sessionFor(p, eff);
    const b = curBuf();
    if (b?.kind === 'viewer' && current.path) showViewer(current.path);
    else mount(b?.kind === 'text' ? b.state : emptyState());
    renderHeader();
    renderRootBar();
    void loadTree();
    void loadChanges();
    editor?.focus();
    // Pref "default root: repo": auto-jump once per pane unless the user has
    // switched roots manually since (an explicit ⌂ back to cwd sticks).
    if (fresh && root === undefined && opts.getDefaultRoot() === 'repo') {
      void gitToplevel(p, null).then((top) => {
        if (top && lastRoot.get(pk) == null && current?.pane === p) showSession(p, top);
      });
    }
    // Cache the EFFECTIVE absolute root for LSP-URI → panel-path mapping and
    // the root bar — the daemon may reject an override (outside $HOME), so
    // always read back what it actually honored.
    const s = current;
    if (!s.fsRoot || s.root !== (s.fsRootReq ?? null)) {
      s.fsRootReq = s.root;
      const paneQ = s.pane != null ? `pane=${s.pane}&` : '';
      const rootQ = s.root ? `root=${encodeURIComponent(s.root)}&` : '';
      void fetch(`${apiBase()}/fs/root?${paneQ}${rootQ}`)
        .then((r) => r.json())
        .then((j: { root?: string }) => {
          if (j.root && current === s) {
            s.fsRoot = j.root;
            renderRootBar();
          }
        })
        .catch(() => {});
    }
  }

  // The root switcher: ↑ parent · ⌂ pane cwd · ⎇ repo root. The effective
  // root is always confined to the user's home on the daemon side.
  function renderRootBar() {
    const s = current;
    if (!s) return;
    const abs = s.fsRoot ?? s.root ?? '';
    rootEl.classList.toggle('switched', !!s.root);
    rootPathEl.textContent = abs || 'pane cwd';
    rootPathEl.title = abs;
  }

  function switchRoot(abs: string | null) {
    if (!current) return;
    showSession(current.pane, abs);
  }

  // Cross-file goto: the LSP seam hands us an absolute path; open it when it
  // sits under this session's root, return the (shared) editor view.
  setLspFileOpener(async (abs) => {
    const s = current;
    if (!s?.fsRoot) return null;
    const root = s.fsRoot.endsWith('/') ? s.fsRoot : `${s.fsRoot}/`;
    if (!abs.startsWith(root)) {
      flashHint('definition is outside this panel’s root');
      return null;
    }
    const rel = abs.slice(root.length);
    await openFile(rel);
    return current === s && s.path === rel ? editor : null;
  });

  // ---- code actions (⌘. in the editor) --------------------------------------
  const caEl = document.createElement('div');
  caEl.className = 'ca-menu';
  caEl.style.display = 'none';
  panel.appendChild(caEl);
  let caVisible = false;

  function closeCodeActions() {
    caVisible = false;
    caEl.style.display = 'none';
    editor?.focus();
  }

  async function openCodeActions() {
    if (!editor || !current?.path) return;
    const items = await requestCodeActions(editor);
    caEl.replaceChildren();
    if (!items.length) {
      flashHint('no code actions here');
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'ca-row';
      row.textContent = it.title + (it.kind ? `  (${it.kind})` : '');
      row.addEventListener('click', () => {
        closeCodeActions();
        void it.apply().then((err) => {
          if (err) flashHint(err);
        });
      });
      caEl.appendChild(row);
    }
    caVisible = true;
    caEl.style.display = '';
  }

  // Transient notice in the header's hint slot.
  const hintSpan = panel.querySelector('#code-hint') as HTMLElement;
  const hintDefault = hintSpan.textContent ?? '';
  let hintTimer: number | undefined;
  function flashHint(msg: string) {
    hintSpan.textContent = msg;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => (hintSpan.textContent = hintDefault), 2500);
  }

  // ---- quick open (⌘P): fuzzy over the repo's files (git ls-files) ---------
  const qoEl = document.createElement('div');
  qoEl.className = 'qopen';
  qoEl.style.display = 'none';
  qoEl.innerHTML = `<input class="qopen-input" placeholder="Open file…" spellcheck="false"><div class="qopen-list"></div>`;
  panel.appendChild(qoEl);
  const qoInput = qoEl.querySelector('.qopen-input') as HTMLInputElement;
  const qoList = qoEl.querySelector('.qopen-list') as HTMLElement;
  let qoAll: string[] = [];
  let qoShown: string[] = [];
  let qoSel = 0;
  let qoVisible = false;

  // Subsequence match, ranked: basename prefix > basename substring > path
  // substring > scattered subsequence; shorter paths win ties.
  function fuzzy(q: string, files: string[]): string[] {
    if (!q) return files.slice(0, 50);
    const lq = q.toLowerCase();
    const scored: Array<[number, string]> = [];
    for (const f of files) {
      const lf = f.toLowerCase();
      let qi = 0;
      for (let i = 0; i < lf.length && qi < lq.length; i++) if (lf[i] === lq[qi]) qi++;
      if (qi < lq.length) continue;
      const base = lf.slice(lf.lastIndexOf('/') + 1);
      const rank = base.startsWith(lq) ? 0 : base.includes(lq) ? 1 : lf.includes(lq) ? 2 : 3;
      scored.push([rank * 10000 + f.length, f]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    return scored.slice(0, 50).map((x) => x[1]);
  }

  function renderQo() {
    qoList.replaceChildren();
    qoShown.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'qopen-row' + (i === qoSel ? ' sel' : '');
      row.textContent = f;
      row.addEventListener('click', () => pickQo(f));
      qoList.appendChild(row);
    });
    if (!qoShown.length) {
      const empty = document.createElement('div');
      empty.className = 'qopen-empty';
      empty.textContent = qoAll.length ? 'no match' : 'not a git repo (or no files)';
      qoList.appendChild(empty);
    }
  }

  function pickQo(f: string) {
    closeQuickOpen();
    void openFile(f);
  }

  function closeQuickOpen() {
    qoVisible = false;
    qoEl.style.display = 'none';
  }

  async function quickOpen() {
    qoVisible = true;
    qoEl.style.display = '';
    qoInput.value = '';
    qoSel = 0;
    qoShown = [];
    renderQo();
    qoInput.focus();
    qoAll = await gitFiles(current?.pane ?? null, current?.root ?? null);
    if (!qoVisible) return;
    qoShown = fuzzy('', qoAll);
    renderQo();
  }

  qoInput.addEventListener('input', () => {
    qoSel = 0;
    qoShown = fuzzy(qoInput.value.trim(), qoAll);
    renderQo();
  });
  qoInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      qoSel = Math.min(qoSel + 1, Math.max(0, qoShown.length - 1));
      renderQo();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      qoSel = Math.max(qoSel - 1, 0);
      renderQo();
    } else if (e.key === 'Enter' && qoShown[qoSel]) {
      pickQo(qoShown[qoSel]);
    }
  });

  return {
    isOpen: () => open,
    quickOpen: () => {
      if (open) void quickOpen();
    },
    escape: () => {
      if (caVisible) {
        closeCodeActions();
        return true;
      }
      if (qoVisible) {
        closeQuickOpen();
        return true;
      }
      return false;
    },
    retheme() {
      const preset = presetById(getPrefs().theme);
      if (editor) editor.dispatch({ effects: cmThemeSlot.reconfigure(cmThemeFor(preset)) });
      if (current) {
        for (const [, b] of current.buffers) {
          if (b.kind === 'text') b.state = rethemeState(b.state, preset);
        }
      }
    },
    openAt(root: string, path: string) {
      if (!open) {
        open = true;
        panel.classList.add('show');
      }
      showSession(opts.getActivePane(), root);
      void openFile(path);
    },
    toggle() {
      if (open) {
        // Closing preserves the session (edits live on for the next open), so
        // there is nothing to discard here.
        closeQuickOpen();
        open = false;
        panel.classList.remove('show');
        return;
      }
      open = true;
      panel.classList.add('show');
      showSession(opts.getActivePane());
    },
  };
}
