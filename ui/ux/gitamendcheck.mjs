// Amend + per-file discard end-to-end against ~/ux-git-ops: stage, two-click
// Amend rewrites HEAD's tree (message kept); per-row ✕ discards tracked and
// untracked changes with two-click arms.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

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
const headBefore = git('rev-parse HEAD').trim();
const headMsg = git('log -1 --format=%s').trim();

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
await page.locator('.git-changes-side .git-detail-title').first().waitFor({ timeout: 10000 });

// 1. Dirty a.txt, stage via ＋, then Amend (two-click): HEAD rewrites.
execSync(`echo amendme >> ${REPO}/a.txt`);
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(900);
await page.locator('.git-file', { hasText: 'a.txt' }).locator('.git-stage-btn').click();
await page.waitForTimeout(900);
check('amend offered on the uncommitted card', (await page.locator('.git-commit-row .pkgs-btn.git-danger').count()) === 1);
const amend = page.locator('.git-commit-row .pkgs-btn.git-danger');
await amend.click();
check('amend armed, not run', git('rev-parse HEAD').trim() === headBefore);
await page.locator('.git-commit-row .pkgs-btn.git-danger[data-armed="1"]').click();
await page.waitForTimeout(1500);
check('HEAD rewritten', git('rev-parse HEAD').trim() !== headBefore);
check('message kept (--no-edit)', git('log -1 --format=%s').trim() === headMsg);
check('content folded in', git('show --format= --name-only HEAD').includes('a.txt') && readFileSync(`${REPO}/a.txt`, 'utf8').includes('amendme'));

// 2. Clean card: Amend stays visible but is guarded — nothing staged →
// toast and disarm, HEAD untouched.
const headNow = git('rev-parse HEAD').trim();
const amend2 = page.locator('.git-commit-row .pkgs-btn.git-danger');
check('amend still offered on the card', (await amend2.count()) === 1);
await amend2.click();
await page.locator('.git-commit-row .pkgs-btn.git-danger[data-armed="1"]').click();
await page.waitForTimeout(600);
check('nothing-staged amend is guarded', await page.locator('.toast.show', { hasText: 'nothing staged' }).count().then((c) => c >= 1));
check('guard left HEAD alone', git('rev-parse HEAD').trim() === headNow);

// 3. Discard a tracked file (two-click) — worktree+index back to HEAD.
// (b.txt may be untracked-absent after clean -fdq; make it deterministically
// tracked first.)
execSync(`echo base > ${REPO}/b.txt`);
git('add b.txt');
gitTry('commit -qm "base b.txt"');
execSync(`echo discardme >> ${REPO}/b.txt && echo untracked > ${REPO}/u.txt`);
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(900);
const bRow = page.locator('.git-file', { hasText: 'b.txt' }).first();
await bRow.locator('.git-discard-btn').click();
check('discard armed, file untouched', readFileSync(`${REPO}/b.txt`, 'utf8').includes('discardme'));
await page.locator('.git-file', { hasText: 'b.txt' }).locator('.git-discard-btn[data-armed="1"]').click();
await page.waitForTimeout(1200);
check('tracked discard restores HEAD', !readFileSync(`${REPO}/b.txt`, 'utf8').includes('discardme'));

// 4. Discard an untracked file — deleted from disk.
const uRow = page.locator('.git-file', { hasText: 'u.txt' }).first();
await uRow.locator('.git-discard-btn').click();
await page.locator('.git-file', { hasText: 'u.txt' }).locator('.git-discard-btn[data-armed="1"]').click();
await page.waitForTimeout(1200);
check('untracked discard deletes the file', !existsSync(`${REPO}/u.txt`));
check('worktree clean', git('status --porcelain').trim() === '');

await page.screenshot({ path: 'shots/git-amend.png' });
await browser.close();
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git amend/discard checks passed');
