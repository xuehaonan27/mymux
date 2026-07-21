// Host-card post-connect meta UI: with a stubbed Tauri, a host whose daemon
// is behind the app pin shows the amber "daemon OLD → NEW" line with the
// two-click Update button, and the 🔔 bell wears the attention dot when any
// agent's hooks are missing. Phase two (?outdated=0): a current daemon paints
// the quiet dim line, no Update, and a fully-hooked host shows no dot.
import { chromium } from 'playwright-core';

const UI = 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.addInitScript(() => {
  const outdated = !new URLSearchParams(location.search).has('outdated');
  const HOST = { id: 'h-1', label: 'devbox', hostname: 'h.example', user: 'u', port: 22, identity_path: '/tmp/k' };
  const meta = outdated
    ? {
        daemon: { current: 'mymuxd 0.1.0 (aaa0000)', expected: 'mymuxd 0.1.0 (bbb1111)', outdated: true },
        hooks: { claude: true, codex: false, kimi: false, opencode: true },
      }
    : {
        daemon: { current: 'mymuxd 0.1.0 (bbb1111)', expected: 'mymuxd 0.1.0 (bbb1111)', outdated: false },
        hooks: { claude: true, codex: true, kimi: true, opencode: true },
      };
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts: [HOST], default_id: null });
      if (cmd === 'conns_list') return Promise.resolve([{ host_id: HOST.id, port: 8088, status: 'connected' }]);
      if (cmd === 'conn_status') return Promise.resolve(['connected', 8088]);
      if (cmd === 'host_meta') return Promise.resolve(meta);
      if (cmd === 'host_meta_refresh') return Promise.resolve(meta);
      if (cmd === 'daemon_update') {
        window.__CALLS__.push(['daemon_update', args.host_id, Object.keys(args ?? {})]);
        return Promise.resolve('installed');
      }
      if (cmd === 'agent_hook_status') return Promise.resolve(meta.hooks);
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
});

// ---- phase 1: outdated daemon + missing hooks --------------------------------
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(900);

const stale = page.locator('.host-metaline .stale');
await stale.waitFor({ timeout: 5000 });
check('outdated line shows old → new', ((await stale.textContent()) ?? '').includes('mymuxd 0.1.0 (aaa0000) → mymuxd 0.1.0 (bbb1111)'));
check('Update button offered', (await page.locator('.host-update').count()) === 1);
check('bell wears the attention dot', (await page.locator('.hookbell.attn').count()) === 1);
check('bell title says some agents uncovered', ((await page.locator('.hookbell').getAttribute('title')) ?? '').includes('NOT covered'));

// Two-click arm: first click only arms, second fires daemon_update.
await page.locator('.host-update').click();
await page.waitForTimeout(300);
check('first click arms (sure?), no call yet', (await page.locator('.host-update').textContent()) === 'sure?' && (await page.evaluate(() => window.__CALLS__)).length === 0);
await page.locator('.host-update').click();
await page.waitForTimeout(500);
check('second click fires daemon_update(h-1) with snake host_id', (await page.evaluate(() => window.__CALLS__)).some((c) => c[0] === 'daemon_update' && c[1] === 'h-1' && c[2].includes('host_id') && !c[2].includes('hostId')));

// ---- phase 2: current daemon + all hooks -------------------------------------
await page.goto(`${UI}&outdated=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(900);
const cur = page.locator('.host-metaline .current');
await cur.waitFor({ timeout: 5000 });
check('current daemon paints the quiet line', ((await cur.textContent()) ?? '').includes('daemon mymuxd 0.1.0 (bbb1111)'));
check('no Update button when current', (await page.locator('.host-update').count()) === 0);
check('no attention dot when fully hooked', (await page.locator('.hookbell.attn').count()) === 0);

await page.screenshot({ path: 'shots/hostmeta.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('host-meta (daemon audit + hook badge) checks passed');
