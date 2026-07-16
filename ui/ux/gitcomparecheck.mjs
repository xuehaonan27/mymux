// Compare-two-commits end-to-end against ~/ux-git-ops: mark a base via the
// row menu, compare with another commit, A..B cumulative diff in the detail
// column, per-file narrowing, leaving compare on row click, clearing the base.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
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

gitTry('merge --abort');
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
execSync(`echo one > ${REPO}/cmp-a.txt`);
git('add -A'); git('commit -qm "cmp: 1add a"');
execSync(`echo two > ${REPO}/cmp-b.txt`);
git('add -A'); git('commit -qm "cmp: 2add b"');
execSync(`echo one-half >> ${REPO}/cmp-a.txt`);
git('add -A'); git('commit -qm "cmp: 3mod a"');

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
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.locator('.git-row').first().waitFor({ timeout: 10000 });

const rowOf = (subj) => page.locator('.git-row', { hasText: subj }).first();

// 1. Mark "cmp: 1add a" as the base → the row highlights, menu flips label.
await rowOf('cmp: 1add a').click({ button: 'right' });
await page.locator('.git-menu').waitFor();
await page.click('.git-menu-item:text-is("Mark as compare base")');
await page.waitForTimeout(500);
check('base row highlighted', (await page.locator('.git-row.compare-base', { hasText: 'cmp: 1add a' }).count()) === 1);
check('menu offered the compare label next', await (async () => {
  await rowOf('cmp: 3mod a').click({ button: 'right' });
  await page.locator('.git-menu').waitFor();
  const cmpBtn = page.locator('.git-menu-item', { hasText: 'Compare with' });
  const n = await cmpBtn.count();
  await cmpBtn.click();
  return n === 1;
})());
await page.waitForTimeout(1200);

// 2. Detail shows the cumulative A..B: files = {cmp-a M, cmp-b A}.
const title = (await page.locator('.git-detail-title').textContent()) ?? '';
check('compare title has ..', title.includes('..'), title);
check('meta reports 2 files', ((await page.locator('.git-detail-meta').textContent()) ?? '').includes('2 file(s)'));
const paths = await page.locator('.git-detail .git-file-path').allTextContents();
check('files are cmp-a + cmp-b', paths.includes('cmp-a.txt') && paths.includes('cmp-b.txt'), paths.join('|'));
const diffText = (await page.locator('.git-detail .git-diff').textContent()) ?? '';
check('diff has the addition and modification', diffText.includes('one-half') && diffText.includes('two'), diffText.slice(0, 100));

// 3. Per-file click narrows to just that file's diff.
await page.locator('.git-detail .git-file', { hasText: 'cmp-b.txt' }).click();
await page.waitForTimeout(700);
const fileDiff = (await page.locator('.git-detail .git-diff').last().textContent()) ?? '';
check('per-file diff is only cmp-b', fileDiff.includes('cmp-b.txt') && !fileDiff.includes('cmp-a.txt'), fileDiff.slice(0, 100));

// 4. A row click leaves compare mode back to the plain commit view.
await page.locator('.git-row').first().click();
await page.waitForTimeout(700);
check('row click leaves compare', !(await page.locator('.git-detail-title').textContent())?.includes('..'));

// 5. Re-mark the base, then clear it via its own row.
await rowOf('cmp: 1add a').click({ button: 'right' });
await page.click('.git-menu-item:text-is("Mark as compare base")');
await page.waitForTimeout(400);
check('base row highlighted again', (await page.locator('.git-row.compare-base').count()) === 1);
await rowOf('cmp: 1add a').click({ button: 'right' });
await page.locator('.git-menu').waitFor();
check('base label reads clear', (await page.locator('.git-menu-item:text-is("Clear compare base")').count()) === 1);
await page.click('.git-menu-item:text-is("Clear compare base")');
await page.waitForTimeout(400);
check('highlight removed', (await page.locator('.git-row.compare-base').count()) === 0);

await page.screenshot({ path: 'shots/git-compare.png' });
await browser.close();
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git compare checks passed');
