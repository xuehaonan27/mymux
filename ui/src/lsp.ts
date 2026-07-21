// Thin seam around @codemirror/lsp-client — the ONLY file that touches the
// library, so a future editor/client swap is contained (see docs/LSP-PLAN.md:
// transport and daemon speak raw standard LSP and survive any swap; only
// editor bindings are library-specific).

import { Extension, Text } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { setDiagnostics, Diagnostic } from '@codemirror/lint';
import {
  LSPClient,
  LSPPlugin,
  languageServerExtensions,
  Transport,
  Workspace,
  WorkspaceFile,
} from '@codemirror/lsp-client';

interface LspInfo {
  available: boolean;
  reason?: string;
  installable?: boolean;
  root?: string;
  fs_root?: string;
}

// One client (= one WS = one language server) per (daemon, language,
// workspace root) — the language dimension matters: two languages resolving
// to the same root must NOT cross-wire to the first server (P1-08). A dropped
// socket reconnects IN PLACE with backoff — the same LSPClient object
// re-initializes, so buffers already holding its plugin heal instead of
// stranding on a dead transport (P1-09).
interface Conn {
  client: LSPClient;
  attempts: number;
  timer?: number;
}
const conns = new Map<string, Conn>();

/** (Re)connect the client over a fresh socket; on drop, schedule the next
 * attempt with exponential backoff (capped). `disconnect()` resets
 * `initializing`, and the library's `workspace.connected()` re-opens every
 * file with its full current doc on the new server — no state is lost. */
function connectConn(conn: Conn, wsUrl: string) {
  conn.client.connect(
    wsTransport(wsUrl, () => {
      conn.client.disconnect();
      conn.attempts += 1;
      window.clearTimeout(conn.timer);
      conn.timer = window.setTimeout(
        () => connectConn(conn, wsUrl),
        Math.min(15000, 1000 * 2 ** conn.attempts),
      );
    }),
  );
  void conn.client.initializing.then(
    () => {
      conn.attempts = 0; // healthy again — the next drop starts short
    },
    () => {},
  );
}

// LSP URIs are real URLs: escape EVERY path segment. A bare encodeURI leaks
// '#'/'?' in file names — the server then parses a fragment/query into the
// path and never finds the document.
const fileUri = (abs: string) => `file://${abs.split('/').map(encodeURIComponent).join('/')}`;

// ---- cross-file goto (C2) ---------------------------------------------------
// The library asks Workspace.displayFile(uri) when a jump targets another
// file. Our workspace delegates to the code panel's multi-buffer openFile via
// this injected opener (absolute path in, the editor view out — or null when
// the target can't be shown, e.g. outside the panel's root).
let fileOpener: ((absPath: string) => Promise<EditorView | null>) | null = null;
export function setLspFileOpener(fn: (absPath: string) => Promise<EditorView | null>) {
  fileOpener = fn;
}

/** The library's DefaultWorkspace isn't exported; this is its (small)
 * behavior plus a displayFile that routes through the code panel. */
class MymuxWorkspaceFile implements WorkspaceFile {
  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView,
  ) {}
  getView() {
    return this.view;
  }
}

class MymuxWorkspace extends Workspace {
  files: MymuxWorkspaceFile[] = [];
  private versions = new Map<string, number>();

  private nextVersion(uri: string): number {
    const v = (this.versions.get(uri) ?? -1) + 1;
    this.versions.set(uri, v);
    return v;
  }

  syncFiles() {
    const result = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        result.push({ changes, file, prevDoc: file.doc });
        file.doc = file.view.state.doc;
        file.version = this.nextVersion(file.uri);
        plugin.clear();
      }
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    if (this.getFile(uri)) return; // one view per file in our panel
    const f = new MymuxWorkspaceFile(uri, languageId, this.nextVersion(uri), view.state.doc, view);
    this.files.push(f);
    this.client.didOpen(f);
  }

  closeFile(uri: string) {
    const f = this.getFile(uri);
    if (f) {
      this.files = this.files.filter((x) => x !== f);
      this.client.didClose(uri);
    }
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const open = this.getFile(uri)?.getView();
    if (open) return open;
    if (!uri.startsWith('file://') || !fileOpener) return null;
    // Inverse of fileUri: per-segment decode (a global decodeURI would mangle
    // %23-encoded '#' names and choke on a stray '%').
    return fileOpener(
      uri
        .slice('file://'.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/'),
    );
  }
}

// ---- code actions (C2) ------------------------------------------------------
// The library ships no code-action support. We advertise literal+resolve
// capabilities (without them rust-analyzer only returns command-style actions
// whose workspace/applyEdit callback the lib can't receive) and drive the
// request/resolve/apply cycle ourselves.

const codeActionCaps = {
  clientCapabilities: {
    textDocument: {
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] },
        },
        resolveSupport: { properties: ['edit'] },
      },
    },
  },
};

interface LspTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: {
    changes?: Record<string, LspTextEdit[]>;
    documentChanges?: Array<{ textDocument?: { uri: string }; edits?: LspTextEdit[] }>;
  };
  command?: unknown;
  data?: unknown;
}

export interface CodeActionItem {
  title: string;
  kind: string;
  /** Applies the action; resolves to an error message or null on success. */
  apply(): Promise<string | null>;
}

function editsByUri(a: LspCodeAction): Map<string, LspTextEdit[]> {
  const m = new Map<string, LspTextEdit[]>();
  for (const [uri, edits] of Object.entries(a.edit?.changes ?? {})) m.set(uri, edits);
  for (const dc of a.edit?.documentChanges ?? []) {
    if (dc.textDocument?.uri && dc.edits) {
      m.set(dc.textDocument.uri, [...(m.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    }
  }
  return m;
}

/** Quick fixes / refactors at the current selection (⌘. in the code panel). */
export async function requestCodeActions(view: EditorView): Promise<CodeActionItem[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  await plugin.client.initializing;
  plugin.client.sync();
  const sel = view.state.selection.main;
  let actions: LspCodeAction[] | null;
  try {
    actions = await plugin.client.request<unknown, LspCodeAction[] | null>(
      'textDocument/codeAction',
      {
        textDocument: { uri: plugin.uri },
        range: { start: plugin.toPosition(sel.from), end: plugin.toPosition(sel.to) },
        context: { diagnostics: [] },
      },
    );
  } catch {
    return [];
  }
  return (actions ?? [])
    .filter((a) => a && a.title)
    .map((a) => ({
      title: a.title,
      kind: a.kind ?? '',
      apply: () => applyCodeAction(view, a),
    }));
}

async function applyCodeAction(view: EditorView, action: LspCodeAction): Promise<string | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return 'no language client';
  let a = action;
  if (!a.edit && a.data != null) {
    // Lazy action: resolve to get the edit (a client→server request, which
    // works — unlike server→client applyEdit, which the lib rejects).
    try {
      a = await plugin.client.request<unknown, LspCodeAction>('codeAction/resolve', a);
    } catch (e) {
      return `resolve failed: ${e}`;
    }
  }
  const edits = editsByUri(a);
  if (edits.size === 0) {
    return a.command ? 'this action needs server-side execution — not supported yet' : 'no edit';
  }
  const foreign = [...edits.keys()].filter((u) => u !== plugin.uri);
  if (foreign.length) {
    return 'this action touches other files — not supported yet';
  }
  const own = edits.get(plugin.uri) ?? [];
  view.dispatch({
    changes: own.map((e) => ({
      from: plugin.fromPosition(e.range.start),
      to: plugin.fromPosition(e.range.end),
      insert: e.newText,
    })),
  });
  return null;
}

// Extension → LSP language id. Broad on purpose: any of these can be served
// by a dynamically installed server (`mymux-pkg lang <pkg> <lang>`); built-in
// resolution only exists for rust/go/python/c/cpp.
const EXT_LANG: Record<string, string> = {
  rs: 'rust',
  go: 'go',
  py: 'python',
  pyi: 'python',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  sh: 'bash',
  bash: 'bash',
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  lua: 'lua',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  zig: 'zig',
  hs: 'haskell',
  ml: 'ocaml',
  ex: 'elixir',
  exs: 'elixir',
  sql: 'sql',
  tf: 'terraform',
  vue: 'vue',
  svelte: 'svelte',
};

const langOf = (path: string): string | null => {
  const base = path.split('/').pop() ?? path;
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return EXT_LANG[ext] ?? null;
};

/**
 * If this file's language server is missing but a managed install exists
 * (mymux-pkg recipe), return what the UI needs for a one-click install offer.
 */
export async function lspInstallable(
  apiBase: string,
  pane: number | null,
  relPath: string,
): Promise<{ lang: string; reason: string } | null> {
  const lang = langOf(relPath);
  if (!lang) return null;
  try {
    const paneQ = pane != null ? `pane=${pane}&` : '';
    const r = await fetch(`${apiBase}/lsp/info?${paneQ}lang=${lang}`);
    if (!r.ok) return null;
    const info: LspInfo = await r.json();
    if (!info.available && info.installable) {
      return { lang, reason: info.reason ?? 'language server not installed' };
    }
  } catch {
    /* no hint */
  }
  return null;
}

/** Ask the daemon to install the language server (runs mymux-pkg). */
export async function lspInstall(apiBase: string, lang: string): Promise<string | null> {
  try {
    const r = await fetch(`${apiBase}/lsp/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang }),
    });
    const res = (await r.json()) as { ok: boolean; err?: string };
    return res.ok ? null : (res.err ?? 'install failed');
  } catch (e) {
    return String(e);
  }
}

function wsTransport(url: string, onDown: () => void): Transport {
  const handlers = new Set<(value: string) => void>();
  const queue: string[] = [];
  const ws = new WebSocket(url);
  // A drop fires onerror AND onclose — report it once.
  let down = false;
  const fire = () => {
    if (!down) {
      down = true;
      onDown();
    }
  };
  ws.onopen = () => {
    for (const m of queue) ws.send(m);
    queue.length = 0;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') for (const h of handlers) h(ev.data);
  };
  ws.onclose = fire;
  ws.onerror = fire;
  return {
    send(message: string) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(message);
      else throw new Error('lsp connection is closed');
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
  };
}

// The library ADVERTISES LSP 3.17 pull diagnostics (`textDocument.diagnostic`
// in its default capabilities) but implements no puller — so rust-analyzer's
// NATIVE tier (syntax etc.) stops being pushed and needs this plugin to pull:
// on open, debounced on edits, with a warm-up retry while indexing.
//
// The COMPILER tier (cargo check) is separate: it runs on didSave and its
// results arrive as `publishDiagnostics` pushes, which the library's built-in
// serverDiagnostics() handler renders — verified end-to-end. `saved()` below
// is the trigger that was missing (without didSave, flycheck only ever ran
// once at open, so errors edited in later never appeared). The post-save
// re-pull is a small fallback for native-tier refreshes after a save (the
// server's `workspace/diagnostic/refresh` request would tell us when, but the
// lib rejects all server→client requests — seam compensation, absorbed into
// the self-built client's design).
interface PullResult {
  kind: 'full' | 'unchanged';
  items?: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
    message: string;
  }>;
}

const pullPlugin = ViewPlugin.fromClass(
  class {
    private timer: number | undefined;
    private gen = 0;
    private warmupLeft = 20; // ~60s of 3s retries while indexing / empty
    private postSaveLeft = 0;

    constructor(private readonly view: EditorView) {
      this.schedule(300);
    }

    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule(500);
    }

    /** The file was saved: tell the server (standard `textDocument/didSave`,
     * which triggers rust-analyzer's cargo check), then re-pull while the
     * check runs so compiler-tier errors appear without further typing. */
    saved() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin) return;
      try {
        plugin.client.notification('textDocument/didSave', {
          textDocument: { uri: plugin.uri },
        });
      } catch {
        return;
      }
      this.postSaveLeft = 6; // ~15s of re-pulls, plenty for cargo check
      this.schedule(1500);
    }

    private schedule(ms: number) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.pull(), ms);
    }

    private async pull() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin) return;
      const gen = ++this.gen;
      try {
        await plugin.client.initializing;
        plugin.client.sync();
        const res = await plugin.client.request<{ textDocument: { uri: string } }, PullResult>(
          'textDocument/diagnostic',
          { textDocument: { uri: plugin.uri } },
        );
        if (gen !== this.gen) return;
        if (res.kind !== 'unchanged') {
          const items = res.items ?? [];
          const sev = (n?: number): Diagnostic['severity'] =>
            n === 1 ? 'error' : n === 2 ? 'warning' : n === 4 ? 'hint' : 'info';
          const diags: Diagnostic[] = items.map((d) => ({
            from: plugin.fromPosition(d.range.start),
            to: plugin.fromPosition(d.range.end),
            severity: sev(d.severity),
            message: d.message,
          }));
          this.view.dispatch(setDiagnostics(this.view.state, diags));
          if (items.length > 0) this.warmupLeft = 0;
        }
        if (this.postSaveLeft > 0) {
          this.postSaveLeft -= 1;
          this.schedule(2500);
        } else if (this.warmupLeft > 0) {
          // Possibly still indexing — an empty answer now isn't final.
          this.warmupLeft -= 1;
          this.schedule(3000);
        }
      } catch {
        if (gen !== this.gen) return;
        if (this.postSaveLeft > 0) {
          this.postSaveLeft -= 1;
          this.schedule(2500);
        } else if (this.warmupLeft > 0) {
          this.warmupLeft -= 1;
          this.schedule(3000);
        }
      }
    }

    destroy() {
      this.gen += 1;
      window.clearTimeout(this.timer);
    }
  },
);

function pullDiagnostics(): Extension {
  return pullPlugin;
}

/** Hook for the editor's save path: forwards `didSave` to the language server
 * and kicks the post-save diagnostic re-pull. No-op without LSP. */
export function notifySaved(view: EditorView) {
  view.plugin(pullPlugin)?.saved();
}

/**
 * The LSP editor extension for a file (diagnostics, hover, completion, …), or
 * null when the language is unsupported or the server is unavailable — the
 * editor then simply opens without language smarts. `root` is the panel's
 * root-switcher override: the daemon validates it like /fs and resolves the
 * server cwd, the workspace root, and this file's URI from it (P1-06).
 */
export async function lspExtensionFor(
  apiBase: string,
  pane: number | null,
  relPath: string,
  root: string | null = null,
): Promise<Extension | null> {
  const lang = langOf(relPath);
  if (!lang) return null;
  try {
    const paneQ = pane != null ? `pane=${pane}&` : '';
    const rootQ = root ? `root=${encodeURIComponent(root)}&` : '';
    const r = await fetch(`${apiBase}/lsp/info?${paneQ}${rootQ}lang=${lang}`);
    if (!r.ok) return null;
    const info: LspInfo = await r.json();
    if (!info.available || !info.root || !info.fs_root) return null;

    const key = `${apiBase}|${lang}|${info.root}`;
    let conn = conns.get(key);
    if (!conn) {
      const client = new LSPClient({
        rootUri: fileUri(info.root),
        workspace: (c) => new MymuxWorkspace(c),
        extensions: [...languageServerExtensions(), codeActionCaps],
        // rust-analyzer can block requests while indexing a big workspace; the
        // 3s default would spuriously fail the first pulls.
        timeout: 30000,
      });
      conn = { client, attempts: 0 };
      conns.set(key, conn);
      const wsUrl = `${apiBase.replace(/^http/, 'ws')}/lsp?${paneQ}${rootQ}lang=${lang}`;
      connectConn(conn, wsUrl);
    }
    // Relative paths resolve against the effective root (fs_root: the pane
    // cwd, or the validated override), which may sit below the language
    // server's workspace root.
    const uri = fileUri(`${info.fs_root}/${relPath}`);
    return [conn.client.plugin(uri, lang), pullDiagnostics()];
  } catch {
    return null;
  }
}
