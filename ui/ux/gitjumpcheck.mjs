// Git → editor reverse-jump checks: the Changes workbench row's ✎ and a
// commit detail row's ✎ both leave the git surface and land the code panel's
// editor on that file. Fixture ~/ux-git-test (file.txt unstaged, staged.txt
// staged, one init commit containing both).
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
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-test');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);

const editorAt = async () => (await page.locator('#code-path').textContent()) ?? '';
const panelState = async () =>
  `code=${await page.locator('.code-panel.show').count()} git=${await page.locator('.git-panel.show').count()} path=${await editorAt()}`;
const landedInEditor = async (file) =>
  (await page.locator('.code-panel.show').count()) === 1 &&
  (await page.locator('.git-panel.show').count()) === 0 &&
  (await editorAt()).endsWith(file);

// ---- 1. Changes row ✎ ----------------------------------------------------------
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1000);
check('history graph is the default landing', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('History'));
await page.locator('.git-tab', { hasText: 'Changes' }).click();
await page.waitForTimeout(900);
const row = page.locator('.git-changes-side .git-file', { hasText: 'file.txt' }).first();
check('row exposes the ✎ jump', (await row.locator('.git-open-btn').count()) === 1);
await row.locator('.git-open-btn').click();
// Cold dynamic import of the code chunk can outlast a fixed sleep — wait on
// the panel itself.
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(400);
check('✎ jumps from Changes to the editor', await landedInEditor('file.txt'), await panelState());

// ---- 2. Commit detail row ✎ ----------------------------------------------------
await page.keyboard.press('Control+e'); // back to the terminals
await page.locator('.code-panel.show').waitFor({ state: 'hidden', timeout: 5000 });
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
// Reopening preserves the last-used page (Changes here, by design) → back to
// History for the commit detail.
await page.locator('.git-tab', { hasText: 'History' }).click();
await page.locator('.git-row').first().waitFor({ timeout: 10000 });
// The shared fixture's history contains EMPTY service commits — click down the
// rows until a commit's detail actually lists files.
let drow = null;
let fname = '';
const rowCount = await page.locator('.git-row').count();
for (let i = 0; i < Math.min(rowCount, 8); i++) {
  await page.locator('.git-row').nth(i).click();
  await page.waitForTimeout(700);
  const files = page.locator('.git-detail .git-file');
  if ((await files.count()) > 0) {
    drow = files.first();
    fname = ((await drow.locator('.git-file-path').textContent()) ?? '').trim();
    break;
  }
}
check('a commit with files found', drow != null, `rows=${rowCount}`);
check('detail row exposes the ✎ jump', drow != null && (await drow.locator('.git-open-btn').count()) === 1);
if (drow) {
  await drow.locator('.git-open-btn').click();
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  check('✎ jumps from History detail to the editor', await landedInEditor(fname), await panelState());
}

await page.screenshot({ path: 'shots/gitjump.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git→editor reverse-jump checks passed');
