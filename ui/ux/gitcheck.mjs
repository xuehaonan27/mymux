// Git surface structure end-to-end (design B): Changes page default with its
// uncommitted workbench, History page with pure swim-lane topology, commit
// detail, and modal-stack Esc — against ~/ux-git-test.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-test');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(900);

// 1. History is the default landing — the branch graph is what orients you;
// the swim-lane svg is right there when the surface opens.
check('History tab is default', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('History'));
check('swim-lane svg rendered on open', (await page.locator('.git-lanes circle').count()) >= 1);

// 2. Changes page: uncommitted section + stage affordances.
await page.click('.git-tab[data-page="changes"]');
await page.waitForTimeout(900);
check('Changes tab switches over', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('Changes'));
const sideTitle = (await page.locator('.git-changes-side .git-detail-title').first().textContent()) ?? '';
check('uncommitted section lists its files (2)', sideTitle.includes('Uncommitted Changes (2)'), sideTitle);
check('file rows have stage buttons', (await page.locator('.git-changes-side .git-file .git-stage-btn').count()) >= 2);
check('commit box present', (await page.locator('.git-commit-input').count()) === 1);
check('stash section present', ((await page.locator('.git-changes-side').textContent()) ?? '').includes('Stashes ('));

// 3. File row → workbench stageable diff.
await page.locator('.git-changes-side .git-file', { hasText: 'file.txt' }).first().click();
await page.waitForTimeout(900);
check('workbench diff for the file', ((await page.locator('.git-workbench .git-detail-title').textContent()) ?? '').includes('file.txt'));
check('stageable rows render', (await page.locator('.git-workbench .dl.sline').count()) >= 1);

// 4. History page: pure topology (no pseudo-rows), lanes svg, HEAD badge.
await page.click('.git-tab[data-page="history"]');
await page.waitForTimeout(900);
const rowCount = await page.locator('.git-row').count();
check(`history rows are commits only (${rowCount})`, rowCount >= 3);
const firstSubject = (await page.locator('.git-row .git-subject').first().textContent()) ?? '';
check('no uncommitted pseudo-row on top', !firstSubject.includes('Uncommitted Changes'), firstSubject);
check('swim-lane svg rendered', (await page.locator('.git-lanes circle').count()) >= 1);
check('HEAD badge on a row', (await page.locator('.git-ref-head').count()) >= 1);
await page.screenshot({ path: 'shots/git-graph.png' });

// 4. Commit click → meta + files + whole-commit diff.
await page.locator('.git-row').nth(1).click();
await page.waitForTimeout(700);
check('commit detail shows hash', (await page.locator('.git-detail-title .git-hash').count()) === 1);
check('commit detail diff renders', (await page.locator('.git-detail .git-diff .dl').count()) > 0);
await page.screenshot({ path: 'shots/git-commit.png' });

// 5. Esc (modal stack) closes the surface.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc closes the surface', (await page.locator('.git-panel.show').count()) === 0);

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git surface structure checks passed');
