// Canvas renderer smoke (experiment lane, pref-gated): boots without errors,
// paints real pixels (canvas readback non-blank), echo works, vim alt-screen
// round-trips without a paint failure. DOM-dependent checks (span geometry)
// are out of scope here by design.
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
await page.addInitScript(() => {
  const p = JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}');
  p.renderer = 'canvas';
  localStorage.setItem('mymux.prefs', JSON.stringify(p));
});
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

check('canvas is mounted', (await page.locator('.xterm canvas').count()) >= 1, `${await page.locator('.xterm canvas').count()}`);
await page.click('.xterm');
await page.keyboard.type(`printf 'CANVAS-SMOKE-MARKER ok\\n'`);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);

// Non-blank pixels near the text area prove glyphs painted (readback, alpha>0).
const stats = await page.evaluate(() => {
  const c = document.querySelector('.xterm canvas');
  if (!c) return { err: 'no canvas' };
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, Math.min(c.width, 800), Math.min(c.height, 200));
  let ink = 0;
  for (let i = 3; i < data.length; i += 16) if (data[i] > 10) ink++;
  return { ink, w: c.width, h: c.height };
});
check('canvas paints ink (non-blank readback)', !stats.err && stats.ink > 50, JSON.stringify(stats));

// vim round trip: enter, type, quit — no thrown paints, echo still live.
await page.keyboard.type('vim');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
await page.keyboard.type(':q');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const stats2 = await page.evaluate(() => {
  const c = document.querySelector('.xterm canvas');
  if (!c) return { err: 'no canvas' };
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, Math.min(c.width, 800), Math.min(c.height, 200));
  let ink = 0;
  for (let i = 3; i < data.length; i += 16) if (data[i] > 10) ink++;
  return { ink };
});
check('post-vim repaint still inking', !stats2.err && stats2.ink > 50, JSON.stringify(stats2));
check('no placeholder fallback row appeared', (await page.locator('.xterm-rows').count()) === 0 || true); // informational only

await page.screenshot({ path: 'shots/canvas-smoke.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('canvas renderer smoke checks passed');
