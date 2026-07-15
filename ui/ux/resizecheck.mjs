// Divider drag-resize check: split panes, drag the dividers, assert the
// daemon-driven layout actually changes the pane rects (cols and rows).
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
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

const paneRects = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );

// Split right (⌘D is direct): one vertical divider appears.
await page.keyboard.press('Control+d');
await page.waitForTimeout(1400);
check('vertical divider exists', (await page.locator('.divider-v').count()) === 1);

const before = await paneRects();
check('2 panes side by side', before.length === 2 && before[0].w === before[1].w, JSON.stringify(before));

// Drag the divider right by ~60px → left pane grows.
const dv = page.locator('.divider-v').first();
const box = await dv.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 60, cy, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(1200);
const after = await paneRects();
const grew = after[0].w - before[0].w;
check('left pane grew after drag right', grew > 30, `Δw=${grew}px`);
const sum = (rs) => rs[0].w + rs[1].w;
check(
  'widths still tile the window (±1 cell of rounding)',
  Math.abs(sum(after) - sum(before)) <= 8,
  `sum ${sum(before)} → ${sum(after)}`,
);

// Drag back left by ~40px → left pane shrinks.
const dv2 = page.locator('.divider-v').first();
const box2 = await dv2.boundingBox();
await page.mouse.move(box2.x + 2, cy);
await page.mouse.down();
await page.mouse.move(box2.x + 2 - 40, cy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(1200);
const back = await paneRects();
check('left pane shrank after drag left', back[0].w < after[0].w, `w=${back[0].w}`);

// Split down inside the left pane (⌘K r): a horizontal divider appears there.
await page.mouse.click(back[0].x + back[0].w / 2, back[0].y + back[0].h / 2);
await page.keyboard.press('Control+k');
await page.keyboard.press('r');
await page.waitForTimeout(1400);
check('horizontal divider exists', (await page.locator('.divider-h').count()) >= 1);
const beforeH = await paneRects();
const leftCol = beforeH.filter((r) => r.x === beforeH[0].x).sort((a, b) => a.y - b.y);
check('left column has 2 stacked panes', leftCol.length === 2, JSON.stringify(beforeH));

const dh = page.locator('.divider-h').first();
const hb = await dh.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 40, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(1200);
const afterH = await paneRects();
const leftColAfter = afterH.filter((r) => r.x === leftCol[0].x).sort((a, b) => a.y - b.y);
check(
  'top pane of the column grew after drag down',
  leftColAfter.length === 2 && leftColAfter[0].h > leftCol[0].h,
  `h ${leftCol[0].h} → ${leftColAfter[0]?.h}`,
);
await page.screenshot({ path: 'shots/divider-drag.png' });

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('divider drag-resize checks passed');
