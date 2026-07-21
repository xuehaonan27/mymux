// Open-race check (P1-05) against a sandboxed daemon, with route interception
// for a deterministic read delay: a slow /fs/read for file A must NOT commit
// after a later click on file B — the latest open wins (the audit's repro
// ended with a.txt/content-a on screen after clicking A then B).
// Fixture: /tmp/mymux-ux-openrace (created here, cleaned up on exit).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DIR = '/tmp/mymux-ux-openrace';
execSync(`rm -rf ${DIR} && mkdir -p ${DIR}`);
fs.writeFileSync(`${DIR}/a.txt`, 'content-a\n');
fs.writeFileSync(`${DIR}/b.txt`, 'content-b\n');

const sb = await startSandbox(8066, 'openrace');
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

// A's read is slow (500ms), B's instant — the audit's A/B probe.
let readDelay = (p) => (p === 'a.txt' ? 500 : 0);
await page.route('**/fs/read**', async (route) => {
  const u = new URL(route.request().url());
  const d = readDelay(u.searchParams.get('path') ?? '');
  if (d) await new Promise((r) => setTimeout(r, d));
  await route.continue();
});

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type(`cd ${DIR}`);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.locator('#code-tree .trow.tfile').first().waitFor({ timeout: 10000 });

const header = () => page.evaluate(() => document.getElementById('code-path').textContent ?? '');
const docText = () =>
  page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

// Click A, then B quickly — A's read is still in flight when B commits.
await page.locator('#code-tree .trow.tfile', { hasText: 'a.txt' }).first().click();
await page.waitForTimeout(100);
await page.locator('#code-tree .trow.tfile', { hasText: 'b.txt' }).first().click();
await page.waitForTimeout(1400); // A's 500ms read resolves inside this window

check('latest click wins: header is b.txt', (await header()).includes('b.txt'), await header());
check('editor shows content-b', (await docText()).includes('content-b'), await docText());
await page.waitForTimeout(800);
check('B stays after A resolves late', (await header()).includes('b.txt') && (await docText()).includes('content-b'), `${await header()} / ${await docText()}`);

// Normal serial switching still works once the delays are gone.
readDelay = () => 0;
await page.locator('#code-tree .trow.tfile', { hasText: 'a.txt' }).first().click();
await page.waitForTimeout(800);
check('serial switch to a.txt works', (await header()).includes('a.txt') && (await docText()).includes('content-a'), `${await header()} / ${await docText()}`);

await browser.close();
sb.kill();
execSync(`rm -rf ${DIR}`);
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('open race checks passed');
