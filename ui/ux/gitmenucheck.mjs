// Commit context-menu ops end-to-end against ~/ux-git-ops (the ops fixture
// with a local bare remote): cherry-pick, revert, copy hash, branch
// checkout, reset --hard (two-click confirm), menu-only Esc.
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
const gitTry = (args) => {
  try {
    return git(args);
  } catch {
    return '';
  }
};

// Clean slate: master at origin/master, pristine tree, no `side` branch.
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D side');

// A side commit to cherry-pick from.
git('checkout -q -b side');
execSync(`echo side > ${REPO}/side.txt`);
git('add -A');
git('commit -qm "side: add side.txt"');
git('checkout -q master');

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
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

// 1. Right-click the side commit → Cherry-pick → lands on master (HEAD).
const sideRow = page.locator('.git-row', { hasText: 'side: add side.txt' }).first();
await sideRow.click({ button: 'right' });
await page.locator('.git-menu').waitFor();
check('row menu opens', (await page.locator('.git-menu-item').count()) === 8);
await page.click('.git-menu-item:text-is("Cherry-pick onto HEAD")');
await page.waitForTimeout(1500);
check('cherry-pick landed on master', git('log -1 --format=%s').includes('side: add side.txt'));
check('menu closed after the op', (await page.locator('.git-menu').count()) === 0);

// 2. Right-click the HEAD row → Revert → a Revert commit lands.
const headRow = () => page.locator('.git-row:has(.git-ref-head)').first();
await headRow().click({ button: 'right' });
await page.click('.git-menu-item:text-is("Revert this commit")');
await page.waitForTimeout(1500);
check('revert landed', git('log -1 --format=%s').startsWith('Revert "side: add side.txt"'));

// 3. Reset --hard back to origin/master: first click only ARMS the item.
const omRow = page.locator('.git-row:has(.git-ref:text("origin/master"))').first();
await omRow.click({ button: 'right' });
await page.click('.git-menu-item:text-is("Reset --hard here")');
check('hard reset armed, not run', git('log -1 --format=%s').startsWith('Revert'));
check('menu stays open while armed', (await page.locator('.git-menu').count()) === 1);
await page.click('.git-menu-item[data-armed="1"]');
await page.waitForTimeout(1500);
check('reset --hard back to origin/master', git('rev-parse HEAD').trim() === git('rev-parse origin/master').trim());
check('tree pristine after hard reset', git('status --porcelain').trim() === '');

// 4. Right-click the `side` branch badge → check out.
const sideBadge = page.locator('.git-ref-branch', { hasText: 'side' }).first();
await sideBadge.click({ button: 'right' });
await page.locator('.git-menu').waitFor();
await page.click('.git-menu-item:text-is("Check out side")');
await page.waitForTimeout(1500);
check('badge checkout switched branches', git('branch --show-current').trim() === 'side');

// 5. Copy hash via the row menu.
const firstRowHash = page.locator('.git-row:has(.git-ref-head)').first();
await firstRowHash.click({ button: 'right' });
await page.click('.git-menu-item:text-is("Copy hash")');
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('clipboard has the full hash', /^[0-9a-f]{40}$/.test(clip) && clip === git('rev-parse HEAD').trim());

// 6. Esc with the menu open closes ONLY the menu (the panel survives).
await page.locator('.git-row').first().click({ button: 'right' });
await page.locator('.git-menu').waitFor();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc closes the menu only', (await page.locator('.git-menu').count()) === 0);
check('panel still open after that Esc', (await page.locator('.git-panel.show').count()) === 1);

await page.screenshot({ path: 'shots/git-menu.png' });
await browser.close();

// Leave the fixture on master for the other checks.
git('checkout -q master');
gitTry('branch -D side');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git context-menu checks passed');
