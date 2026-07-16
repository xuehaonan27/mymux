// Terminal-history pager end-to-end: 30k lines of output (older than the
// xterm buffer), scroll to the top of the buffer → the chip appears → the
// pager shows the tail → scrolling the pager up loads genuinely older
// lines (from the raw log, not the buffer).
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
// Unique marker per run: history logs append across daemon restarts, so a
// stale file may already hold an older run's identical sequence.
const M = `TH${Math.floor(Math.random() * 1e6)}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type(`seq -f '${M}-%05g' 1 12000`);
await page.keyboard.press('Enter');
// Let the burst print + flush through ptyd's history writer.
await page.waitForTimeout(4000);
await page.waitForFunction(
  (m) => document.querySelector('.xterm-rows')?.textContent?.includes(`${m}-120`),
  M,
  { timeout: 15000 },
);

// Scroll the terminal to the very top of the buffer (Shift+PageUp pages —
// headless wheel coalesces to nothing, and 12000 lines >> 10000-line buffer).
let chipUp = false;
for (let i = 0; i < 400 && !chipUp; i++) {
  await page.keyboard.press('Shift+PageUp');
  if (i % 25 === 24) {
    chipUp = (await page.locator('.term-older:visible').count()) === 1;
  }
}
await page.waitForTimeout(800);
chipUp = chipUp || (await page.locator('.term-older:visible').count()) === 1;
check('scroll-top chip appears', chipUp);

// Open the pager: the tail page holds the LAST lines…
await page.locator('.term-older').first().click();
await page.locator('.termhist.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
const body = page.locator('.termhist-body');
const text0 = await body.textContent();
check('pager shows the tail', (text0 ?? '').includes(`${M}-12000`));
check('but not the beginning', !(text0 ?? '').includes(`${M}-00001`), (text0 ?? '').slice(0, 80));
check('header names the log size', ((await page.locator('.termhist-hd').textContent()) ?? '').includes('bytes logged'));

// Scroll the pager up: older pages from the RAW log (beyond the buffer).
await body.evaluate((b) => (b.scrollTop = 0));
await page.waitForTimeout(1200);
await body.evaluate((b) => (b.scrollTop = 0));
await page.waitForTimeout(1200);
await body.evaluate((b) => (b.scrollTop = 0));
await page.waitForTimeout(1500);
const text1 = await body.textContent();
check('older pages reach the beginning', (text1 ?? '').includes(`${M}-00001`), (text1 ?? '').slice(0, 80));

// Esc closes via the modal stack.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('Esc closes the pager', (await page.locator('.termhist.show').count()) === 0);

await page.screenshot({ path: 'shots/termhist.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('terminal-history checks passed');
