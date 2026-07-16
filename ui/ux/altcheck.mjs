// Alt-screen agent heuristics end-to-end: SANDBOXED ptyd+mymuxd pair on a
// custom unix socket (MYMUX_PTYD_SOCK) — the production ptyd (holding real
// persistent shells) is never touched. A background window whose pane
// enters alt-screen (less) earns the Done dot; leaving alt clears it.
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8097';
const PORT = 8097;
const SOCK = '/tmp/mymux-alt-test.sock';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MYMUX_PTYD_SOCK: SOCK };
rmSync(SOCK, { force: true });

// Boot the sandbox drawer: ptyd on its own socket, mymuxd on 8097 on top.
const BIN = '/home/xuehaonan/mymux/target/debug';
const ptyd = spawn(`${BIN}/mymux-ptyd`, [], { env, stdio: 'ignore' });
for (let i = 0; i < 50 && !existsSync(SOCK); i++) await sleep(100);
check('sandbox ptyd socket up', existsSync(SOCK));
const daemon = spawn(`${BIN}/mymuxd`, [], { env: { ...env, MYMUX_ADDR: '127.0.0.1:8097' }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/git/toplevel?root=/home/xuehaonan/ux-git-ops`);
    if (r.ok) break;
  } catch { /* boot */ }
  await sleep(100);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
check('one window at start', (await page.locator('.tab').count()) === 1);

// Window 2: run less (enters the alternate screen).
await page.click('#btn-newwin');
await page.waitForTimeout(1500);
check('second window up', (await page.locator('.tab').count()) === 2);
await page.click('.xterm');
await page.keyboard.type('seq 1 5000 > /tmp/altbig.txt && LESS= less /tmp/altbig.txt');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);

// Back to window 1 → the less pane is now hidden + alt + idle.
await page.locator('.tab').first().click();
await page.waitForTimeout(1500);
// Heuristic threshold: idle >8s (plus the 2s sweep) → Done dot on tab 2.
let dots = 0;
for (let i = 0; i < 26; i++) {
  dots = await page.locator('.tab').nth(1).locator('.adot.agent-done').count();
  if (dots) break;
  await sleep(500);
}
check('alt-screen pane earns the Done dot while hidden', dots === 1);

// Quit less on window 2 → alt state flips off → the dot melts.
await page.locator('.tab').nth(1).click();
await page.waitForTimeout(800);
await page.click('.xterm');
await page.keyboard.press('q');
await page.waitForTimeout(1000);
let gone = false;
for (let i = 0; i < 12 && !gone; i++) {
  gone = (await page.locator('.tab').nth(1).locator('.adot.agent-done').count()) === 0;
  if (!gone) await sleep(500);
}
check('leaving alt clears the dot', gone);

await page.screenshot({ path: 'shots/alt-heur.png' });
await browser.close();
daemon.kill();
ptyd.kill();
execSync('rm -f /tmp/altbig.txt');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('alt-screen heuristic checks passed');
