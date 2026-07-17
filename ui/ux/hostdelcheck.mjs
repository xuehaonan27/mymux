// Host delete (two-click house pattern, no window.confirm): seeded manager,
// ✕ first click arms ("sure?"), second click deletes the right host, the
// other stays. Stubbed Tauri — records the host_delete call id.
import { chromium } from 'playwright-core';

const UI = 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};

const HOSTS = [
  { id: 'h-a', label: 'alpha', hostname: 'a.example', user: 'u', port: 22, identity_path: '/tmp/k' },
  { id: 'h-b', label: 'beta', hostname: 'b.example', user: 'u', port: 22, identity_path: '/tmp/k' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.addInitScript((hosts) => {
  const list = [...hosts];
  window.__DELETED__ = null;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts: [...list], default_id: null });
      if (cmd === 'conns_list') return Promise.resolve([]);
      if (cmd === 'host_delete') {
        const i = list.findIndex((h) => h.id === args.id);
        if (i >= 0) {
          window.__DELETED__ = list.splice(i, 1)[0].id;
          return Promise.resolve();
        }
        return Promise.reject(new Error('no such host'));
      }
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
}, HOSTS);

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(800);

const cards = () => page.locator('.host-card').count();
check('two host cards seeded', (await cards()) === 2);
const delB = page.locator('.host-card', { hasText: 'beta' }).locator('.host-icon', { hasText: '✕' }).last();
check('delete button visible', (await delB.count()) === 1);

// First click only ARMS — nothing deleted yet.
await delB.click();
await page.waitForTimeout(300);
check('first click arms without deleting', (await cards()) === 2);
check('arm shows "sure?"', await page.locator('.host-card', { hasText: 'beta' }).locator('.host-icon.confirm').count().then((n) => n === 1));

// The arm expires: another click after the window does NOT delete either.
await page.waitForTimeout(1900);
await page.locator('.host-card', { hasText: 'beta' }).locator('.host-icon', { hasText: '✕' }).click();
await page.waitForTimeout(300);
check('expired arm re-arms instead of deleting', (await cards()) === 2);

// Second click within the window actually deletes beta.
await page.locator('.host-card', { hasText: 'beta' }).locator('.host-icon', { hasText: 'sure?' }).click();
await page.waitForTimeout(600);
check('second click deletes the right host', (await cards()) === 1);
check('recorded deletion is beta', (await page.evaluate(() => window.__DELETED__)) === 'h-b');
check('alpha survived', (await page.locator('.host-card', { hasText: 'alpha' }).count()) === 1);

await page.screenshot({ path: 'shots/host-delete.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('host delete checks passed');
