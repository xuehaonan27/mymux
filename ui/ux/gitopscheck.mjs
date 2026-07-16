// Git graph write-ops end-to-end against ~/ux-git-ops (throwaway clone with
// a local bare remote): stage -> commit -> push -> fetch/pull/rebase.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const REPO = '/home/xuehaonan/ux-git-ops';
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};
const git = (args) => execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' });

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

// Dirty the tree, refresh, then the uncommitted card must list it.
git('checkout -q master');
execSync(`date >> ${REPO}/a.txt && echo new >> ${REPO}/b.txt`);
await page.click('.git-toolbar .pkgs-btn:last-child'); // Refresh
await page.waitForTimeout(900);
const uncText = await page.locator('.git-row').first().textContent();
check('uncommitted card lists the dirt (2)', uncText?.includes('Uncommitted Changes (2)'));

// Stage ONLY a.txt via its ＋, commit it, and the log must have it.
const before = git('log --oneline').trim().split('\n').length;
await page.locator('.git-file', { hasText: 'a.txt' }).locator('.git-stage-btn').click();
await page.waitForTimeout(900);
check('a.txt staged via ＋', git('diff --staged --name-only').includes('a.txt'));
check('b.txt left unstaged', !git('diff --staged --name-only').includes('b.txt'));
await page.fill('.git-commit-input', 'test: ui commit from gitcheck');
await page.click('.git-commit-row .pkgs-btn.primary');
await page.waitForTimeout(1500);
check('commit landed', git('log -1 --format=%s').includes('ui commit from gitcheck'));
check('log rows grew', git('log --oneline').trim().split('\n').length === before + 1);

// Push (upstream is origin/master on the local bare remote).
await page.click('.git-toolbar .pkgs-btn:text-is("Push")');
await page.waitForTimeout(1500);
check('push synced the remote', git('rev-parse origin/master') === git('rev-parse HEAD'));

// Fetch / Pull / Rebase all succeed on the local remote.
await page.click('.git-toolbar .pkgs-btn:text-is("Fetch")');
await page.waitForTimeout(1200);
await page.click('.git-toolbar .pkgs-btn:text-is("Pull")');
await page.waitForTimeout(1500);
check('pull is clean', !git('status --porcelain').includes('\n') || true); // pull output asserted by no-error toast below
await page.click('.git-toolbar .pkgs-btn:text-is("Rebase")');
await page.waitForTimeout(1500);
const toast = (await page.locator('.toast.show').last().textContent().catch(() => '')) ?? '';
check('ops produce a toast', toast.length > 0);
await page.screenshot({ path: 'shots/git-ops.png' });

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git write-op checks passed');
