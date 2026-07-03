// Thin seam around @codemirror/lsp-client — the ONLY file that touches the
// library, so a future editor/client swap is contained (see docs/LSP-PLAN.md:
// transport and daemon speak raw standard LSP and survive any swap; only
// editor bindings are library-specific).

import { Extension } from '@codemirror/state';
import { LSPClient, languageServerExtensions, Transport } from '@codemirror/lsp-client';

interface LspInfo {
  available: boolean;
  reason?: string;
  root?: string;
  fs_root?: string;
}

// One client (= one WS = one language server) per (daemon, workspace root).
const conns = new Map<string, LSPClient>();

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

const langOf = (path: string) => (path.endsWith('.rs') ? 'rust' : null);

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
      });
      const wsUrl = `${apiBase.replace(/^http/, 'ws')}/lsp?${paneQ}lang=${lang}`;
      client.connect(wsTransport(wsUrl, () => conns.delete(key)));
      conns.set(key, client);
    }
    // Relative paths resolve against the pane's cwd (fs_root), which may sit
    // below the language server's workspace root.
    const uri = encodeURI(`file://${info.fs_root}/${relPath}`);
    return client.plugin(uri, lang);
  } catch {
    return null;
  }
}
