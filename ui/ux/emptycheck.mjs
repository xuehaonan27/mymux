// Empty state: boot with no workspaces (stubbed Tauri), dismiss the host
// gate → the empty state shows with a working "Connect to a host…" button.
import { chromium } from 'playwright-core';
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.addInitScript(() => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts: [], default_id: null });
      if (cmd === 'conns_list') return Promise.resolve([]);
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
});
await page.goto('http://127.0.0.1:5173/?port=8099', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.keyboard.press('Escape'); // dismiss the boot gate
await page.waitForTimeout(400);
check('empty state visible after dismissing the gate', await page.locator('#empty.show').count().then((n) => n === 1));
check('empty state offers a connect button', await page.locator('#empty.show button').count().then((n) => n === 1));
await page.screenshot({ path: 'shots/empty-state.png' });
await page.click('#empty.show button');
check('button reopens the host panel', await page.locator('.host-panel.show').count().then((n) => n === 1));
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('empty-state checks passed');
