// Stash management end-to-end against ~/ux-git-ops: toolbar Stash push,
// stash rows in the graph, detail Apply/Pop/Drop (two-click), row menu Pop.
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
const stashCount = () => git('stash list').trim().split('\n').filter(Boolean).length;

// Clean slate: pristine tree on master, empty stash stack.
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
git('stash clear');

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
await page.click('.git-tab[data-page="changes"]'); // default landing is the History graph now
await page.locator('.git-changes-side .git-detail-title').first().waitFor({ timeout: 10000 });

// 1. Dirty a tracked file, refresh, then stash from the toolbar.
execSync(`date >> ${REPO}/a.txt`);
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(900);
check('uncommitted card shows the dirt', (await page.locator('.git-changes-side .git-detail-title').first().textContent())?.includes('Uncommitted Changes (1)'));
await page.click('.git-toolbar .pkgs-btn:text-is("Stash")');
await page.waitForTimeout(1500);
check('stash entry created', stashCount() === 1);
check('tree clean after push', git('status --porcelain').trim() === '');
check('uncommitted card gone', (await page.locator('.git-file').count()) === 0);
check('stash row present', (await page.locator('.git-stash-row').count()) === 1);

// 2. Open the stash detail: actions + the stashed diff.
await page.locator('.git-stash-row').first().click();
await page.waitForTimeout(900);
check('detail titled with the entry', (await page.locator('.git-workbench .git-detail-title').first().textContent())?.includes('WIP on '));
const actionLabels = await page.locator('.git-workbench .git-bulk .pkgs-btn').allTextContents();
check('Apply/Pop/Drop actions', actionLabels.join(',') === 'Apply,Pop,Drop');
check('stash diff renders', (await page.locator('.git-workbench .git-diff .dl').count()) > 0);

// 3. Apply keeps the entry and brings the dirt back.
await page.click('.git-workbench .pkgs-btn:text-is("Apply")');
await page.waitForTimeout(1500);
check('apply re-dirtied the tree', git('status --porcelain').includes('a.txt'));
check('apply kept the entry', stashCount() === 1);

// 4. Drop is a two-click arm; the tree keeps its dirt.
await page.locator('.git-stash-row').first().click();
await page.waitForTimeout(600);
const drop = page.locator('.git-workbench .pkgs-btn.git-danger');
await drop.click();
check('drop armed, not run', stashCount() === 1);
await page.locator('.git-workbench .pkgs-btn.git-danger[data-armed="1"]').click();
await page.waitForTimeout(1500);
check('drop ran on the second click', stashCount() === 0);
check('tree kept its dirt', git('status --porcelain').includes('a.txt'));

// 5. Row-menu Pop: stash again, right-click the row, Pop → gone + dirty.
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(600);
await page.click('.git-toolbar .pkgs-btn:text-is("Stash")');
await page.waitForTimeout(1500);
check('stashed again', stashCount() === 1 && git('status --porcelain').trim() === '');
await page.locator('.git-stash-row').first().click({ button: 'right' });
await page.locator('.git-menu').waitFor();
check('stash menu has 3 items', (await page.locator('.git-menu-item').count()) === 3);
await page.click('.git-menu-item:text-is("Pop (apply + drop)")');
await page.waitForTimeout(1500);
check('pop emptied the stack', stashCount() === 0);
check('pop re-dirtied the tree', git('status --porcelain').includes('a.txt'));

await page.screenshot({ path: 'shots/git-stash.png' });
await browser.close();

// Leave the fixture pristine.
git('reset -q --hard origin/master');
git('clean -fdq');
git('stash clear');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git stash checks passed');
