// Git graph panel end-to-end against ~/ux-git-test (real repo: uncommitted
// changes + commit history).
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

// Aim the focused pane at the test repo, then open the graph.
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-test');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.waitForSelector('.git-row', { timeout: 10000 });
await page.waitForTimeout(800);

const rowCount = await page.locator('.git-row').count();
check(`rows: uncommitted + history (${rowCount})`, rowCount >= 3);
const firstText = await page.locator('.git-row').first().textContent();
check('top row is the uncommitted card', firstText?.includes('Uncommitted Changes (2)'));
check('swim-lane svg rendered', (await page.locator('.git-lanes circle').count()) >= rowCount - 1);
check('HEAD badge on a row', (await page.locator('.git-ref-head').count()) >= 1);
await page.screenshot({ path: 'shots/git-graph.png' });

// 1. Select the uncommitted card → changed files; one click → diff lines.
await page.locator('.git-row').first().click();
await page.waitForTimeout(400);
check('uncommitted detail lists files', (await page.locator('.git-file').count()) >= 2);
await page.locator('.git-file', { hasText: 'file.txt' }).first().click();
await page.waitForTimeout(500);
check('uncommitted file diff renders', (await page.locator('.git-diff .dl').count()) > 0);

// 2. Select a commit → meta + files + whole-commit diff.
await page.locator('.git-row').nth(1).click();
await page.waitForTimeout(700);
check('commit detail shows hash', (await page.locator('.git-detail-title .git-hash').count()) === 1);
check('commit detail diff renders', (await page.locator('.git-diff .dl').count()) > 0);
await page.screenshot({ path: 'shots/git-commit.png' });

// 3. Esc (modal stack) closes it.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc closes the graph', (await page.locator('.git-panel.show').count()) === 0);

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git graph checks passed');
