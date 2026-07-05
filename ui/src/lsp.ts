// Thin seam around @codemirror/lsp-client — the ONLY file that touches the
// library, so a future editor/client swap is contained (see docs/LSP-PLAN.md:
// transport and daemon speak raw standard LSP and survive any swap; only
// editor bindings are library-specific).

import { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { setDiagnostics, Diagnostic } from '@codemirror/lint';
import { LSPClient, LSPPlugin, languageServerExtensions, Transport } from '@codemirror/lsp-client';

interface LspInfo {
  available: boolean;
  reason?: string;
  installable?: boolean;
  root?: string;
  fs_root?: string;
}

// One client (= one WS = one language server) per (daemon, workspace root).
const conns = new Map<string, LSPClient>();

const langOf = (path: string): string | null => {
  if (path.endsWith('.rs')) return 'rust';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.py')) return 'python';
  if (/\.(c|h)$/.test(path)) return 'c';
  if (/\.(cc|cpp|cxx|hpp|hh)$/.test(path)) return 'cpp';
  return null;
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
  ws.onopen = () => {
    for (const m of queue) ws.send(m);
    queue.length = 0;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') for (const h of handlers) h(ev.data);
  };
  ws.onclose = onDown;
  ws.onerror = onDown;
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
 * editor then simply opens without language smarts.
 */
export async function lspExtensionFor(
  apiBase: string,
  pane: number | null,
  relPath: string,
): Promise<Extension | null> {
  const lang = langOf(relPath);
  if (!lang) return null;
  try {
    const paneQ = pane != null ? `pane=${pane}&` : '';
    const r = await fetch(`${apiBase}/lsp/info?${paneQ}lang=${lang}`);
    if (!r.ok) return null;
    const info: LspInfo = await r.json();
    if (!info.available || !info.root || !info.fs_root) return null;

    const key = `${apiBase}|${info.root}`;
    let client = conns.get(key);
    if (!client) {
      client = new LSPClient({
        rootUri: `file://${info.root}`,
        extensions: languageServerExtensions(),
        // rust-analyzer can block requests while indexing a big workspace; the
        // 3s default would spuriously fail the first pulls.
        timeout: 30000,
      });
      const wsUrl = `${apiBase.replace(/^http/, 'ws')}/lsp?${paneQ}lang=${lang}`;
      client.connect(wsTransport(wsUrl, () => conns.delete(key)));
      conns.set(key, client);
    }
    // Relative paths resolve against the pane's cwd (fs_root), which may sit
    // below the language server's workspace root.
    const uri = encodeURI(`file://${info.fs_root}/${relPath}`);
    return [client.plugin(uri, lang), pullDiagnostics()];
  } catch {
    return null;
  }
}
