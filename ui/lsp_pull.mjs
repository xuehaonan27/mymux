import { LSPClient, languageServerExtensions, Workspace } from '@codemirror/lsp-client';
import { Text } from '@codemirror/state';
const PORT = process.env.PORT;
const ROOT = '/home/xuehaonan/mymux';
const URI = encodeURI(`file://${ROOT}/crates/mux-core/src/lib.rs`);
class W extends Workspace {
  files = []; syncFiles() { return []; } openFile() {} closeFile() {} displayFile() { return Promise.resolve(null); }
}
const client = new LSPClient({ rootUri: `file://${ROOT}`, workspace: (c) => new W(c), extensions: languageServerExtensions(), timeout: 30000 });
function wsTransport(url) {
  const handlers = new Set(); const queue = [];
  const ws = new WebSocket(url);
  ws.onopen = () => { for (const m of queue) ws.send(m); queue.length = 0; };
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') for (const h of handlers) h(ev.data); };
  return { send(m) { if (ws.readyState === WebSocket.OPEN) ws.send(m); else if (ws.readyState === WebSocket.CONNECTING) queue.push(m); else throw new Error('closed'); }, subscribe(h) { handlers.add(h); }, unsubscribe(h) { handlers.delete(h); } };
}
client.connect(wsTransport(`ws://127.0.0.1:${PORT}/lsp?lang=rust`));
await client.initializing;
const file = { uri: URI, languageId: 'rust', version: 1, doc: Text.of(['pub fn mymux_pull() -> u32 { "not a number" }']), getView: () => null };
client.workspace.files.push(file);
client.didOpen(file);
console.log('didOpen sent; pulling textDocument/diagnostic with warm-up retries…');
const t0 = Date.now();
let items = [];
for (let attempt = 1; Date.now() - t0 < 240000; attempt++) {
  try {
    const res = await client.request('textDocument/diagnostic', { textDocument: { uri: URI } });
    items = res.items ?? [];
    if (items.length) break;
    console.log(`  attempt ${attempt}: kind=${res.kind} items=0 (indexing?)`);
  } catch (e) {
    console.log(`  attempt ${attempt}: ${String(e?.message ?? e).slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (items.length) {
  console.log('CHECK pull diagnostics end-to-end: PASS');
  console.log('  first:', JSON.stringify({ severity: items[0].severity, message: items[0].message?.slice(0, 70) }));
  process.exit(0);
}
console.log('CHECK pull diagnostics: FAIL (no items in 240s)');
process.exit(2);
