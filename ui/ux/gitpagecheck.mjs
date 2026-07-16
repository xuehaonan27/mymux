// History pagination end-to-end against ~/ux-git-ops: 200-commit first
// page, sentinel-triggered second page, scroll position preserved.
// Creates 230 filler commits (cleanup resets to origin/master after).
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
// 230 commits → the 200-page must paginate exactly once.
for (let i = 1; i <= 230; i++) git(`commit -q --allow-empty -m "bulk ${i}"`);
const total = parseInt(git('rev-list --count --all').trim(), 10);

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
await page.waitForTimeout(600);

const rowCount = () => page.locator('.git-row').count();
check('first page is exactly 200 rows', (await rowCount()) === 200, String(await rowCount()));
check('sentinel offered', (await page.locator('.git-more').count()) === 1);

// Scroll the graph to the bottom → the sentinel fires page 2.
await page.evaluate(() => {
  const g = document.querySelector('.git-graph');
  g.scrollTop = g.scrollHeight;
});
await page.waitForTimeout(1500);
const rows2 = await rowCount();
check('page 2 merged the rest', rows2 === total, `rows=${rows2} total=${total}`);
check('no sentinel once exhausted', (await page.locator('.git-more').count()) === 0);
check('deduped (no duplicates)', rows2 === (await page.locator('.git-row .git-subject').count()));
const st = await page.evaluate(() => document.querySelector('.git-graph').scrollTop);
check('scroll position preserved across paging', st > 1000, String(st));

// And a full Refresh resets back to page 1 cleanly.
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(1200);
check('refresh resets to page 1', (await rowCount()) === 200, String(await rowCount()));
check('sentinel back', (await page.locator('.git-more').count()) === 1);

await page.screenshot({ path: 'shots/git-paging.png' });
await browser.close();
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git paging checks passed');
