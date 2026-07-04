import { LSPClient, languageServerExtensions, Workspace } from '@codemirror/lsp-client';
import { Text } from '@codemirror/state';
const PORT = process.env.PORT;
const ROOT = '/home/xuehaonan/mymux';
const URI = encodeURI(`file://${ROOT}/crates/mux-core/src/lib.rs`);
class W extends Workspace { files = []; syncFiles(){return [];} openFile(){} closeFile(){} displayFile(){return Promise.resolve(null);} }
const client = new LSPClient({ rootUri: `file://${ROOT}`, workspace: (c)=>new W(c), extensions: languageServerExtensions(), timeout: 30000 });
function t(url){const hs=new Set();const q=[];const ws=new WebSocket(url);ws.onopen=()=>{for(const m of q)ws.send(m);q.length=0;};ws.onmessage=(e)=>{if(typeof e.data==='string')for(const h of hs)h(e.data);};return{send(m){if(ws.readyState===WebSocket.OPEN)ws.send(m);else if(ws.readyState===WebSocket.CONNECTING)q.push(m);else throw new Error('closed');},subscribe(h){hs.add(h);},unsubscribe(h){hs.delete(h);}};}
client.connect(t(`ws://127.0.0.1:${PORT}/lsp?lang=rust`));
await client.initializing;
// The user's exact case: `asdf;` is syntactically fine, semantically bogus.
const file = { uri: URI, languageId: 'rust', version: 1,
  doc: Text.of(['pub fn mymux_sem() { let w = 1u32;asdf; let _ = w; }']), getView: () => null };
client.workspace.files.push(file);
client.didOpen(file);
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < 200000) {
  try {
    const res = await client.request('textDocument/diagnostic', { textDocument: { uri: URI } });
    last = res.items ?? [];
    if (last.length) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('items:', last?.length ?? 'none');
for (const d of last ?? []) console.log(`  sev=${d.severity} code=${JSON.stringify(d.code)} src=${d.source} msg=${d.message?.slice(0,70)}`);
process.exit(0);
