// Screenshots + pane layout for pixel-level see-through verification
// (alphacheck.py analyzes them).
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const browser = await chromium.launch();
async function shot(name, prefs) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript((p) => localStorage.setItem('mymux.prefs', JSON.stringify(p)), prefs);
  await page.goto('http://127.0.0.1:5173/?port=8099', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.click('#btn-splith');
  await page.waitForTimeout(700);
  const layout = await page.evaluate(() =>
    [...document.querySelectorAll('.pane')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  await page.screenshot({ path: `shots/${name}.png` });
  await page.close();
  return layout;
}
const layout = await shot('alpha-see', { theme: 'mymux-night', bgImage: '/ux/wall-test.png', bgDim: 0, paneOpacity: 0.6 });
await shot('alpha-solid', { theme: 'mymux-night', bgImage: '/ux/wall-test.png', bgDim: 0, paneOpacity: 1 });
// No backdrop: the slider must be INERT (regression: xterm went transparent
// over the stock black viewport = "the slider just darkens").
await shot('alpha-noimg', { theme: 'mymux-night', bgImage: '', paneOpacity: 0.6 });
// The plain default (no image, opacity 1): the inert reference point.
await shot('alpha-default', { theme: 'mymux-night' });
writeFileSync('shots/alpha-layout.json', JSON.stringify(layout));
console.log('done', JSON.stringify(layout));
