// File history end-to-end against ~/ux-git-ops: code panel's Hist button
// opens the graph in file-history mode (rename followed), detail shows just
// that file's diff, the chip clears back to the full graph. The tail phase
// pins #36: a blame-gutter show(hash) after a file-history session must NOT
// keep the stale file filter.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8083, 'githistory');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const REPO = '/home/xuehaonan/ux-git-ops';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const git = (args) => execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' });
const gitTry = (args) => {
  try { return git(args); } catch { return ''; }
};

// Fixture: hist.txt v1 → v2 → renamed to hist2.txt → v3, plus noise commits.
gitTry('merge --abort');
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('rm -q hist.txt hist2.txt');
execSync(`echo v1 > ${REPO}/hist.txt`);
git('add -A'); git('commit -qm "hist: v1"');
execSync(`echo v2 >> ${REPO}/hist.txt`);
git('add -A'); git('commit -qm "hist: v2"');
git('mv hist.txt hist2.txt');
execSync(`echo v3 >> ${REPO}/hist2.txt`);
git('add -A'); git('commit -qm "hist: renamed + v3"');
const total = git('rev-list --count --all').trim();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-ops');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

// Open the (renamed) file, hit Hist.
await page.locator('.trow', { hasText: 'hist2.txt' }).first().click();
await page.waitForTimeout(900);
check('hist2.txt open', ((await page.locator('#code-path').textContent()) ?? '').includes('hist2.txt'));
await page.click('#code-history');
await page.waitForTimeout(1500);
check('graph took over', (await page.locator('.git-panel.show').count()) === 1 && (await page.locator('.code-panel.show').count()) === 0);
check('history chip shows the file', ((await page.locator('.git-filefilter').textContent()) ?? '').includes('hist2.txt'));

// Rows = exactly the file's 3 commits, rename followed.
const subjects = () =>
  page.evaluate(() => [...document.querySelectorAll('.git-row .git-subject')].map((s) => s.textContent));
const subs = await subjects();
check('only the file’s commits', subs.length === 3 && subs.every((s) => (s ?? '').startsWith('hist:')), subs.join('|'));
check('rename followed to v1', subs.some((s) => s?.includes('v1')), subs.join('|'));

// Detail of the top commit: just this file (the rename + addition).
await page.locator('.git-row').first().click();
await page.waitForTimeout(900);
check('detail lists one file', (await page.locator('.git-detail .git-file').count()) === 1);
const detailText = await page.locator('.git-detail').textContent();
check('detail diff mentions hist2.txt', (detailText ?? '').includes('hist2.txt'), (detailText ?? '').slice(0, 120));

// Clear the chip → full history (noise + service commits) returns.
await page.click('.git-chip-x');
await page.waitForTimeout(1200);
const after = (await page.locator('.git-row').count());
check('chip cleared → full history', after >= parseInt(total, 10) || after >= 10, `rows=${after} total=${total}`);

// #36: poison fileFilter with another file-history session, then jump in via
// the blame gutter — show(hash) must reset the filter (no chip, and the
// detail request must not carry the stale path=).
await page.keyboard.press('Escape'); // close the graph; code keeps its buffers
await page.waitForTimeout(300);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
await page.locator('.trow', { hasText: 'hist2.txt' }).first().click();
await page.waitForTimeout(600);
await page.click('#code-history');
await page.waitForTimeout(1200);
check('file-history chip back', ((await page.locator('.git-filefilter').textContent()) ?? '').includes('hist2.txt'));
await page.keyboard.press('Escape'); // graph closed; back to the editor
await page.waitForTimeout(300);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(600);
const showReqs = [];
page.on('request', (r) => {
  if (r.url().includes('/git/show?')) showReqs.push(r.url());
});
await page.click('#code-blame');
await page.waitForTimeout(1000);
check('blame markers on hist2.txt', (await page.locator('.cm-blame.link').count()) >= 1);
await page.locator('.cm-blame.link').first().click();
await page.waitForTimeout(1500);
check('blame jump reopens the graph', (await page.locator('.git-panel.show').count()) === 1);
check('no file-history chip after show(hash)', (await page.locator('.git-filefilter').count()) === 0);
check('detail request NOT filtered to the stale file', showReqs.length > 0 && showReqs.every((u) => !u.includes('path=')), showReqs.join(' | '));

await page.screenshot({ path: 'shots/git-history.png' });
await browser.close();
sb.kill();
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git file-history checks passed');
