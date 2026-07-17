// Tauri arg-shape guard: every invoke() key in ui/src must EXACTLY match a
// snake_case Rust param on its command (all declare rename_all="snake_case").
// The hostId-vs-host_id class shipped broken once and stub checks can't see
// it — this static gate makes it unshippable. Run: node ux/argshapecheck.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname; // ui/

// ---- Rust side: parse command signatures -------------------------------------
const rs = readFileSync(join(ROOT, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
const commands = new Map(); // name -> Set<param>
{
  const blocks = rs.split(/#\[tauri::command/);
  for (const b of blocks.slice(1)) {
    const m = b.match(/(?:async )?fn\s+(\w+)\s*\(([^)]*)\)/s);
    if (!m) continue;
    const params = new Set(
      [...m[2].matchAll(/(\w+)\s*:\s*(?:String|Option|bool|u16|u32)/g)].map((x) => x[1]),
    );
    // AppHandle/State aren't JS-passed.
    params.delete('app');
    params.delete('state');
    commands.set(m[1], params);
  }
}

// ---- JS side: walk ui/src for invoke('name', { keys }) call sites ------------
function* walk(dir) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (f.endsWith('.ts')) yield p;
  }
}
const fails = [];
const seen = new Set();
for (const p of walk(join(ROOT, 'src'))) {
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*['"`]([\w:|]+)['"`]\s*(?:,\s*\{([^}]*)\})?/g)) {
    const [, cmd, obj] = m;
    const rel = p.split('/src/')[1];
    seen.add(cmd);
    if (!commands.has(cmd)) {
      fails.push(`${rel}: invoke('${cmd}') — no such command in lib.rs`);
      continue;
    }
    if (obj == null) continue;
    const keys = [...obj.matchAll(/(\w+)\s*(?:=|:)/g)].map((x) => x[1]);
    const params = commands.get(cmd);
    for (const k of keys) {
      if (!params.has(k)) {
        fails.push(`${rel}: invoke('${cmd}', { ${k}, … }) — '${cmd}' has no param named '${k}' (params: ${[...params].join(', ') || '∅'})`);
      }
    }
  }
}

if (fails.length) {
  console.error('Tauri arg-shape violations:');
  for (const f of fails) console.error('  ✗', f);
  process.exit(1);
}
console.log(`arg-shape ok — ${[...seen].length} commands, all invoke sites match snake_case params`);
