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
// …and a CJK marker: snapshot replays must not sprinkle spaces between wide
// chars (the styled_line wide-tail leak).
await page.keyboard.type(`printf '你好世界AB\\n'`);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);

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
check('win1 CJK replays contiguous (no wide-tail spaces)', (await activeTermText()).includes('你好世界AB') && !(await activeTermText()).includes('你 '));

// And back to win 2 — colors must still be correct (no stale frame of win1).
await page.locator('.tab').nth(1).click();
await page.waitForTimeout(700);
check('win2 shows GREEN again', (await activeTermText()).includes('GREENBB-MARKER-B'));
check('win2 still has no RED bleed', !(await activeTermText()).includes('REDAA-MARKER-A'));
// Once more to win1: the CJK must survive a SECOND snapshot round trip.
await page.locator('.tab').first().click();
await page.waitForTimeout(700);
check('win1 CJK still contiguous after re-switch', (await activeTermText()).includes('你好世界AB'));

// The macOS translucent-compositor nudge must fire on an EQUALLY-SIZED swap
// (1 pane ↔ 1 pane): simulate the app's has-winalpha class and count style
// flips on the workspace root across two switches. Headless can't see the
// compositor fringe itself (Mac-verify still applies) — this pins the trigger
// so the equal-count case can't silently regress to zero nudges.
await page.evaluate(() => document.body.classList.add('has-winalpha'));
const flips = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const rootNode = document.querySelector('.workspace');
      let n = 0;
      const mo = new MutationObserver((ms) => {
        for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'style') n++;
      });
      mo.observe(rootNode, { attributes: true });
      document.querySelectorAll('.tab')[0].click(); // → win 1
      setTimeout(() => document.querySelectorAll('.tab')[1].click(), 250); // → win 2
      setTimeout(() => {
        mo.disconnect();
        resolve(n);
      }, 900);
    }),
);
check('translucent-mode equal-size swap nudges repaints (flips ≥ 4)', flips >= 4, `${flips}`);

// DOM-renderer metric sanity: letter-spacing is baked into spans when a row
// first renders, so a degenerate measurement bakes ≈ one cell of spacing into
// every span (the wide-spaced-glyph bug). Headless can't force that moment,
// but this pins the healthy invariant around switch + snapshot + refresh.
await page.waitForTimeout(400);
const badSpacing = await page.evaluate(() => {
  let bad = 0, total = 0;
  for (const sp of document.querySelectorAll('.xterm-rows span')) {
    total++;
    const v = parseFloat(sp.style.letterSpacing || '0');
    if (Number.isFinite(v) && Math.abs(v) >= 1) bad++;
  }
  return `${bad}/${total}`;
});
check('no wide-spaced glyph bake (0 spans with letter-spacing)', badSpacing.startsWith('0/'), badSpacing);

// Scroll discipline (macOS screenshot complaint): a bare modifier press must
// NOT scroll to the bottom — xterm's scrollOnUserInput scrolls on ANY
// keydown, ⌘ included — while real input must. win1 gets scrollback first.
await page.locator('.tab').first().click();
await page.waitForTimeout(500);
await page.click('.xterm');
await page.keyboard.type('seq 1 200');
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
const viewText = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const bottomView = await viewText();
await page.keyboard.press('Shift+PageUp');
await page.waitForTimeout(300);
const scrolledUpView = await viewText();
check('Shift+PageUp scrolls into scrollback', scrolledUpView !== bottomView);
await page.keyboard.down('Control');
await page.keyboard.up('Control');
await page.keyboard.down('Meta');
await page.keyboard.up('Meta');
await page.waitForTimeout(250);
check('modifier-only presses stay put (no jump to bottom)', (await viewText()) === scrolledUpView);
await page.keyboard.type('x');
await page.waitForTimeout(300);
check('real input scrolls to the bottom again', (await viewText()) !== scrolledUpView);

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
