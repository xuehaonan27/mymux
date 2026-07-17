// IME composition lane: Chromium's IME-insertText path (what a real IME
// hands the webview via composition events) must reach the pty and echo
// back. This is the upper bound we can verify headless — WRY+macOS+third-
// party IME specifics (sogou) stay Mac-verify-pending.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');

// shell echo: type a composed phrase via the IME API then confirm with echo —
// the pane only shows correctly when both input AND output bytes round-trip.
await page.keyboard.type(`echo MARKER-`);
await page.keyboard.insertText('拼音{符号}@A');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
const termText = (await page.locator('.xterm-rows').textContent()) ?? '';
check('IME-inserted CJK reaches the pty', termText.includes('拼音'), termText.slice(-200));
check('IME-inserted shifted symbols reach the pty', termText.includes('{符号}@A'), termText.slice(-200));

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('IME composition checks passed');
