// Code-panel batch checks against a live daemon:
//   root switcher (↑ / ⌂ / ⎇), staged diff toggle, split (MergeView) diff,
//   open-in-editor jump — inside a throwaway git repo at ~/ux-git-test.
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

// 2. Changes list has our two files (file.txt unstaged, staged.txt staged).
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

// 4. Unified diff for file.txt shows the change; staged side is empty;
//    staged.txt's staged side has its line.
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.grow')].find((x) => x.textContent.includes('file.txt'));
  r?.click();
});
await page.waitForTimeout(1000);
const diffText = () => page.evaluate(() => document.getElementById('code-diff').textContent);
check('unified diff has the change', (await diffText()).includes('beta CHANGED'));
const ctlBtns = () => page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].map((b) => b.textContent));
check('controls: unstaged/staged/unified/split/open', (await ctlBtns()).join(',').includes('unstaged,staged,unified,split,open in editor'), (await ctlBtns()).join(','));
await page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].find((b) => b.textContent === 'staged')?.click());
await page.waitForTimeout(900);
check('staged side of file.txt is empty', (await diffText()).includes('(no textual diff)'));
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.grow')].find((x) => x.textContent.includes('staged.txt'));
  r?.click();
});
await page.waitForTimeout(1000);
check('staged.txt unstaged side is empty', (await diffText()).includes('(no textual diff)'));
await page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].find((b) => b.textContent === 'staged')?.click());
await page.waitForTimeout(900);
check('staged.txt staged diff has its line', (await diffText()).includes('three staged'));

// 5. Split view: MergeView renders two editors, and the inserted line is
//    actually visible (a=HEAD vs b=index for the staged side).
await page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].find((b) => b.textContent === 'split')?.click());
await page.waitForTimeout(1500);
const editors = await page.evaluate(() => document.querySelectorAll('#code-diff .cm-editor').length);
check('split view: two side-by-side editors', editors === 2, `editors=${editors}`);
const mergeText = await page.evaluate(() => document.querySelector('#code-diff .cm-mergeView')?.textContent ?? '');
check('split view shows the staged line', mergeText.includes('three staged'), mergeText.slice(0, 80));
await page.screenshot({ path: 'shots/code-split-diff.png' });

// 6. open in editor jumps to the file as a text buffer.
await page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].find((b) => b.textContent === 'open in editor')?.click());
await page.waitForTimeout(1200);
const openPath = await page.evaluate(() => document.getElementById('code-path').textContent);
check('open in editor → staged.txt buffer', openPath?.includes('staged.txt'), openPath ?? '');
await page.screenshot({ path: 'shots/code-open-in-editor.png' });

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('code-panel batch checks passed');
