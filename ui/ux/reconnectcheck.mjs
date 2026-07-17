// Reconnect self-heal: a daemon restart (the app-upgrade swap moment) makes
// the code panel's HTTP fail → retry rows → exhaust → stale error. When the
// daemon comes back, the workspace reconnects and the panel must refresh
// WITHOUT a click (the onReconnected refresh path). SANDBOXED pair: we kill
// the daemon twice, panels survive inside ptyd.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8098';
const PORT = 8098;
const SOCK = '/tmp/mymux-reconnect.sock';
const BIN = '/home/xuehaonan/mymux/target/debug';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(SOCK, { force: true });
const env = { ...process.env, MYMUX_PTYD_SOCK: SOCK, MYMUX_SOCKET: 'mymux-uxrec', MYMUX_ADDR: `127.0.0.1:${PORT}` };
const ptyd = spawn(`${BIN}/mymux-ptyd`, [], { env, stdio: 'ignore' });
for (let i = 0; i < 50 && !existsSync(SOCK); i++) await sleep(100);
const startDaemon = () => spawn(`${BIN}/mymuxd`, [], { env, stdio: 'ignore' });
const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/git/toplevel?root=/home/xuehaonan`);
      if (r.ok) return true;
    } catch { /* down */ }
    await sleep(100);
  }
  return false;
};
let daemon = startDaemon();
check('sandbox daemon up', await waitUp());

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.locator('#code-tree .trow.tdir').first().waitFor({ timeout: 10000 });
// Open a file so the reconnect path must also re-read it.
await page.locator('#code-tree .trow', { hasText: 'clean.txt' }).first().click();
await page.waitForTimeout(900);
check('file open pre-restart', ((await page.locator('#code-path').textContent()) ?? '').includes('clean.txt'));

// Kill the daemon (ptyd and panes SURVIVE — the app's real upgrade swap).
daemon.kill('SIGKILL');
await page.waitForTimeout(800);
// Trigger a fresh listing into the dead link: close + reopen the editor.
await page.keyboard.press('Control+e');
await page.waitForTimeout(400);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
const err = ((await page.locator('#code-tree .trow.tstat').first().textContent().catch(() => '')) ?? '');
check('tree enters auto-retry against the dead link', /retry \d\/\d|unreachable/.test(err), err);

// Let the auto-retries EXHAUST (4 × 2.5s + margin) — this is the stale row
// the user reported sticking around.
await page.waitForTimeout(11500);
const stale = ((await page.locator('#code-tree .trow.tstat').first().textContent().catch(() => '')) ?? '');
check('retry exhausts to a stale error row', /unreachable|404|failed/.test(stale) && !/retry \d\//.test(stale), stale);

// Bring the daemon back (same ptyd, panes ride through).
daemon = startDaemon();
check('daemon back up', await waitUp());
// ws reconnects → banner hides → onReconnected → refresh. NO click.
const recovered = await (async () => {
  for (let i = 0; i < 40; i++) {
    const t = (await page.locator('#code-tree').textContent()) ?? '';
    if (t.includes('sub') && !/retry|unreachable/.test(t)) return true;
    await sleep(250);
  }
  return false;
})();
check('panel self-heals after reconnect (no click)', recovered, (await page.locator('#code-tree').textContent())?.slice(0, 100)?.replace(/\n/g, ' '));
const pathNow = (await page.locator('#code-path').textContent()) ?? '';
check('file re-opened after reconnect', pathNow.includes('clean.txt'), pathNow);

await page.screenshot({ path: 'shots/reconnect.png' });
await browser.close();
daemon.kill();
ptyd.kill();
rmSync(SOCK, { force: true });
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('reconnect self-heal checks passed');
