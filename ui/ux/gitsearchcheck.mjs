// Commit search/filter + branch filter dropdown end-to-end against
// ~/ux-git-ops: free-text filter (subject/author), branch select
// (all/current/named), and focus intact while typing.
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

// Fixture: master history + a side branch with a uniquely-subjected commit.
gitTry('merge --abort');
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D side');
git('checkout -q -b side');
execSync(`echo s >> ${REPO}/b.txt`);
git('add -A');
git('commit -qm "side: UNIQUE-needle commit"');
git('checkout -q master');

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
await page.click('.git-tab[data-page="history"]');
await page.waitForTimeout(700);
await page.locator('.git-row').first().waitFor({ timeout: 10000 });
await page.waitForTimeout(600);

const subjects = () =>
  page.evaluate(() => [...document.querySelectorAll('.git-row .git-subject')].map((s) => s.textContent));

// 1. All branches (default): the side-only commit shows.
let subs = await subjects();
check('default shows the side commit', subs.some((s) => s?.includes('UNIQUE-needle')), subs.join('|'));

// 2. Free-text filter narrows to matches (and keeps focus in the box).
await page.click('.git-search');
await page.keyboard.type('UNIQUE-needle');
await page.waitForTimeout(700);
subs = await subjects();
check('filter narrows to the match', subs.length === 1 && subs[0]?.includes('UNIQUE-needle'), subs.join('|'));
check('focus stays in the search box', await page.evaluate(() => document.activeElement?.classList.contains('git-search')));

// 3. Author / hash prefixes match too; clearing restores.
await page.fill('.git-search', 'gitcheck');
await page.waitForTimeout(600);
subs = await subjects();
check('author text matches', subs.length >= 1 && subs.every((s) => (s ?? '').length > 0), String(subs.length));
await page.fill('.git-search', '');
await page.waitForTimeout(600);
subs = await subjects();
check('clearing restores all', subs.some((s) => s?.includes('UNIQUE-needle')) && subs.length >= 3, subs.join('|'));

// 4. Branch filter: current (master) hides the side-only commit…
await page.selectOption('.git-branch', '~current');
await page.waitForTimeout(900);
subs = await subjects();
check('current branch hides the side commit', !subs.some((s) => s?.includes('UNIQUE-needle')), subs.join('|'));

// 5. …the named branch shows its own history (incl. the side commit)…
await page.selectOption('.git-branch', 'side');
await page.waitForTimeout(900);
subs = await subjects();
check('named branch shows its history', subs.some((s) => s?.includes('UNIQUE-needle')), subs.join('|'));

// 6. …and all brings everything back.
await page.selectOption('.git-branch', '');
await page.waitForTimeout(900);
subs = await subjects();
check('all branches restores', subs.some((s) => s?.includes('UNIQUE-needle')), subs.join('|'));

await page.screenshot({ path: 'shots/git-search.png' });
await browser.close();
gitTry('branch -D side');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git search/filter checks passed');
