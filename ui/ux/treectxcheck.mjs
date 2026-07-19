// Tree polish checks: the tree surfaces slow/failing lists as status rows
// (never a silent blank), and rows carry a VS Code-style right-click menu
// (Copy Relative/Absolute Path). Fixture ~/ux-git-tree (sub/inner.txt among
// others); the unreadable-dir case is staged live via chmod.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8093, 'treectx');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

// Stage: an unreadable dir (EACCES → daemon 404) with content behind it.
execSync('mkdir -p ~/ux-git-tree/locked && echo inside > ~/ux-git-tree/locked/inside.txt && chmod 000 ~/ux-git-tree/locked');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.locator('#code-tree .trow').first().waitFor({ timeout: 10000 });

// ---- error row + click-to-retry on an unreadable dir ---------------------------
const locked = page.locator('#code-tree .trow', { hasText: 'locked' }).first();
await locked.click();
await page.waitForTimeout(900);
const errRow = page.locator('#code-tree .trow.tstat.retry');
check('unreadable dir shows a retryable error row', (await errRow.count()) === 1, (await page.locator('#code-tree').textContent())?.slice(0, 100));
execSync('chmod 755 ~/ux-git-tree/locked');
if ((await errRow.count()) === 1) await errRow.click();
await page.waitForTimeout(900);
check('retry lists the dir after chmod', (await page.locator('#code-tree .trow', { hasText: 'inside.txt' }).count()) === 1);

// Collapse it back so later trees are tidy, then dismiss-proof the menu.
await locked.click();
await page.waitForTimeout(400);

// ---- right-click menu: copy relative path ---------------------------------------
const rightNow = async (loc) => {
  const b = await loc.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await page.locator('.git-menu').waitFor({ timeout: 5000 });
};
const itemTexts = () =>
  page.evaluate(() => [...document.querySelectorAll('.git-menu-item')].map((b) => b.textContent));

// inner.txt nests under sub/ — expand it first.
await page.locator('#code-tree .trow.tdir', { hasText: 'sub' }).first().click();
await page.locator('#code-tree .trow', { hasText: 'inner.txt' }).first().waitFor({ timeout: 5000 });

await rightNow(page.locator('#code-tree .trow', { hasText: 'inner.txt' }).first());
check('menu offers both copy paths', JSON.stringify(await itemTexts()).includes('Copy Relative Path') && JSON.stringify(await itemTexts()).includes('Copy Absolute Path'), (await itemTexts()).join(','));
await page.locator('.git-menu-item', { hasText: 'Copy Relative Path' }).click();
await page.waitForTimeout(500);
check('relative path copied', (await page.evaluate(() => navigator.clipboard.readText())) === 'sub/inner.txt');
check('menu closed after the action', (await page.locator('.git-menu').count()) === 0);

// ---- right-click menu: copy absolute path (dir row) ------------------------------
await rightNow(page.locator('#code-tree .trow.tdir', { hasText: 'sub' }).first());
await page.locator('.git-menu-item', { hasText: 'Copy Absolute Path' }).click();
await page.waitForTimeout(500);
const abs = await page.evaluate(() => navigator.clipboard.readText());
check('absolute path copied', abs.endsWith('/ux-git-tree/sub'), abs);

// ---- outside click dismisses -----------------------------------------------------
await rightNow(page.locator('#code-tree .trow.tdir', { hasText: 'sub' }).first());
await page.click('#code-path'); // anywhere outside the menu
await page.waitForTimeout(300);
check('outside click dismisses the menu', (await page.locator('.git-menu').count()) === 0);

// ---- root-list failure: AUTO retry + heal without a click ----------------------
// chmod the root away, reopen the panel: the tree must retry on its own and
// recover once the listing works again (the "daemon unreachable ... then it
// mysteriously healed" report — the new behaviour makes the mechanism visible).
try {
  execSync('chmod 000 ~/ux-git-tree');
  await page.keyboard.press('Control+e'); // close
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+e'); // reopen → root listing fails
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const retryText = (await page.locator('#code-tree .trow.tstat').first().textContent()) ?? '';
  check('root failure shows the AUTO retry with countdown', /retry 1\/\d/.test(retryText), retryText);
  execSync('chmod 755 ~/ux-git-tree');
  await page.waitForTimeout(3400); // inside the 2.5s backoff
  const treeText = (await page.locator('#code-tree').textContent()) ?? '';
  check('auto-retry recovers with no click', treeText.includes('sub') && !treeText.includes('retry'), treeText.slice(0, 120));
} finally {
  execSync('chmod 755 ~/ux-git-tree');
}

execSync('rm -rf ~/ux-git-tree/locked');
await page.screenshot({ path: 'shots/treectx.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('tree polish checks passed');
