// Ref operations end-to-end against ~/ux-git-ops: branch create/merge/
// delete via badge and commit-row menus, tag create/delete with two-click
// confirms, all driven through the context menus' prompt rows.
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
const refExists = (ref) => gitTry(`show-ref --verify --quiet ${ref} && echo yes`).includes('yes');

gitTry('merge --abort');
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D feat-x');
gitTry('branch -D probe-d');
gitTry('tag -d v1');

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

// 1. Commit-row menu: 7 buttons + 2 prompt rows; create branch at this commit.
await page.locator('.git-row:has(.git-ref-head)').first().click({ button: 'right' });
await page.locator('.git-menu').waitFor();
check('commit menu: 8 actions + 2 prompts', (await page.locator('.git-menu-item').count()) === 8 && (await page.locator('.git-menu-prompt').count()) === 2);
await page.locator('.git-menu-prompt').nth(0).locator('.git-menu-input').fill('feat-x');
await page.locator('.git-menu-prompt').nth(0).locator('.git-menu-go').click();
await page.waitForTimeout(1200);
check('branch created', refExists('refs/heads/feat-x'));
check('badge appears after reload', (await page.locator('.git-ref-branch', { hasText: 'feat-x' }).count()) === 1);

// 2. Badge menu: checkout feat-x, commit there, back, then Merge via menu.
await page.locator('.git-ref-branch', { hasText: 'feat-x' }).first().click({ button: 'right' });
await page.locator('.git-menu').waitFor();
const branchItems = await page.locator('.git-menu-item').allTextContents();
check('branch menu items', branchItems.length === 3 && branchItems[0].startsWith('Check out') && branchItems[1].startsWith('Merge') && branchItems[2].startsWith('Delete'), branchItems.join('|'));
await page.click('.git-menu-item:text-is("Check out feat-x")');
await page.waitForTimeout(1200);
execSync(`echo fx >> ${REPO}/fx.txt`);
git('add -A'); git('commit -qm "feat-x: fx"');
git('checkout -q master');
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(900);
await page.locator('.git-ref-branch', { hasText: 'feat-x' }).first().click({ button: 'right' });
await page.click('.git-menu-item:text-is("Merge feat-x into current")');
await page.waitForTimeout(1500);
check('merge landed (master advanced)', git('log -1 --format=%s').includes('feat-x: fx'), git('log -1 --format=%s'));

// 3. Tag create via the branch menu prompt; then delete via the tag badge.
// The toolbar shows a plain head badge too — aim INSIDE a row instead.
const masterBadge = page.locator('.git-row .git-ref-head').first();
await masterBadge.click({ button: 'right' });
await page.locator('.git-menu').waitFor();
await page.locator('.git-menu-prompt').nth(1).locator('.git-menu-input').fill('v1');
await page.locator('.git-menu-prompt').nth(1).locator('.git-menu-go').click();
await page.waitForTimeout(1200);
check('tag created', refExists('refs/tags/v1'));
check('tag badge appears', (await page.locator('.git-ref-tag', { hasText: 'v1' }).count()) === 1);
await page.locator('.git-ref-tag', { hasText: 'v1' }).first().click({ button: 'right' });
await page.locator('.git-menu').waitFor();
await page.click('.git-menu-item:text-is("Delete tag v1")');
check('tag delete armed, not run', refExists('refs/tags/v1'));
await page.click('.git-menu-item[data-armed="1"]');
await page.waitForTimeout(1200);
check('tag deleted', !refExists('refs/tags/v1'));

// 4. Delete the feat-x branch via its badge (two-click).
await page.locator('.git-ref-branch', { hasText: 'feat-x' }).first().click({ button: 'right' });
await page.click('.git-menu-item:text-is("Delete feat-x")');
check('branch delete armed, not run', refExists('refs/heads/feat-x'));
await page.click('.git-menu-item[data-armed="1"]');
await page.waitForTimeout(1200);
check('branch deleted', !refExists('refs/heads/feat-x'));

await page.screenshot({ path: 'shots/git-refs.png' });
await browser.close();
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D feat-x');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git ref-op checks passed');
