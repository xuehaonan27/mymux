// IME-fix (imefix.ts) checks, headless on Chromium with the shim force-enabled
// via ?imefix=1. Scenarios dispatch SYNTHETIC events at xterm's textarea to
// reproduce the WKWebView/Sogou trace family and count pty echoes — each
// commit must land EXACTLY once (or, for the composition path, not be
// double-sent by the shim). The real Mac+Sogou verification stays on-device.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099&imefix=1';
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

// Unique marker suffix — native panes restore a server-side snapshot of the
// scrollback, so fixed markers from an earlier run would double-count.
const RUN = Math.random().toString(36).slice(2, 8);
const M = (k) => `（${k}${RUN}`; // CJK-prefixed unique marker

/** Count marker occurrences across the xterm rows (pty echo ⇒ gated-send count). */
const echoCount = (marker) =>
  page.evaluate(
    (m) => (document.querySelector('.xterm-rows')?.textContent ?? '').split(m).length - 1,
    marker,
  );

// ---- scenario 1: Sogou trace — rescued exactly once ---------------------------
await page.evaluate((d) => {
  const ta = document.querySelector('.xterm-helper-textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true }));
  ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertText', composed: true, bubbles: true, cancelable: true }));
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Process', bubbles: true }));
}, M('r1'));
await page.waitForTimeout(500);
check('non-composition IME commit lands exactly once', (await echoCount(M('r1'))) === 1, `${await echoCount(M('r1'))}`);
// xterm's composition-diff must not re-send residue on the next 229 keydown
await page.keyboard.down('Shift');
await page.keyboard.press('Digit9'); // real key: leaves _keyDownSeen true with no send
await page.keyboard.up('Shift');
await page.waitForTimeout(400);
check('residue not re-sent after the rescue', (await echoCount(M('r1'))) === 1, `${await echoCount(M('r1'))}`);

// ---- scenario 2: no keydown — xterm's own accept lane, shim stays out --------
await page.evaluate((d) => {
  const ta = document.querySelector('.xterm-helper-textarea');
  ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertText', composed: true, bubbles: true, cancelable: true }));
}, M('r2'));
await page.waitForTimeout(500);
check('menu-style IME insert: exactly once (no shim/xterm double)', (await echoCount(M('r2'))) === 1, `${await echoCount(M('r2'))}`);

// ---- scenario 3: real composition trace — the diff lane sends exactly once ----
// Real browser order: 229 keydown → compositionstart → the text lands in the
// textarea → input(insertCompositionText, composed) → compositionend → xterm's
// CompositionHelper flushes the textarea diff on a 0ms timer. xterm's input
// gate rejects (keyDownSeen) and the shim skips (composing/ending) — the only
// sender must be the diff flush, exactly once.
await page.evaluate((d) => {
  const ta = document.querySelector('.xterm-helper-textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
  ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  ta.value = d; // the browser writes committed text into the textarea
  ta.dispatchEvent(new InputEvent('input', { data: d, inputType: 'insertCompositionText', composed: true, bubbles: true, cancelable: true }));
  ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
}, M('r3'));
await page.waitForTimeout(600);
check('composition lane: committed text lands exactly once', (await echoCount(M('r3'))) === 1, `${await echoCount(M('r3'))}`);

// ---- scenario 4: normal typing is untouched -----------------------------------
await page.keyboard.type(`(?${RUN}`);
await page.waitForTimeout(500);
check('plain shift-symbol typing echoes exactly once', (await echoCount(`(?${RUN}`)) === 1, `${await echoCount(`(?${RUN}`)}`);

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('ime-fix checks passed');
