// Changes-page workbench end-to-end (design B): the code panel's changes
// rows deep-link HERE; the stageable diff (unified/split/controls/palette)
// lives in the git surface's workbench. Fixture ~/ux-git-test (same one
// codecheck uses: file.txt unstaged + staged.txt staged).
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
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

// 1. The deep link: clicking file.txt's change row closes the editor and
// opens the git surface ON this file's diff.
await page.locator('.grow', { hasText: 'file.txt' }).first().click();
await page.waitForTimeout(1500);
check('editor closed for the jump', (await page.locator('.code-panel.show').count()) === 0);
check('git surface opened', (await page.locator('.git-panel.show').count()) === 1);
check('changes page is default', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('Changes'));
const workTitle = (await page.locator('.git-workbench .git-detail-title').textContent()) ?? '';
check('workbench diff for file.txt', workTitle.includes('file.txt'), workTitle);
const ctlBtns = () => page.evaluate(() => [...document.querySelectorAll('.diff-ctl-btn')].map((b) => b.textContent));
check('controls: unstaged/staged/unified/split/open', (await ctlBtns()).join(',').startsWith('unstaged,staged,unified,split,open in editor'), (await ctlBtns()).join(','));

// 2. Unified stageable diff renders with the change marked selectable.
check('selectable +/- rows', (await page.locator('.dl.sline').count()) >= 1);
check('unified diff has the change', ((await page.locator('.code-diff').textContent()) ?? '').includes('beta CHANGED'));

// 3. Staged side of file.txt is empty.
await page.locator('.diff-ctl-btn', { hasText: /^staged$/ }).first().click();
await page.waitForTimeout(900);
check('staged side empty', ((await page.locator('.code-diff').textContent()) ?? '').includes('(no textual diff)'));

// 4. Split view: two side-by-side editors, merge palette intact.
await page.locator('.diff-ctl-btn', { hasText: 'unstaged' }).first().click();
await page.waitForTimeout(800);
await page.locator('.diff-ctl-btn', { hasText: 'split' }).click();
await page.waitForTimeout(1500);
check('split: two editors', (await page.locator('.code-diff .cm-editor').count()) === 2);
const mergeStyle = await page.evaluate(() => {
  const t = document.querySelector('.code-diff .cm-merge-b .cm-changedText');
  const l = document.querySelector('.code-diff .cm-merge-b .cm-changedLine');
  return {
    fg: t ? getComputedStyle(t).color : '(no changedText)',
    bg: l ? getComputedStyle(l).backgroundColor : '(no changedLine)',
  };
});
check('split: inserted text takes palette fg', mergeStyle.fg === 'rgb(126, 231, 135)', mergeStyle.fg);
check('split: inserted line takes palette bg', /rgba\(63, 185, 80/.test(mergeStyle.bg), mergeStyle.bg);

// 5. 'open in editor' jumps back to the editor with that file.
await page.locator('.diff-ctl-btn', { hasText: 'open in editor' }).click();
await page.waitForTimeout(1500);
check('back in the editor on the same file', ((await page.locator('#code-path').textContent()) ?? '').includes('file.txt'));

// 6. Hist button → History page in file-history mode on the same file.
await page.locator('.grow', { hasText: 'file.txt' }).first().click();
await page.waitForTimeout(1200);
await page.locator('.diff-ctl-btn', { hasText: 'Hist' }).click();
await page.waitForTimeout(1200);
check('Hist switches to History page', ((await page.locator('.git-tab.on').textContent()) ?? '').includes('History'));
check('file-history chip shows', ((await page.locator('.git-filefilter').textContent()) ?? '').includes('file.txt'));

await page.screenshot({ path: 'shots/git-changes.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git changes workbench checks passed');
