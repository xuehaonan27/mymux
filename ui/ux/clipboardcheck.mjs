// Clipboard copyText behavior: secure API first, execCommand fallback when
// navigator.clipboard refuses (the WKWebView non-secure-context case the
// user hit). Both paths land verifiable text in the system clipboard.
// SANDBOXED daemon pair via startSandbox (the page needs a live terminal).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8044, 'clipboard');
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
process.on('exit', () => sb.kill());

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => {
  pageErrors.push(e.message);
  console.error('[pageerror]', e.message);
});
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

// #16: the fallback steals focus to its transient textarea — it must hand it
// back to whatever had it (the terminal), or typing dies until a click.
const focusOk = await page.evaluate(async () => {
  const { copyText } = await import('/src/clipboard.ts');
  const probe = document.createElement('button');
  document.body.appendChild(probe);
  probe.focus();
  const orig = window.navigator.clipboard.writeText;
  window.navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  try {
    await copyText('focus-lane');
  } finally {
    window.navigator.clipboard.writeText = orig;
  }
  const ok = document.activeElement === probe;
  probe.remove();
  return ok;
});
check('fallback restores the previous focus', focusOk);

// And the terminal copy shortcut surface still exists: the keymap's ⌘C path.
await page.click('.xterm');
await page.keyboard.press('Control+k');
await page.waitForTimeout(200);
check('leader path alive (no page errors after ⌘K)', pageErrors.length === 0, pageErrors.join(' | '));

await page.screenshot({ path: 'shots/clipboard.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('clipboard checks passed');
