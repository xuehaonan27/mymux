import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, StateField, type Extension, type Text, type Range } from '@codemirror/state';
import {
  keymap,
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
import { copyText } from './clipboard';
import { modOf } from './modkey';
import {
  parseToken,
  resolvePath,
  paneRoot,
  normalizeAbs,
  parentOf,
  baseOf,
} from './pathjump';
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
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

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

/** Decoration kinds for the file tree (VS Code colors): U untracked, A added,
 * M modified, R renamed/copied (paints as M), D deleted, IGN ignored. */
type GitKind = 'U' | 'A' | 'M' | 'R' | 'D' | 'IGN';
/** Porcelain XY status → the decoration kind. */
function gitKindOf(status: string): GitKind | null {
  if (status === '??') return 'U';
  if (status === '!!') return 'IGN';
  if (status.includes('D')) return 'D';
  if (status.includes('R') || status.includes('C')) return 'R';
  if (status.includes('A')) return 'A';
  if (status.includes('M')) return 'M';
  return null;
}
/** Severity for ancestor-dir aggregation (ignored never propagates up). */
const GIT_PRIO: Record<Exclude<GitKind, 'IGN'>, number> = { D: 5, R: 4, M: 3, A: 2, U: 1 };

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
  // NEVER silently [] — a 403/404/500 must not masquerade as an empty dir
  // (the tree showed that as "nothing here", which read as a hard bug).
  if (!r.ok) {
    const err = new Error(`list ${path || '/'}: ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
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
async function gitStatus(
  pane: number | null,
  root: string | null = null,
  ignored = false,
): Promise<GitFile[]> {
  const r = await fetch(
    `${apiBase()}/git/status?${paneQ(pane)}${rootQ(root)}${ignored ? 'ignored=1' : ''}`,
  );
  return r.ok ? r.json() : [];
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

// Markdown preview engine: markdown-it escapes raw HTML at the source
// (html:false — the first XSS wall), DOMPurify allowlists the result
// (the second). Module-level: one instance, no per-render cost.
const mdit = MarkdownIt({ html: false, linkify: true, breaks: true });

/** Render. Sanitize. Then rewrite relative src/href to /fs/raw URLs (in a
 * detached document, so the live DOM never sees unscrubbed markup). */
function mdRenderSanitized(md: string): DocumentFragment {
  const clean = DOMPurify.sanitize(mdit.render(md), { USE_PROFILES: { html: true } });
  return document.createRange().createContextualFragment(clean);
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
  /** Syntax-language extensions for a path — the git surface's split diff
   * reuses this mapping (wrapper-thunk, lazy-safe). */
  langFor(path: string): Extension[];
  /** Open the panel at (pane-root session, path) — the git graph's conflict
   * jump-in. `line` lands the cursor on it (path-jump gestures carry one). */
  openAt(root: string, path: string, line?: number): void;
  /** Open the panel rooted at an absolute dir — the terminal/editor
   * "jump to this directory" gesture. */
  openRoot(root: string): void;
  /** Host/workspace switched while open: swap the session to the new host's
   * active pane (sessions are workspace-scoped — showing the old host's
   * tree beside the new host's terminals is simply wrong). */
  hostSwitched(pane: number | null): void;
  /** Reload the tree (and the current file when one is open) — the
   * post-reconnect healer for a panel left holding a stale error row. */
  refresh(): void;
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
      /** True while the markdown PREVIEW is showing (md buffers). */
      mdPreview?: boolean;
    }
  | { kind: 'viewer' };
interface Session {
  pane: number | null;
  /** Root-switcher override (absolute); null = the pane's cwd. */
  root: string | null;
  path: string | null; // buffer currently in the editor, or null
  buffers: Map<string, Buffer>;
  /** Tree dirs the user has opened — the session outlives panel close/reopen,
   * so a reopened panel rebuilds the same expansion instead of collapsing
   * everything back to the root. */
  expanded: Set<string>;
  /** The override the last fsRoot fetch was for (cache key for read-back). */
  fsRootReq?: string | null;
  /** Effective absolute root the daemon actually honored (LSP-URI mapping +
   * root bar display). */
  fsRoot?: string;
  /** .gitmodules registry (uninitialized dirs get init rows in the tree). */
  submodules?: { path: string; initialized: boolean }[];
  /** Tree decorations: exact git kind per root-relative path (files AND the
   * `!!`-collapsed ignored dirs). */
  gitKinds?: Map<string, GitKind>;
  /** Dir tint: the worst non-ignored descendant kind (VS Code-style — a
   * folder inherits its dirtiest child's color). */
  gitDirAgg?: Map<string, Exclude<GitKind, 'IGN'>>;
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
  /** Changes-row click-through: open THIS FILE's stageable diff in the git
   * surface's Changes page (design B — diffs live there now). */
  onOpenChanges?: (root: string, path?: string) => void;
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
      <div class="code-side-hd"><span>files</span><button id="tree-fold" class="code-tool" title="expand all folders">▸ all</button></div>
      <div class="code-root" id="code-root">
        <button id="root-up" title="up one level">↑</button>
        <button id="root-home" title="back to the pane's cwd">⌂</button>
        <button id="root-repo" title="git repo root">⎇</button>
        <span id="code-root-path"></span>
      </div>
      <div class="code-search">
        <input id="code-search-input" placeholder="search this root (2+ chars)…" spellcheck="false">
        <button id="code-search-mode" class="code-tool" title="toggle: match file names / match file contents">name</button>
      </div>
      <div class="code-hits" id="code-hits" style="display:none"></div>
      <div class="code-tree" id="code-tree"></div>
    </div>
    <div class="code-main">
      <div class="code-hd"><span id="code-path">no file open</span><button id="code-md" class="pkgs-btn" title="markdown preview (rendered + sanitized)">Prev</button><button id="code-history" class="pkgs-btn" title="file history in the git graph">Hist</button><button id="code-blame" class="pkgs-btn" title="git blame gutter (needs a saved file)">Blame</button><span id="code-hint" title="⌘P open · ⌘S save · ⌘. fix · F12 def · F2 rename · esc/⌘E close">⌘P open · ⌘S save · ⌘. fix · F12 def · F2 rename · esc/⌘E close</span></div>
      <div class="code-bufs" id="code-bufs"></div>
      <div class="code-editor" id="code-editor"></div>
      <div class="code-mdpreview" id="code-mdpreview"></div>
      <div class="code-viewer" id="code-viewer"></div>
      <div class="code-ph" id="code-ph"></div>
    </div>`;
  document.body.appendChild(panel);

  const treeEl = panel.querySelector('#code-tree') as HTMLElement;
  const hitsEl = panel.querySelector('#code-hits') as HTMLElement;
  const foldBtn = panel.querySelector('#tree-fold') as HTMLButtonElement;
  const searchInput = panel.querySelector('#code-search-input') as HTMLInputElement;
  const searchModeBtn = panel.querySelector('#code-search-mode') as HTMLButtonElement;
  const changesEl = panel.querySelector('#code-changes') as HTMLElement;
  const rootEl = panel.querySelector('#code-root') as HTMLElement;
  const rootPathEl = panel.querySelector('#code-root-path') as HTMLElement;
  const pathEl = panel.querySelector('#code-path') as HTMLElement;
  const bufsEl = panel.querySelector('#code-bufs') as HTMLElement;
  const editorParent = panel.querySelector('#code-editor') as HTMLElement;
  const viewerEl = panel.querySelector('#code-viewer') as HTMLElement;
  const phEl = panel.querySelector('#code-ph') as HTMLElement;
  const mdpEl = panel.querySelector('#code-mdpreview') as HTMLElement;
  mdpEl.style.display = 'none';

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

  // The Tauri WKWebView is flaky on native copy/paste (the same webview
  // family that made clipboard.ts necessary for terminal selections) — route
  // the panel's editor copy/paste through explicit clipboard APIs with the
  // textarea fallback instead of trusting the native path. Browsers keep
  // their own (working) pipeline untouched — AND get no handler here, because
  // CodeMirror ALSO listens for paste on its content DOM: a second, naive
  // handler double-inserts (Chromium e2e caught this). In Tauri we run on
  // CAPTURE and stopPropagation so exactly one inserter survives: ours.
  const isTauriWebview = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauriWebview) {
    panel.addEventListener('copy', (e) => {
      const sel = window.getSelection()?.toString() ?? '';
      if (!sel) return; // empty selection: nothing to steal the event for
      e.clipboardData?.setData('text/plain', sel);
      e.preventDefault();
      void copyText(sel);
    });
    panel.addEventListener(
      'paste',
      (e) => {
        if (!editor?.hasFocus) return; // inputs (search/rename) keep native paste
        e.preventDefault();
        e.stopPropagation(); // lock CodeMirror's own paste listener out
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (text) {
          editor.dispatch(editor.state.replaceSelection(text));
          return;
        }
        // A locked-down WK build hands us an EMPTY clipboardData even on a
        // user-gesture paste — fall back to the async API before failing loud.
        void navigator.clipboard
          .readText()
          .then((t) => {
            if (t && editor) editor.dispatch(editor.state.replaceSelection(t));
          })
          .catch(() => flashHint('paste unavailable — the webview clipboard is locked'));
      },
      true,
    );
  }

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
      s = { pane: p, root, path: null, buffers: new Map(), expanded: new Set() };
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
    mdBtn.style.display = b && b.kind === 'text' && /\.(md|markdown)$/i.test(current?.path ?? '') ? '' : 'none';
    mdBtn.classList.toggle('on', !!(b && b.kind === 'text' && b.mdPreview));
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

  // ---- markdown preview ---------------------------------------------------------
  const mdBtn = panel.querySelector('#code-md') as HTMLButtonElement;
  mdBtn.addEventListener('click', () => {
    const b = curBuf();
    if (!b || b.kind !== 'text') return;
    b.mdPreview = !b.mdPreview;
    applyMdPreview();
  });

  /** Show the preview (or the editor) to match the current buffer's flag. */
  function applyMdPreview() {
    const b = curBuf();
    const on = !!(b && b.kind === 'text' && b.mdPreview);
    if (!on || !b || b.kind !== 'text') {
      mdpEl.style.display = 'none';
      if (b && b.kind === 'text') editorParent.style.display = '';
      renderBlameBtn();
      return;
    }
    editorParent.style.display = 'none';
    viewerEl.style.display = 'none';
    phEl.style.display = '';
    mdpEl.style.display = '';
    renderBlameBtn();
    void renderMdPreview();
  }

  async function renderMdPreview() {
    const s = current;
    const b = curBuf();
    if (!s || !s.path || !b || b.kind !== 'text' || !editor) return;
    const myPath = s.path;
    const frag = mdRenderSanitized(editor.state.doc.toString());
    if (current !== s || s.path !== myPath) return;
    const base = (s.root ?? s.fsRoot ?? '').replace(/\/+$/, '');
    if (!base) {
      mdpEl.textContent = 'root not resolved yet — try again';
      return;
    }
    const dir = myPath.includes('/') ? myPath.slice(0, myPath.lastIndexOf('/')) : '';
    const urlFor = (p: string) =>
      `${apiBase()}/fs/raw?${paneQ(s.pane)}${rootQ(s.root)}path=${encodeURIComponent(dir ? `${dir}/${p}` : p)}`;
    // Relative resources load through the daemon (safe_path-confined);
    // absolute-path and other-scheme references are dropped outright.
    frag.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      if (/^https:\/\//.test(src)) {
        img.setAttribute('loading', 'lazy');
      } else if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('//')) {
        img.setAttribute('src', urlFor(src));
      } else {
        img.remove();
      }
    });
    frag.querySelectorAll('a').forEach((a) => {
      const h = a.getAttribute('href') ?? '';
      if (/^https?:\/\//.test(h) || h.startsWith('#')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else if (h && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('/') && !h.startsWith('//')) {
        a.setAttribute('href', urlFor(h));
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.removeAttribute('href');
        a.removeAttribute('target');
      }
    });
    mdpEl.replaceChildren();
    mdpEl.appendChild(frag);
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

  /** ⌘+click path-jump inside the editor: hold the modifier and path-ish
   * tokens gain an underline; clicking resolves the token against the session
   * root and opens the file (or hops root to the directory). Same resolver as
   * the ⌘P path row — one answer to "what does this token point at". */
  const jumpLinkExt: Extension = (() => {
    const mark = Decoration.mark({ class: 'cm-jumplink' });
    class JumpLink {
      decorations: DecorationSet = Decoration.none;
      from = -1;
      to = -1;
      constructor(private view: EditorView) {}
      private repaint() {
        // Decorations re-read on view updates only — nudge one (no-op) so the
        // underline flips exactly when the modifier does.
        this.view.dispatch({});
      }
      setRange(from: number, to: number) {
        if (from === this.from && to === this.to) return;
        this.from = from;
        this.to = to;
        this.decorations = from < 0 ? Decoration.none : Decoration.set([mark.range(from, to)]);
        this.repaint();
      }
      tokenAt(x: number, y: number): { from: number; to: number; text: string } | null {
        const pos = this.view.posAtCoords({ x, y });
        if (pos == null) return null;
        const line = this.view.state.doc.lineAt(pos);
        const text = line.text;
        const off = pos - line.from;
        const isTok = (ch: string) => /[\w.~+-]/.test(ch) || ch === '/';
        let a = off;
        let b = off;
        while (a > 0 && isTok(text[a - 1])) a--;
        while (b < text.length && isTok(text[b])) b++;
        // A trailing :line[:col] rides along (compiler-error style clicks).
        const m = text.slice(b).match(/^:(\d+)(?::(\d+))?/);
        const end = b + (m ? m[0].length : 0);
        const tok = text.slice(a, end);
        // Must look like a path (slash) or a file (extension) — plain words
        // like "return" never underline, so code reading stays un-noised.
        if (!tok.includes('/') && !/\.[A-Za-z0-9]+/.test(tok)) return null;
        return { from: line.from + a, to: line.from + end, text: tok };
      }
    }
    return ViewPlugin.fromClass(JumpLink, {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousemove(this: JumpLink, e: MouseEvent) {
          if (!modOf(e)) {
            this.setRange(-1, -1);
            return;
          }
          const t = this.tokenAt(e.clientX, e.clientY);
          this.setRange(t ? t.from : -1, t ? t.to : -1);
        },
        mousedown(this: JumpLink, e: MouseEvent) {
          if (e.button !== 0 || !modOf(e)) return;
          const t = this.tokenAt(e.clientX, e.clientY);
          if (!t) return;
          e.preventDefault(); // no selection change, no focus dance — just jump
          void jumpToPath(t.text);
        },
        mouseleave(this: JumpLink) {
          this.setRange(-1, -1);
        },
      },
    });
  })();

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
        jumpLinkExt,
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
            // Live markdown preview: debounced re-render of the same buffer.
            if (buf?.kind === 'text' && buf.mdPreview) {
              setTimeout(() => {
                const b2 = curBuf();
                if (current?.path === path && b2?.kind === 'text' && b2.mdPreview) void renderMdPreview();
              }, 400);
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
    viewerEl.style.display = 'none';
    phEl.style.display = '';
    applyMdPreview();
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
    mdpEl.style.display = 'none';
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
    mdpEl.style.display = 'none';
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
      void loadChanges(); // the write flips porcelain state — badges + tree colors
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

  /** The git decoration class for one tree row (empty string when clean or
   * outside a repo). Dirs tint by their dirtiest descendant; `!!`-collapsed
   * ignored dirs and ignored files dim. */
  function gitClassFor(p: string, dir: boolean): string {
    const s = current;
    if (!s) return '';
    const paint = (k: GitKind | undefined) =>
      k === 'IGN' ? ' git-ign' : k ? ` git-${k === 'R' ? 'm' : k.toLowerCase()}` : '';
    if (!dir) return paint(s.gitKinds?.get(p));
    const exact = s.gitKinds?.get(p);
    if (exact === 'IGN') return ' git-ign';
    const agg = s.gitDirAgg?.get(p);
    if (exact && (!agg || GIT_PRIO[exact] > GIT_PRIO[agg])) return paint(exact);
    return paint(agg);
  }

  /** Repaint every row's git decoration from the session cache (post-fetch,
   * post-rebuild) — cheap enough to run at every state refresh. */
  function decorateTree() {
    for (const row of treeEl.querySelectorAll<HTMLElement>('.trow')) {
      row.classList.remove('git-u', 'git-a', 'git-m', 'git-d', 'git-ign');
      const p = row.dataset.path;
      if (p) row.className += gitClassFor(p, row.classList.contains('tdir'));
    }
  }

  // ---- tree context menu (VS Code: right-click a tree row) -------------------

  /** One menu at a time; any outside interaction dismisses it. Reuses the
   * git-menu classes — same glassy look, zero forked CSS. */
  let treeMenu: HTMLElement | null = null;
  const closeTreeMenu = () => {
    treeMenu?.remove();
    treeMenu = null;
  };
  window.addEventListener(
    'mousedown',
    (e) => {
      if (treeMenu && !treeMenu.contains(e.target as Node)) closeTreeMenu();
    },
    true,
  );
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTreeMenu();
  });

  /** Copy-path actions for a root-relative tree row. The absolute form needs
   * the session's effective root (lazy: fetched on first demand). */
  function openTreeMenu(x: number, y: number, path: string) {
    closeTreeMenu();
    const s = current;
    if (!s) return;
    const menu = document.createElement('div');
    menu.className = 'git-menu';
    const item = (label: string, fn: () => Promise<void>) => {
      const it = document.createElement('button');
      it.className = 'git-menu-item';
      it.textContent = label;
      it.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeTreeMenu();
        await fn();
      });
      return it;
    };
    const say = async (text: string) => {
      if (await copyText(text)) flashHint(`copied ${text}`);
      else flashHint('copy failed — the webview clipboard is locked');
    };
    menu.appendChild(
      item('Copy Relative Path', async () => {
        await say(path || '.');
      }),
    );
    menu.appendChild(
      item('Copy Absolute Path', async () => {
        if (!s.fsRoot) {
          const r = await paneRoot(apiBase(), s.pane);
          if (r) s.fsRoot = r;
        }
        const root = s.fsRoot?.replace(/\/+$/, '');
        if (!root) {
          flashHint('pane cwd unknown — no absolute path');
          return;
        }
        await say(path ? `${root}/${path}` : root);
      }),
    );
    document.body.appendChild(menu);
    // Clamp into the window, VS Code-style.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, Math.max(4, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.min(y, Math.max(4, innerHeight - r.height - 4))}px`;
    treeMenu = menu;
  }

  function treeItem(path: string, name: string, dir: boolean, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'trow' + (dir ? ' tdir' : ' tfile');
    row.dataset.path = path; // decorateTree() keys off this
    row.className += gitClassFor(path, dir);
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTreeMenu(e.clientX, e.clientY, path);
    });
    wrap.appendChild(row);

    if (dir) {
      const kids = document.createElement('div');
      wrap.appendChild(kids);
      let loaded = false;
      let expanded = current?.expanded.has(path) ?? false;
      const paint = () => {
        row.textContent = (expanded ? '▾ ' : '▸ ') + name;
        kids.style.display = expanded ? '' : 'none';
      };
      paint();
      const renderKids = async () => {
        kids.replaceChildren(treeStat('…', depth + 1));
        const pane = current?.pane ?? null;
        const sroot = current?.root ?? null;
        let entries: FsEntry[];
        try {
          entries = await fsList(pane, path, sroot);
        } catch (e) {
          kids.replaceChildren(treeStat(`⚠ ${fsErrText(e)}`, depth + 1, () => void renderKids()));
          return;
        }
        kids.replaceChildren();
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
        // The session's set is the source of truth the NEXT tree build reads —
        // closing and reopening the panel no longer loses your place.
        const mem = current?.expanded;
        if (mem) {
          if (expanded) mem.add(path);
          else mem.delete(path);
        }
        paint();
        if (expanded && !loaded) {
          loaded = true;
          await renderKids();
        }
      });
      // A dir the session remembers as open renders open right away (and its
      // remembered-open descendants cascade once their rows fetch in).
      if (expanded) {
        loaded = true;
        void renderKids();
      }
    } else {
      row.textContent = name;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void openFile(path);
      });
    }
    return wrap;
  }

  /** Status row for the tree: '…' while loading, an error with click-to-
   * retry on failure — a slow remote or a daemon error must never read as a
   * blank, broken tree. */
  function treeStat(text: string, depth: number, onRetry?: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'trow tstat' + (onRetry ? ' retry' : '');
    row.textContent = text;
    row.style.paddingLeft = `${depth * 12 + 8}px`;
    if (onRetry) {
      row.title = 'click to retry';
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        onRetry();
      });
    }
    return row;
  }

  const fsErrText = (e: unknown) => {
    const st = (e as { status?: number }).status;
    if (st === 403) return 'path not allowed (403)';
    if (st === 404) return 'missing or unreadable (404)';
    return st ? `list failed (${st})` : 'daemon unreachable (restarting?)';
  };

  /** A failed root listing retries itself a few times — a daemon mid-restart
   * (e.g. the app's zero-touch update right after you upgrade it) is back
   * within seconds, and making the user click to discover that was just
   * spooky. Manual click-to-retry remains after the retries run out. */
  let treeRetryTimer: number | undefined;
  let treeFailCount = 0;
  const TREE_RETRY_MAX = 4;

  async function loadTree() {
    const s = current;
    void refreshSubmodules(s);
    // Sync the fold button from the session set UP FRONT: remembered dirs
    // render expanded from the kept/preserved rows instantly, so a mid-fetch
    // button label must already agree with what the user sees.
    syncFoldBtn();
    // Keep the old tree up during a REFRESH (post-save, post-git-op): a blank
    // flash reads as breakage on a slow link. Placeholder only when empty.
    if (!treeEl.childElementCount) treeEl.replaceChildren(treeStat('loading…', 0));
    let items: FsEntry[];
    try {
      items = await fsList(s?.pane ?? null, '', s?.root ?? null);
    } catch (e) {
      if (current !== s) return;
      treeFailCount += 1;
      if (treeFailCount <= TREE_RETRY_MAX) {
        treeEl.replaceChildren(treeStat(`⚠ ${fsErrText(e)} — retry ${treeFailCount}/${TREE_RETRY_MAX} in 2.5s…`, 0));
        window.clearTimeout(treeRetryTimer);
        treeRetryTimer = window.setTimeout(() => {
          if (current === s) void loadTree();
        }, 2500);
      } else {
        treeFailCount = 0;
        treeEl.replaceChildren(treeStat(`⚠ ${fsErrText(e)}`, 0, () => void loadTree()));
      }
      return;
    }
    if (current !== s) return; // switched panes mid-fetch
    treeFailCount = 0;
    window.clearTimeout(treeRetryTimer);
    treeEl.replaceChildren();
    if (!items.length) treeEl.appendChild(treeStat('(empty directory)', 0));
    for (const c of items) treeEl.appendChild(treeItem(c.name, c.name, c.dir, 0));
    syncFoldBtn();
    decorateTree(); // rows were rebuilt — bring the git colors back
  }

  // ---- expand/collapse-all + search -----------------------------------------

  /** Dependency/build forests the walker never enters (matches the daemon's
   * /fs/search skip list — expanding greendale is never the intent either). */
  const TREE_SKIP = new Set([
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'target',
    'dist',
    'build',
    '__pycache__',
    '.venv',
  ]);
  const EXPAND_CAP = 500;

  function syncFoldBtn() {
    const any = (current?.expanded.size ?? 0) > 0;
    foldBtn.textContent = any ? '▾ all' : '▸ all';
    foldBtn.title = any ? 'collapse all folders' : 'expand all folders';
  }

  foldBtn.addEventListener('click', async () => {
    const s = current;
    if (!s) return;
    if (s.expanded.size) {
      s.expanded.clear();
      await loadTree();
      return;
    }
    // Expand-all: BFS the root collecting every dir (capped, forests skipped),
    // then let the normal rebuild render it — the session set IS the state.
    foldBtn.disabled = true;
    foldBtn.textContent = '…';
    try {
      let frontier = [''];
      while (frontier.length && s.expanded.size < EXPAND_CAP) {
        const batch = frontier.splice(0, 8); // modest parallelism, shell-friendly
        let lists: FsEntry[][];
        try {
          lists = await Promise.all(batch.map((d) => fsList(s.pane, d, s.root)));
        } catch {
          break; // a dir died mid-walk — keep whatever we already collected
        }
        if (current !== s) return; // root hopped mid-walk
        for (let i = 0; i < batch.length; i++) {
          for (const e of lists[i]) {
            if (!e.dir || TREE_SKIP.has(e.name) || s.expanded.size >= EXPAND_CAP) continue;
            const p = batch[i] ? `${batch[i]}/${e.name}` : e.name;
            if (!s.expanded.has(p)) {
              s.expanded.add(p);
              frontier.push(p);
            }
          }
        }
      }
    } finally {
      foldBtn.disabled = false;
    }
    await loadTree();
  });

  interface SearchHit {
    path: string;
    line?: number;
    text?: string;
  }
  let searchTimer: number | undefined;
  let searchSeq = 0;

  function hideHits() {
    hitsEl.style.display = 'none';
    treeEl.style.display = '';
  }

  /** A session/root swap invalidates the query (hits are root-relative). */
  function resetSearch() {
    searchInput.value = '';
    searchSeq++;
    hideHits();
  }

  function renderHits(hits: SearchHit[], content: boolean) {
    hitsEl.replaceChildren();
    for (const h of hits.slice(0, 100)) {
      const row = document.createElement('div');
      row.className = 'trow chit';
      if (content) {
        const head = document.createElement('span');
        head.className = 'chit-path';
        head.textContent = `${h.path}:${h.line}`;
        const snip = document.createElement('span');
        snip.className = 'chit-text';
        snip.textContent = h.text ?? '';
        row.append(head, snip);
        row.addEventListener('click', () => void openFileAt(h.path, h.line ?? 1));
      } else {
        row.textContent = h.path;
        row.addEventListener('click', () => void openFile(h.path));
      }
      hitsEl.appendChild(row);
    }
    if (!hits.length) {
      const d = document.createElement('div');
      d.className = 'chit-empty';
      d.textContent = 'no matches';
      hitsEl.appendChild(d);
    } else if (hits.length > 100) {
      const d = document.createElement('div');
      d.className = 'chit-empty';
      d.textContent = `…${hits.length - 100} more (daemon cap)`;
      hitsEl.appendChild(d);
    }
    treeEl.style.display = 'none';
    hitsEl.style.display = '';
  }

  async function runSearch() {
    const s = current;
    const q = searchInput.value.trim();
    if (!s || q.length < 2) {
      hideHits();
      return;
    }
    const content = searchModeBtn.dataset.mode === 'content';
    const seq = ++searchSeq;
    try {
      const r = await fetch(
        `${apiBase()}/fs/search?${paneQ(s.pane)}${rootQ(s.root)}q=${encodeURIComponent(q)}&mode=${content ? 'content' : 'name'}`,
      );
      if (seq !== searchSeq || current !== s) return; // a newer query/root won
      if (!r.ok) {
        // An old daemon (no /fs/search) must not masquerade as "no matches".
        if (r.status === 404) flashHint('search needs a newer daemon — update from the host card');
        renderHits([], content);
        return;
      }
      const hits = (await r.json()) as SearchHit[];
      renderHits(hits, content);
    } catch {
      /* daemon unreachable — leave the tree be */
    }
  }

  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      (hitsEl.querySelector('.chit') as HTMLElement | null)?.click();
    }
  });
  searchModeBtn.addEventListener('click', () => {
    const content = searchModeBtn.dataset.mode === 'content';
    searchModeBtn.dataset.mode = content ? 'name' : 'content';
    searchModeBtn.textContent = content ? 'name' : 'content';
    void runSearch();
  });

  /** Open a file and land the cursor on a line (content-search click-through). */
  async function openFileAt(path: string, line: number) {
    await openFile(path);
    if (!editor || current?.path !== path) return;
    const l = Math.max(1, Math.min(line, editor.state.doc.lines));
    const pos = editor.state.doc.line(l).from;
    editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    editor.focus();
  }

  /** Jump to a typed/clicked path: absolute or root-relative, file (optionally
   * with a :line suffix) or directory. Files under the current root open
   * directly; anything else hops the panel's root to the parent first — the
   * same resolve for the ⌘P path row and editor ⌘+click, so they can't
   * disagree about what a token means. '~' stays unsupported on purpose:
   * whose home, the pane's or the daemon's, is a question nobody wants to
   * answer mid-gesture. */
  async function jumpToPath(raw: string) {
    const s = current;
    if (!s) return;
    const parsed = parseToken(raw);
    if (!parsed) return;
    if (parsed.path.includes('~')) {
      flashHint('~ paths are not supported — use an absolute path');
      return;
    }
    if (!s.fsRoot) {
      const r = await paneRoot(apiBase(), s.pane);
      if (r) s.fsRoot = r;
    }
    if (!s.fsRoot) {
      flashHint('no root to resolve against');
      return;
    }
    const target = await resolvePath(apiBase(), s.fsRoot, parsed.path);
    if (current !== s) return;
    if (!target) {
      flashHint(`no such path: ${parsed.path}`);
      return;
    }
    if (target.dir) {
      switchRoot(target.abs);
      return;
    }
    const root = s.fsRoot.replace(/\/+$/, '');
    if (target.abs.startsWith(`${root}/`)) {
      const rel = target.abs.slice(root.length + 1);
      if (parsed.line != null) void openFileAt(rel, parsed.line);
      else void openFile(rel);
    } else {
      // Outside the current root: hop the session to the parent dir, then
      // open the file there (same override rules as the root switcher).
      const parent = parentOf(target.abs);
      switchRoot(parent);
      const rel = baseOf(target.abs);
      if (parsed.line != null) void openFileAt(rel, parsed.line);
      else void openFile(rel);
    }
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
    // One fetch feeds BOTH the changes list and the tree decorations — the
    // two never disagree about what git sees.
    const files = await gitStatus(s?.pane ?? null, s?.root ?? null, true);
    if (current !== s) return;

    // Decoration maps, root-relative (status paths are prefix-relative too,
    // so keys match the tree rows directly; ../ rows live outside the view).
    const kinds = new Map<string, GitKind>();
    const dirAgg = new Map<string, Exclude<GitKind, 'IGN'>>();
    for (const f of files) {
      const k = gitKindOf(f.status);
      if (!k || f.path.startsWith('../') || f.path === '..' || f.path.startsWith('/')) continue;
      const p = f.path.replace(/\/+$/, ''); // ignored dirs arrive "dir/"
      if (k === 'IGN') {
        if (!kinds.has(p)) kinds.set(p, k); // never shadows a real status
        continue;
      }
      const prev = kinds.get(p);
      if (!prev || prev === 'IGN' || GIT_PRIO[k] > GIT_PRIO[prev]) kinds.set(p, k);
      // Ancestors inherit the worst descendant (ignored never propagates).
      let slash = p.indexOf('/');
      while (slash > 0) {
        const dir = p.slice(0, slash);
        const acc = dirAgg.get(dir);
        if (!acc || GIT_PRIO[k] > GIT_PRIO[acc]) dirAgg.set(dir, k);
        slash = p.indexOf('/', slash + 1);
      }
    }
    if (s) {
      s.gitKinds = kinds;
      s.gitDirAgg = dirAgg;
    }
    decorateTree();

    changesEl.replaceChildren();
    const visible = files.filter((f) => gitKindOf(f.status) !== 'IGN');
    if (!visible.length) {
      changesEl.textContent = 'clean';
      return;
    }
    for (const f of visible) {
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
        // Design B: all diff/staging work lives in the git surface — the row
        // is a deep LINK (opens this file's stageable diff there).
        row.title = 'open in the Git surface (stageable diff)';
        row.addEventListener('click', () => {
          if (!opts.onOpenChanges || !s) return;
          const sess = s;
          void repoPathFor(sess, f.path).then((rp) => {
            if (rp) opts.onOpenChanges!(rp.top, rp.rel);
          });
        });
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
    // Any pending loadTree auto-retry belongs to the outgoing session.
    window.clearTimeout(treeRetryTimer);
    treeFailCount = 0;
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
    resetSearch(); // hits are root-relative; a pane/root swap invalidates them
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
  qoEl.innerHTML = `<input class="qopen-input" placeholder="Open file… (a slash makes it a raw path)" spellcheck="false"><div class="qopen-list"></div>`;
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

  /** Typed paths (not fuzzy names) get a dedicated row: starts with '/' or
   * './'/'../', or contains any slash — "./a", "../b", "/etc/…" all qualify. */
  const PATHY = /^\/|^\.{1,2}\/|\//;
  const isPathy = (q: string) => PATHY.test(q);

  function renderQo() {
    qoList.replaceChildren();
    const q = qoInput.value.trim();
    if (isPathy(q)) {
      const row = document.createElement('div');
      row.className = 'qopen-row sel qopen-path';
      const base = current?.fsRoot ?? '';
      row.textContent = q.startsWith('/') ? `↪ ${q}` : `↪ ${normalizeAbs(`${base}/${q}`)}`;
      row.title = 'open this file or switch root to this directory';
      row.addEventListener('click', () => {
        closeQuickOpen();
        void jumpToPath(q);
      });
      qoList.appendChild(row);
      return;
    }
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
      empty.textContent = qoAll.length ? 'no match (a slash makes it a raw path)' : 'not a git repo (or no files)';
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

  // ⌘P's file index lives per (host, pane, root): opening repaints from the
  // cached walk first — a full /git/files walk over SSH on every open was
  // the heavy part — and only a missing or stale (60s) index refreshes,
  // in the background unless this is the very first walk.
  interface QoIndex {
    files: string[];
    at: number;
  }
  const qoIndexCache = new Map<string, QoIndex>();

  async function quickOpen() {
    qoVisible = true;
    qoEl.style.display = '';
    qoInput.value = '';
    qoSel = 0;
    qoShown = [];
    renderQo();
    qoInput.focus();
    const pane = current?.pane ?? null;
    const root = current?.root ?? null;
    const key = `${opts.getScope()}:${pane ?? -1}|${root ?? ''}`;
    const cached = qoIndexCache.get(key);
    if (cached) {
      qoAll = cached.files;
      qoShown = fuzzy('', qoAll);
      renderQo();
      if (Date.now() - cached.at < 60_000) return;
    }
    const files = await gitFiles(pane, root);
    qoIndexCache.set(key, { files, at: Date.now() });
    if (!qoVisible) return;
    qoAll = files;
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
    } else if (e.key === 'Enter') {
      const q = qoInput.value.trim();
      if (isPathy(q)) {
        closeQuickOpen();
        void jumpToPath(q);
      } else if (qoShown[qoSel]) {
        pickQo(qoShown[qoSel]);
      }
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
      // An active search query clears before the panel itself closes.
      if (searchInput.value) {
        resetSearch();
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
    langFor: (path: string) => [langFor(path)],
    openAt(root: string, path: string, line?: number) {
      if (!open) {
        open = true;
        panel.classList.add('show');
      }
      showSession(opts.getActivePane(), root);
      if (line != null) void openFileAt(path, line);
      else void openFile(path);
    },
    openRoot(root: string) {
      if (!open) {
        open = true;
        panel.classList.add('show');
      }
      showSession(opts.getActivePane(), root);
    },
    hostSwitched(pane: number | null) {
      if (!open) return;
      showSession(pane);
    },
    refresh() {
      if (!open || !current) return;
      void loadTree();
      if (current.path) void openFile(current.path);
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
