// ptyd-death recovery, SANDBOXED: kill the sandbox ptyd (every native pane
// dies with it), start a fresh ptyd on the same socket, then drive a fresh
// client — the daemon's ensure path must re-connect and boot a working
// window. The old version read the SHARED dev daemon's window count, which
// is whatever earlier checks left behind — pollution, not a signal (P1-20).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const BIN = '/home/xuehaonan/mymux/target/debug';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sb = await startSandbox(8045, 'recovery');
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
let ptyd2;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(sb.ui, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1200);
  check('boots one window before the kill', (await page.locator('.tab').count()) === 1);

  // Kill ptyd: every native pane dies; the daemon marks itself un-booted.
  sb.procs[0].kill('SIGKILL');
  await page.waitForTimeout(1500);

  // A fresh ptyd takes the socket back (what systemd/manual restart does).
  rmSync(sb.sock, { force: true });
  ptyd2 = spawn(`${BIN}/mymux-ptyd`, [], {
    env: {
      ...process.env,
      MYMUX_PTYD_SOCK: sb.sock,
      MYMUX_SOCKET: 'mymux-ux-recovery',
      MYMUX_ADDR: `127.0.0.1:${sb.port}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50 && !existsSync(sb.sock); i++) await sleep(100);
  check('replacement ptyd answers on the same socket', existsSync(sb.sock));

  // A fresh client triggers ensure → re-connect → boot a default window.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1500);
  check('re-boots exactly one window after ptyd death', (await page.locator('.tab').count()) === 1);
  await page.click('.xterm');
  await page.keyboard.type(`printf 'RECOVERED-OK\\n'`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const view = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  check('the recovered window actually works', view.includes('RECOVERED-OK'));
} finally {
  ptyd2?.kill();
  await browser.close();
  sb.kill();
}
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('ptyd-death recovery checks passed');
