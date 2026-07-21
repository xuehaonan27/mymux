// Lazy chunk failure recovery (#13): a rejected dynamic import must not
// wedge a panel — the old code set `loading = true` then awaited import()
// with no try/finally, so a stale chunk left every later toggle spinning a
// 50 ms poll forever (plus an unhandled rejection). The fix memoizes the
// in-flight import, resets on failure, and toasts — so every later toggle
// retries and fails FAST again (browsers cache module-load failures in the
// module map, so the real recovery is a reload) instead of spinning
// silently. Exercised on the code panel (the git/hist wrappers share it).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8090, 'lazyload');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message);
  console.error('[pageerror]', e.message);
});
// Break the code panel's chunk: vite serves it as /src/code.ts.
await page.route('**/src/code.ts*', async (route) => route.abort());
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

const toastText = () => page.locator('.toast.show').textContent().catch(() => '');

await page.keyboard.press('Control+e');
await page.waitForFunction(
  () => document.querySelector('.toast.show')?.textContent.includes('failed to load'),
  undefined,
  { timeout: 5000 },
);
check('first failed toggle surfaces the error', ((await toastText()) ?? '').includes('failed to load'));
check('panel did not open', (await page.locator('.code-panel.show').count()) === 0);

// The wedge test: wait for the toast to fade, then toggle again. With the bug
// the second toggle spins silently (no toast, no request); fixed, it retries
// and toasts again — proving the loading flag was reset.
await page.waitForFunction(() => !document.querySelector('.toast.show'), undefined, { timeout: 5000 });
await page.keyboard.press('Control+e');
await page.waitForFunction(
  () => document.querySelector('.toast.show')?.textContent.includes('failed to load'),
  undefined,
  { timeout: 5000 },
);
check('later toggle retries and fails fast (no wedge)', ((await toastText()) ?? '').includes('failed to load'));
check('no unhandled rejections along the way', pageErrors.length === 0, pageErrors.join(' | '));

// Recovery: unblock the chunk and reload — the panel must work again.
await page.unroute('**/src/code.ts*');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
check('panel opens after reload with the chunk back', true);

await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('lazy chunk recovery checks passed');
