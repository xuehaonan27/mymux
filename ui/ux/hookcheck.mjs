// Agent notify hooks popover: the 🔔 button opens it, status probes land,
// Install calls agent_hook with install:true, Uninstall needs two clicks
// before agent_hook fire with install:false. Stubbed Tauri records the calls.
import { chromium } from 'playwright-core';

const UI = 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const HOST = { id: 'h-1', label: 'devbox', hostname: 'h.example', user: 'u', port: 22, identity_path: '/tmp/k' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.addInitScript((host) => {
  const state = { claude: false, codex: true, kimi: false, opencode: false };
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts: [host], default_id: null });
      if (cmd === 'conns_list') return Promise.resolve([{ host_id: host.id, port: 8088, status: 'connected' }]);
      if (cmd === 'conn_status') return Promise.resolve(['connected', 8088]);
      if (cmd === 'agent_hook_status') return Promise.resolve({ ...state });
      if (cmd === 'agent_hook') {
        window.__CALLS__.push([args.agent, args.install, Object.keys(args ?? {})]);
        state[args.agent] = args.install;
        return Promise.resolve(args.install ? `installed ${args.agent}` : `removed ${args.agent}`);
      }
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
}, HOST);

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(800);

await page.locator('.host-card .host-icon:has-text("🔔")').click();
await page.locator('.host-hookpop').waitFor({ timeout: 5000 });
await page.waitForTimeout(700);

const dot = (agent) =>
  page.locator('.ah-row', { hasText: new RegExp(`${agent === 'opencode' ? 'Open Code' : agent === 'kimi' ? 'Kimi Code' : agent === 'codex' ? 'Codex' : 'Claude Code'}`) }).locator('.ah-dot').getAttribute('class');

check('popover lists all four agents', (await page.locator('.ah-row').count()) === 4);
check('codex shows installed dot', ((await dot('codex')) ?? '').includes('installed'));
check('claude shows missing dot', ((await dot('claude')) ?? '').includes('missing'));
check('Install button only on missing agents', (await page.locator('.ah-row', { hasText: 'Claude Code' }).locator('.pkgs-btn:text-is("Install")').count()) === 1);
check('Uninstall button only on installed ones', (await page.locator('.ah-row', { hasText: 'Codex' }).locator('.pkgs-btn:text-is("Uninstall")').count()) === 1);

// Install Claude Code → agent_hook called with install:true, dot flips.
await page.locator('.ah-row', { hasText: 'Claude Code' }).locator('.pkgs-btn:text-is("Install")').click();
await page.waitForTimeout(600);
check('install call recorded as Claude+true', (await page.evaluate(() => window.__CALLS__)).some((c) => c[0] === 'claude' && c[1] === true));
check('claude dot flipped to installed', ((await dot('claude')) ?? '').includes('installed'));

// Uninstall Codex needs TWO clicks — one arms, one fires.
await page.locator('.ah-row', { hasText: 'Codex' }).locator('.pkgs-btn:text-is("Uninstall")').click();
await page.waitForTimeout(400);
check('first uninstall click only arms', !(await page.evaluate(() => window.__CALLS__)).some((c) => c[0] === 'codex' && c[1] === false));
check('arm shows sure?', ((await page.locator('.ah-row', { hasText: 'Codex' }).locator('.pkgs-btn.ah-uninstall').textContent()) ?? '').includes('sure'));
await page.locator('.ah-row', { hasText: 'Codex' }).locator('.pkgs-btn.ah-uninstall').click();
await page.waitForTimeout(600);
check('second click fires codex+false', (await page.evaluate(() => window.__CALLS__)).some((c) => c[0] === 'codex' && c[1] === false));
check('codex dot flipped to missing', ((await dot('codex')) ?? '').includes('missing'));

// Outside click closes the popover.
await page.mouse.click(700, 700);
await page.waitForTimeout(400);
check('outside click closes it', (await page.locator('.host-hookpop').count()) === 0);

// Tauri commands are all rename_all="snake_case": the UI must pass
// host_id, NOT hostId — the stub used to accept any shape (this bug shipped).
const badShapes = (await page.evaluate(() => window.__CALLS__)).filter((c) => !c[2].includes('host_id') || c[2].includes('hostId'));
check('all recorded calls pass snake_case host_id', badShapes.length === 0, JSON.stringify(badShapes));

await page.screenshot({ path: 'shots/agenthook.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('agent hook popover checks passed');
