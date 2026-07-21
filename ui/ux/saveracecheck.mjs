// Save-path race checks (P0-01 / claude #24, #30) against a sandboxed daemon,
// with playwright route interception for deterministic write delays:
//   (a) delayed-save→switch: a slow /fs/write for A must update ONLY A's
//       buffer/disk when the user switches to B mid-flight — no state or
//       content leaks across buffers (the stop-ship corruption).
//   (b) double-save: two overlapping writes of the same file serialize — the
//       disk ends at the LAST submit and the dirty flag stays coherent.
// Fixture: /tmp/mymux-ux-saverace (created here, cleaned up on exit).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DIR = '/tmp/mymux-ux-saverace';
execSync(`rm -rf ${DIR} && mkdir -p ${DIR}`);
fs.writeFileSync(`${DIR}/a.txt`, 'alpha\n');
fs.writeFileSync(`${DIR}/b.txt`, 'beta\n');

const sb = await startSandbox(8065, 'saverace');
process.on('exit', () => {
  sb.kill();
  execSync(`rm -rf ${DIR}`);
});
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const disk = (f) => fs.readFileSync(`${DIR}/${f}`, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

// Deterministic per-file write delays, re-programmable between phases.
let writeDelay = () => 0;
await page.route('**/fs/write', async (route) => {
  let path = '';
  try {
    path = route.request().postDataJSON()?.path ?? '';
  } catch {
    /* not JSON — no delay */
  }
  const d = writeDelay(path);
  if (d) await sleep(d);
  await route.continue();
});

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type(`cd ${DIR}`);
await page.keyboard.press('Enter');
// Wait for the shell prompt to ECHO the new cwd (deterministic under load) —
// a fixed sleep races the pane's cwd update and the tree then lists the old
// directory (a.txt never appears).
await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('saverace'), { timeout: 15000 });
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.locator('#code-tree .trow.tfile').first().waitFor({ timeout: 10000 });

const header = () => page.evaluate(() => document.getElementById('code-path').textContent ?? '');
const docText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-content .cm-line')]
      .map((l) => l.textContent)
      .join('\n')
      .replace(/\n$/, ''), // a trailing file newline renders as an empty last line
  );
const openViaTree = async (name) => {
  await page.locator('#code-tree .trow.tfile', { hasText: name }).first().click();
  await page.waitForTimeout(700);
};

// ---- (a) delayed save of A, switch to B mid-flight ----------------------------
await openViaTree('a.txt');
check('setup: a.txt open', (await header()).includes('a.txt'), await header());
await page.click('.cm-content');
await page.keyboard.press('Control+End');
await page.keyboard.type('A-EDIT');

writeDelay = (p) => (p === 'a.txt' ? 500 : 0);
await page.keyboard.press('Control+s'); // A's write is now in flight (500ms)
await page.locator('#code-tree .trow.tfile', { hasText: 'b.txt' }).first().click(); // switch DURING the write
await page.waitForTimeout(1200); // the write lands somewhere in here

check("(a) A's disk got A's content", disk('a.txt') === 'alpha\nA-EDIT', JSON.stringify(disk('a.txt')));
check("(a) B's disk untouched", disk('b.txt') === 'beta\n', JSON.stringify(disk('b.txt')));
check('(a) header shows B, clean', (await header()) === 'b.txt', await header());
check('(a) editor shows B content', (await docText()) === 'beta', await docText());

// The corruption probe: reopen A — pre-fix, A's buffer held B's state, so A
// displayed "beta" and went dirty (the next save would write B into A).
await openViaTree('a.txt');
check("(a) reopening A shows A's edit", (await docText()) === 'alpha\nA-EDIT', await docText());
check('(a) A is NOT dirty on reopen', !(await header()).startsWith('●'), await header());
check('(a) A disk still intact', disk('a.txt') === 'alpha\nA-EDIT');

// ---- (b) two overlapping saves of the same file -------------------------------
// The FIRST write is slow (600ms), the second instant: without serialization
// the older request completes LAST and the disk regresses to v1.
let aWrites = 0;
writeDelay = (p) => (p === 'a.txt' ? (aWrites++ === 0 ? 600 : 0) : 0);
await page.click('.cm-content');
await page.keyboard.press('Control+End');
await page.keyboard.type('+ONE'); // v1 = alpha\nA-EDIT+ONE
await page.keyboard.press('Control+s'); // in flight, 600ms
await page.keyboard.type('+TWO'); // v2 = alpha\nA-EDIT+ONE+TWO
await page.keyboard.press('Control+s'); // must queue behind v1
await page.waitForTimeout(1600);

check('(b) disk ends at the LAST submit', disk('a.txt') === 'alpha\nA-EDIT+ONE+TWO', JSON.stringify(disk('a.txt')));
check('(b) not dirty after both saves', !(await header()).startsWith('●'), await header());
await openViaTree('b.txt');
await openViaTree('a.txt');
check('(b) reopen shows v2, clean', (await docText()) === 'alpha\nA-EDIT+ONE+TWO' && !(await header()).startsWith('●'), `${await docText()} / ${await header()}`);

await browser.close();
sb.kill();
execSync(`rm -rf ${DIR}`);
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('save race checks passed');
