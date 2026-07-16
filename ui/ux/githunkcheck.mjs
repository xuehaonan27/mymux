// Hunk/line-level staging end-to-end: stage a whole hunk from the unified
// diff, then ONE added line out of a two-add hunk, then unstage a hunk.
// Truth is asserted via `git diff --staged` contents afterwards.
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
// A 20-line file; two far-apart edits → two hunks. Second edit = one line → two adds.
execSync(`seq 1 20 | sed 's/^/line /' > ${REPO}/partial.txt`);
git('add -A'); git('commit -qm "partial: base"');
execSync(`sed -i '2s/.*/line 2 CHANGED/' ${REPO}/partial.txt`);
execSync(`sed -i '19s/.*/added-a\\nadded-b/' ${REPO}/partial.txt`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-ops');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

// Open the diff from the changes list.
await page.locator('.grow', { hasText: 'partial.txt' }).first().click();
await page.waitForTimeout(1000);
check('two hunks rendered', (await page.locator('.code-diff .dhunk').count()) === 2);
check('both hunk buttons offered', (await page.locator('.dl-hunk-btn').count()) === 2);

// 1. Stage hunk 1 → staged diff has ONLY its change.
await page.locator('.dhunk').nth(0).locator('.dl-hunk-btn').click();
await page.waitForTimeout(1200);
const staged1 = git('diff --staged');
check('hunk 1 staged', staged1.includes('line 2 CHANGED'));
check('hunk 2 NOT staged', !staged1.includes('added-a') && !staged1.includes('added-b'));
check('hunk 2 still unstaged', git('diff').includes('added-a'));

// 2. Line-level: select ONLY '+added-a' out of the two-add hunk.
// The current view rebuilt after the apply; hunk now shows added-a/added-b.
const addARow = page.locator('.dl.sline', { hasText: 'added-a' }).first();
const addBRow = page.locator('.dl.sline', { hasText: 'added-b' }).first();
check('both add rows selectable', (await addARow.count()) === 1 && (await addBRow.count()) === 1);
await addARow.click();
check('selection armed the driver', (await page.locator('.diff-ctl-btn', { hasText: 'stage 1 selected' }).count()) === 1);
await page.locator('.diff-ctl-btn', { hasText: 'stage 1 selected' }).click();
await page.waitForTimeout(1200);
const staged2 = git('diff --staged');
check('chosen line staged', staged2.includes('added-a'));
check('unchosen line NOT staged', !staged2.includes('added-b'));
check('unchosen line still unstaged', git('diff').includes('added-b'));

// 3. Unstage a hunk from the staged side: switch to staged view, first hunk.
await page.locator('.diff-ctl-btn:text-is("staged")').click();
await page.waitForTimeout(900);
check('staged view shows hunks', (await page.locator('.code-diff .dhunk').count()) >= 1);
await page.locator('.dhunk').nth(0).locator('.dl-hunk-btn').click();
await page.waitForTimeout(1200);
const staged3 = git('diff --staged');
check('unstaged hunk left the index', !staged3.includes('line 2 CHANGED'));
check('the other staged bits remain', staged3.includes('added-a'));

await page.screenshot({ path: 'shots/git-hunks.png' });
await browser.close();
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git hunk staging checks passed');
