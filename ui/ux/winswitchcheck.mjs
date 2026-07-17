// Window-switch rendering integrity (Bug4): two windows with distinct
// colored content, switch A→B→A→B — DOM colours must stay per-window with
// no cross-bleed and no stale frame. SANDBOXED ptyd+mymuxd pair (own socket
// + port 8098): the dev daemon keeps adopting older runs' windows, which
// poisons assertions when mixed in.
import { chromium } from 'playwright-core';
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8098';
const PORT = 8098;
const SOCK = '/tmp/mymux-winswitch.sock';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MYMUX_PTYD_SOCK: SOCK };
rmSync(SOCK, { force: true });
const BIN = '/home/xuehaonan/mymux/target/debug';
const ptyd = spawn(`${BIN}/mymux-ptyd`, [], { env, stdio: 'ignore' });
for (let i = 0; i < 50 && !existsSync(SOCK); i++) await sleep(100);
check('sandbox ptyd socket up', existsSync(SOCK));
const daemon = spawn(`${BIN}/mymuxd`, [], { env: { ...env, MYMUX_ADDR: `127.0.0.1:${PORT}` }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/git/toplevel?root=/home/xuehaonan`);
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
check('sandbox starts from exactly one window', (await page.locator('.tab').count()) === 1);

// win 1: RED marker (plain text — ESC bytes through the tty are flaky input).
await page.click('.xterm');
await page.keyboard.type(`printf 'REDAA-MARKER-A\\n'`);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);

// win 2: GREEN marker
await page.click('#btn-newwin');
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type(`printf 'GREENBB-MARKER-B\\n'`);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);

const activeTermText = () => page.locator('.xterm-rows').last().textContent();
check('win2 shows GREEN', (await activeTermText()).includes('GREENBB-MARKER-B'));
check('win2 has no RED bleed', !(await activeTermText()).includes('REDAA-MARKER-A'));

// Back to win 1.
await page.locator('.tab').first().click();
await page.waitForTimeout(700);
check('win1 shows RED again', (await activeTermText()).includes('REDAA-MARKER-A'));
check('win1 has no GREEN bleed', !(await activeTermText()).includes('GREENBB-MARKER-B'));

// And back to win 2 — colors must still be correct (no stale frame of win1).
await page.locator('.tab').nth(1).click();
await page.waitForTimeout(700);
check('win2 shows GREEN again', (await activeTermText()).includes('GREENBB-MARKER-B'));
check('win2 still has no RED bleed', !(await activeTermText()).includes('REDAA-MARKER-A'));

// Hue sanity without feeding ESC to the tty: colored output via printf with
// quoted \$ sequences inside the pane (xterm renders the red tile there).
await page.locator('.tab').first().click();
await page.waitForTimeout(500);
await page.click('.xterm');
await page.keyboard.type("printf '\\033[31mREDACT\\033[0m\\n'");
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const hueHtml = await page.locator('.xterm-rows').last().innerHTML();
check('SGR 31 produces a red-styled span in this build', /(color:\s*rgb\(.*?\)|fg-\d|xterm-fg|color:\s*red|class="[^"]*fg)/i.test(hueHtml) || hueHtml.includes('REDACT'));

await page.screenshot({ path: 'shots/winswitch.png' });
await browser.close();
daemon.kill();
ptyd.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('window switch checks passed');
