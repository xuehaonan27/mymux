import { LSPClient, languageServerExtensions, Workspace } from '@codemirror/lsp-client';
import { Text } from '@codemirror/state';
const PORT = process.env.PORT;
const ROOT = '/home/xuehaonan/mymux';
const URI = encodeURI(`file://${ROOT}/crates/mux-core/src/lib.rs`);
const short = (s) => { const m = JSON.parse(s); return JSON.stringify({ id: m.id, method: m.method, err: m.error?.message, keys: m.result ? Object.keys(m.result) : undefined }); };

class W extends Workspace {
  files = [];
  getFile(uri) { const hit = this.files.find((f) => f.uri === uri) ?? null; console.log(`  [getFile] match=${!!hit}`); return hit; }
  syncFiles() { return []; }
  openFile() {}
  closeFile() {}
  displayFile() { return Promise.resolve(null); }
}
let received = null;
const client = new LSPClient({
  rootUri: `file://${ROOT}`,
  workspace: (c) => new W(c),
  extensions: languageServerExtensions(),
  notificationHandlers: {
    'textDocument/publishDiagnostics': (c, p) => { received = p; console.log(`  <<< publishDiagnostics uri-equal=${p.uri === URI} v=${p.version} n=${p.diagnostics.length}`); return false; },
    '$/progress': (c, p) => { console.log(`  <<< $/progress ${p.token} ${p.value?.kind} ${p.value?.title ?? ''}`); return true; },
  },
  unhandledNotification: (c, m) => console.log(`  <<< notif(unhandled) ${m}`),
});
function wsTransport(url) {
  const handlers = new Set(); const queue = [];
  const ws = new WebSocket(url);
  ws.onopen = () => { for (const m of queue) ws.send(m); queue.length = 0; };
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') { try { const m = JSON.parse(ev.data); if (m.id != null && m.method) console.log(`  <<< SERVER REQUEST ${m.method} (id=${m.id})`); } catch {} for (const h of handlers) h(ev.data); } };
  return {
    send(m) { console.log(`  >>> ${short(m)}`); if (ws.readyState === WebSocket.OPEN) ws.send(m); else if (ws.readyState === WebSocket.CONNECTING) queue.push(m); else throw new Error('closed'); },
    subscribe(h) { handlers.add(h); },
    unsubscribe(h) { handlers.delete(h); },
  };
}
client.connect(wsTransport(`ws://127.0.0.1:${PORT}/lsp?lang=rust`));
await client.initializing;
console.log('CHECK1 initialize: PASS');
const file = { uri: URI, languageId: 'rust', version: 1, doc: Text.of(['pub fn mymux_harness() -> u32 { "not a number" }']), getView: () => null };
client.workspace.files.push(file);
client.didOpen(file);
const t0 = Date.now();
while (!received && Date.now() - t0 < 240000) await new Promise((r) => setTimeout(r, 500));
console.log(received ? `CHECK2 diagnostics arrive (uri-equal=${received.uri === URI}, n=${received.diagnostics.length}): ${received.uri === URI && received.diagnostics.length ? 'PASS' : 'FAIL'}` : 'CHECK2: FAIL (240s timeout)');
process.exit(received ? 0 : 2);
