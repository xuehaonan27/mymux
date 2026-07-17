// Editor copy/paste checks (Chromium proxy for the webview): select-all +
// copy lands the buffer on the clipboard; clearing + paste restores it;
// cursor paste inserts at the caret.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

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

await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-code-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);

// Open alpha.txt from the tree.
await page.fill('#code-search-input', 'alpha');
await page.waitForSelector('#code-hits .chit', { timeout: 5000 });
await page.locator('#code-hits .chit').first().click();
await page.waitForTimeout(1000);
check('alpha.txt open', ((await page.locator('#code-path').textContent()) ?? '').includes('alpha.txt'));

// Select-all, copy — the clipboard must carry the whole buffer.
await page.click('.cm-content');
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+c');
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR:${e.message}`));
check('⌘C lands on the system clipboard', clip === 'needle alpha hit\n', JSON.stringify(clip));

// Clear the buffer (select-all + Delete) and paste it back — round-trip.
await page.keyboard.press('Control+a');
await page.keyboard.press('Delete');
let doc = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
check('buffer cleared before paste', !doc.includes('needle'));
await page.keyboard.press('Control+v');
await page.waitForTimeout(400);
doc = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
check('⌘V restores the buffer', doc === 'needle alpha hit', JSON.stringify(doc.slice(0, 60)));

// Caret paste inserts a marker at the cursor (Home-ish position).
await page.keyboard.press('ArrowUp'); // collapse selection to start of line 1
await page.keyboard.press('Control+v');
await page.waitForTimeout(400);
doc = await page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
check('caret paste inserts at cursor', doc === 'needle alpha hitneedle alpha hit', JSON.stringify(doc.slice(0, 60)));

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('editor copy/paste checks passed');
