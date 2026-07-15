// Tab drag-reorder check: drag the last tab onto the first, assert the DOM
// order changes AND survives a page reload (the daemon owns the global
// tab_order and rides it in the ptyd blob).
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

const tabNames = () =>
  page.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent));
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

// Ensure exactly 3 tabs: create shells until we have 3.
for (let i = await page.locator('#tabs .tab').count(); i < 3; i++) {
  await page.keyboard.press('Control+k');
  await page.keyboard.press('n');
  await page.waitForFunction(
    (want) => document.querySelectorAll('#tabs .tab').length === want,
    i + 1,
    { timeout: 10000 },
  );
  await page.waitForTimeout(700);
}
const before = await tabNames();
check('3 tabs to start', before.length === 3, JSON.stringify(before));

// Drag the LAST tab onto the FIRST tab → it should land in front.
await page.dragAndDrop('#tabs .tab >> nth=2', '#tabs .tab >> nth=0');
await page.waitForTimeout(1200);
const after = await tabNames();
const expect = [before[2], before[0], before[1]];
check('drag reorders the DOM', JSON.stringify(after) === JSON.stringify(expect), JSON.stringify(after));

// Reload → the daemon hands back the same order (tab_order is daemon-owned).
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
const reloaded = await tabNames();
check(
  'order survives a page reload',
  JSON.stringify(reloaded) === JSON.stringify(expect),
  JSON.stringify(reloaded),
);

await page.screenshot({ path: 'shots/drag-reorder.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('tab drag-reorder checks passed');
