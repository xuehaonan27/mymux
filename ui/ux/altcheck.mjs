// Alt-screen agent heuristics end-to-end: SANDBOXED ptyd+mymuxd pair via
// startSandbox (own MYMUX_PTYD_SOCK + MYMUX_SOCKET + port — the production
// ptyd and the developer's live `tmux -L mymux` are never touched).
//
// The heuristic is PROC-GATED: a hidden full-screen pane only badges when its
// foreground command is a known agent (claude/codex/kimi/…). Plain `less` is
// the classic alt-larp: full-screen, idle, NOT an agent → no badge, ever.
// A less BINARY renamed to "claude" (comm lies in its favor) does badge.
// After that: CONSUME drops the badge and holds it down across sweeps while
// the pane stays alt+idle, and quitting the app (alt-screen OFF) un-hushes
// the pane so the next session badges again.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { startSandbox } from './sandbox.mjs';

const PORT = 8041;
const sb = await startSandbox(PORT, 'alt');
const UI = process.env.UI ?? sb.ui;
const FAKEBIN = '/tmp/mymux-fakebin';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Belt-and-braces cleanup past the explicit kills at the end: a Playwright
// failure mid-run must not leave the sandbox or the fake agent behind.
process.on('exit', () => {
  sb.kill();
  rmSync(FAKEBIN, { recursive: true, force: true });
});
check('sandbox ptyd socket up', existsSync(sb.sock));

// The fake agent: a copy of less NAMED claude, so /proc/<fg>/comm reads
// "claude" and the gate sees an agent. (A script would report its interp.)
execSync(`mkdir -p ${FAKEBIN} && cp "$(command -v less)" ${FAKEBIN}/claude`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
check('one window at start', (await page.locator('.tab').count()) === 1);

// Window 2 exists for everything below; `runCmd` types a command into it,
// `hideIt` returns to window 1, `quitFg` taps q on the full-screen app.
await page.click('#btn-newwin');
await page.waitForTimeout(1500);
check('second window up', (await page.locator('.tab').count()) === 2);
await page.click('.xterm');
await page.keyboard.type('seq 1 5000 > /tmp/altbig.txt');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

const runCmd = async (cmd) => {
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(600);
  await page.click('.xterm');
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
};
const hideIt = async () => {
  await page.locator('.tab').first().click();
  await page.waitForTimeout(800);
};
const dots = () => page.locator('.tab').nth(1).locator('.adot.agent-done').count();

// (1) The alt-larp gate: plain less, hidden + idle 14s+ — NO dot, ever.
await runCmd('LESS= less /tmp/altbig.txt');
await hideIt();
let larped = 0;
for (let i = 0; i < 28; i++) {
  larped = Math.max(larped, await page.locator('.tab').nth(1).locator('.adot').count());
  await sleep(500);
}
check('plain less never badges (proc gate)', larped === 0);
await runCmd('q'); // back at a shell before the next command (q quits less)

// (2) Same binary, agent name: the gate opens and the Done dot lands.
await runCmd(`LESS= ${FAKEBIN}/claude /tmp/altbig.txt`);
await hideIt();
let badge = 0;
for (let i = 0; i < 40 && !badge; i++) {
  badge = await dots();
  if (!badge) await sleep(500);
}
check('agent-named alt pane earns the Done dot while hidden', badge === 1);

// (3) CONSUME: the badge drops now and STAYS down across sweeps (alt+idle
// hasn't changed — only the suppression holds it off).
const tree = await (await fetch(`http://127.0.0.1:${PORT}/proc/tree`)).json();
const win2 = tree.windows.sort((a, b) => a.id - b.id)[1];
const pane2 = win2?.panes?.[0]?.pane;
check('window 2 pane enumerated', pane2 != null);
await fetch(`http://127.0.0.1:${PORT}/agent/consume`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pane: pane2 }),
});
let dropped = false;
for (let i = 0; i < 12 && !dropped; i++) {
  dropped = (await dots()) === 0;
  if (!dropped) await sleep(400);
}
check('consume drops the badge', dropped);
let heldDown = true;
for (let i = 0; i < 24; i++) {
  if ((await dots()) !== 0) heldDown = false;
  await sleep(500);
}
check('suppression holds across ~12s of sweeps', heldDown);

// (4) Alt-screen OFF lifts the suppression: quit, re-run, hide, badge again.
await runCmd('q'); // q is less's quit; runCmd's wait covers the redraw
await runCmd(`LESS= ${FAKEBIN}/claude /tmp/altbig.txt`);
await hideIt();
badge = 0;
for (let i = 0; i < 40 && !badge; i++) {
  badge = await dots();
  if (!badge) await sleep(500);
}
check('alt-off un-hushes: the next session badges again', badge === 1);

await page.screenshot({ path: 'shots/alt-heur.png' });
await browser.close();
sb.kill();
execSync('rm -f /tmp/altbig.txt');
rmSync(FAKEBIN, { recursive: true, force: true });
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('alt-screen heuristic checks passed');
