// Viewer-root check (P1-07 / claude #25) against a sandboxed daemon: an image
// opened under a MANUALLY SWITCHED root must fetch /fs/raw WITH that root —
// otherwise the daemon resolves the path against the pane cwd (a 404, or
// worse: the bytes of a same-named wrong file, planted here as a decoy).
// Fixture: ~/ux-viewer-root (created here, cleaned up on exit; the root
// override only honors paths inside $HOME, so /tmp cannot stand in).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';
import os from 'node:os';

const HOME = os.homedir();
const ROOT = `${HOME}/ux-viewer-root`;
execSync(`rm -rf ${ROOT} && mkdir -p ${ROOT}/pane/alt ${ROOT}/alt`);
execSync(`cp /home/xuehaonan/mymux/ui/ux/wall-test.png ${ROOT}/alt/pic.png`);
execSync(`echo 'not a png — wrong file from the pane cwd' > ${ROOT}/pane/alt/pic.png`);

const sb = await startSandbox(8067, 'viewerroot');
process.on('exit', () => {
  sb.kill();
  execSync(`rm -rf ${ROOT}`);
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

// Capture every /fs/raw request URL for the assertion below.
const rawReqs = [];
page.on('request', (r) => {
  if (r.url().includes('/fs/raw')) rawReqs.push(r.url());
});

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type(`cd ${ROOT}/pane`);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.locator('#code-tree .trow').first().waitFor({ timeout: 10000 });

// Switch the root one level up, out of the pane's cwd.
await page.click('#root-up');
await page.waitForTimeout(900);
check('root switched to the parent', (await page.evaluate(() => document.getElementById('code-root-path').textContent)) === ROOT, await page.evaluate(() => document.getElementById('code-root-path').textContent));

// Open alt/pic.png from the tree (the decoy pane/alt/pic.png must NOT serve).
await page.locator('#code-tree .trow.tdir', { hasText: 'alt' }).first().click();
await page.locator('#code-tree .trow.tfile', { hasText: 'pic.png' }).first().waitFor({ timeout: 5000 });
await page.locator('#code-tree .trow.tfile', { hasText: 'pic.png' }).first().click();
await page.locator('.code-viewer img').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);

const raw = rawReqs.map((u) => new URL(u)).find((u) => u.searchParams.get('path') === 'alt/pic.png');
check('/fs/raw request fired for alt/pic.png', !!raw, rawReqs.join(' | ') || '(none)');
check(
  'request carried the switched root',
  raw?.searchParams.get('root') === ROOT,
  raw ? `root=${raw.searchParams.get('root')}` : 'no request',
);
const loaded = await page.evaluate(() => document.querySelector('.code-viewer img')?.naturalWidth > 0);
check('the REAL image loaded (not the decoy, not a 404)', loaded);

await browser.close();
sb.kill();
execSync(`rm -rf ${ROOT}`);
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('viewer root checks passed');
