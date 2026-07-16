// Code-panel batch checks against a live daemon:
//   root switcher (↑ / ⌂ / ⎇), changes list rows (deep links into the git
//   surface since design B — diff checks live in gitchangescheck.mjs now)
//   — inside a throwaway git repo at ~/ux-git-test.
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

// Point the pane at the test repo (the panel roots at the pane's cwd).
await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-git-test');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

const rootPath = () => page.evaluate(() => document.getElementById('code-root-path').textContent);
const clickRoot = (id) => page.click(`#${id}`);

// 1. Root starts at the pane cwd (the test repo).
check('root = pane cwd (the repo)', (await rootPath())?.endsWith('/ux-git-test'), await rootPath());

// 2. Changes list has our two files (file.txt unstaged, staged.txt staged) —
//    now deep links into the git surface (badges intact).
const changeRows = () => page.evaluate(() => [...document.querySelectorAll('.grow')].map((r) => r.textContent));
const rows = await changeRows();
check('changes: file.txt + staged.txt', rows.some((r) => r.includes('file.txt')) && rows.some((r) => r.includes('staged.txt')), JSON.stringify(rows));

// 3. Root switcher: ↑ climbs one level (stays inside $HOME — the daemon
//    rejects overrides outside it), ⌂ returns, ⎇ stays at the toplevel.
await clickRoot('root-up');
await page.waitForTimeout(900);
check('↑ → parent (home)', (await rootPath()) === '/home/xuehaonan', await rootPath());
const treeHasHome = await page.evaluate(
  () =>
    [...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('ux-git-test')) &&
    [...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('mymux')),
);
check('parent tree lists home contents', treeHasHome);
await clickRoot('root-home');
await page.waitForTimeout(900);
check('⌂ → back to pane cwd', (await rootPath())?.endsWith('/ux-git-test'), await rootPath());
await clickRoot('root-repo');
await page.waitForTimeout(900);
check('⎇ → repo toplevel', (await rootPath())?.endsWith('/ux-git-test'), await rootPath());

// 4. A changes row deep-links: editor closes, git surface opens (the repo's
//    Changes page greets it — full workbench flow is gitchangescheck's).
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.grow')].find((x) => x.textContent.includes('file.txt'));
  r?.click();
});
await page.waitForTimeout(1500);
check('changes row deep-links to the git surface', (await page.locator('.git-panel.show').count()) === 1 && (await page.locator('.code-panel.show').count()) === 0);
check('Changes page on top', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('Changes'));
check('workbench opened on file.txt', ((await page.locator('.git-workbench .git-detail-title').textContent()) ?? '').includes('file.txt'));

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('code-panel batch checks passed');
