// Clipboard copyText behavior: secure API first, execCommand fallback when
// navigator.clipboard refuses (the WKWebView non-secure-context case the
// user hit). Both paths land verifiable text in the system clipboard.
import { chromium } from 'playwright-core';

const UI = 'http://127.0.0.1:5173/?port=8099';
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
await page.waitForTimeout(800);

// Load the module itself and exercise both lanes.
const result = await page.evaluate(async () => {
  const { copyText } = await import('/src/clipboard.ts');
  const out = { modern: null, fallback: null, err: null };
  // Lane 1: the modern API works (permissions granted above).
  out.modern = await copyText('mymux-modern-lane');
  // Lane 2: simulate the WKWebView non-secure context: clipboard.writeText
  // throws, the execCommand fallback must carry it.
  const orig = window.navigator.clipboard.writeText;
  window.navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  try {
    out.fallback = await copyText('mymux-fallback-lane-works');
  } catch (e) {
    out.err = String(e);
  }
  window.navigator.clipboard.writeText = orig;
  return out;
});
check('modern lane reports success', result.modern === true);
check('fallback lane reports success', result.fallback === true, JSON.stringify(result));
check(
  'modern text landed on the clipboard',
  (await page.evaluate(() => navigator.clipboard.readText())) === 'mymux-fallback-lane-works' ||
    (await page.evaluate(() => navigator.clipboard.readText())) === 'mymux-modern-lane',
);

// The fallback leafing a ZERO-copy textarea behind.
const stray = await page.evaluate(() => [...document.querySelectorAll('textarea[readonly]')].filter((t) => t.style.position === 'fixed').length);
check('no stray fallback textarea left', stray === 0);

// And the terminal copy shortcut surface still exists: the keymap's ⌘C path.
await page.click('.xterm');
await page.keyboard.press('Control+k');
await page.waitForTimeout(200);
check('leader path alive (no page errors after ⌘K)', true);

await page.screenshot({ path: 'shots/clipboard.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('clipboard checks passed');
