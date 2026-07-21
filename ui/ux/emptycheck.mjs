// Empty state: boot with no workspaces (stubbed Tauri), dismiss the host
// gate → the empty state shows with a working "Connect to a host…" button.
// Plus the transition coverage for C-25/#10: connecting the first host must
// HIDE the empty state (the renderEmpty-before-workspaces.set bug left it on
// behind the terminal), and disconnecting the last host must bring it back.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8089, 'empty');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const tauriStub = ({ hosts, conns }) => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts, default_id: null });
      if (cmd === 'conns_list') return Promise.resolve(conns);
      if (cmd === 'conn_status') return Promise.resolve(['connected', 0]);
      if (cmd === 'host_meta') return Promise.resolve(null);
      if (cmd === 'host_meta_refresh') return Promise.resolve(null);
      if (cmd === 'agent_hook_status') return Promise.resolve({});
      if (cmd === 'disconnect') return Promise.resolve(null);
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
};

const browser = await chromium.launch();

// ---- zero-state: no hosts, gate dismissed → empty state + connect button ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(tauriStub, { hosts: [], conns: [] });
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-panel.show', { timeout: 20000 });
  await page.keyboard.press('Escape'); // dismiss the boot gate
  await page.waitForTimeout(400);
  check('empty state visible after dismissing the gate', (await page.locator('#empty.show').count()) === 1);
  check('empty state offers a connect button', (await page.locator('#empty.show button').count()) === 1);
  await page.screenshot({ path: 'shots/empty-state.png' });
  await page.click('#empty.show button');
  check('button reopens the host panel', (await page.locator('.host-panel.show').count()) === 1);
  await page.close();
}

// ---- zero→one→zero: a connected host (the sandbox) hides it; the last ----
// disconnect brings it back.
{
  const HOST = { id: 'h-1', label: 'sandbox', hostname: '127.0.0.1', user: 'u', port: 22, identity_path: '/tmp/k' };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(tauriStub, { hosts: [HOST], conns: [{ host_id: HOST.id, port: sb.port, status: 'connected' }] });
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-panel.show', { timeout: 20000 });
  await page.keyboard.press('Escape'); // gate away: still zero workspaces
  await page.waitForTimeout(400);
  check('zero workspaces → empty state shown', (await page.locator('#empty.show').count()) === 1);

  // zero→one: connect the host — the empty state must hide behind a live ws.
  await page.click('#btn-host');
  await page.locator('.host-panel.show').waitFor({ timeout: 5000 });
  await page.locator('.host-card-main', { hasText: 'sandbox' }).first().click();
  await page.locator('.xterm').waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  check('first connect hides the empty state', (await page.locator('#empty.show').count()) === 0);

  // one→zero: disconnect the last host — it must come back.
  await page.click('#btn-host');
  await page.locator('.host-panel.show').waitFor({ timeout: 5000 });
  await page.locator('.host-icon[title="Disconnect"]').first().click();
  await page.waitForTimeout(600);
  check('last disconnect brings the empty state back', (await page.locator('#empty.show').count()) === 1);
  await page.close();
}

await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('empty-state checks passed');
