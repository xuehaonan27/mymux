// Visual tour of the reworked chrome: bar + overlays + two themes.
// Screenshots only, no assertions — for eyeballing the glass UI.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const OUT = new URL('./shots/', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

// 1. pkgs panel (catalog view).
await page.click('#btn-pkgs');
await page.locator('.pkgs-panel.show').waitFor({ timeout: 5000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}tour-pkgs.png` });

// 2. pkgs search (curated-only results).
await page.fill('.pkgs-search-input', 'lang');
await page.press('.pkgs-search-input', 'Enter');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}tour-pkgs-search.png` });
await page.click('#btn-pkgs'); // close
await page.waitForTimeout(300);

// 3. settings panel.
await page.click('#btn-settings');
await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}tour-settings.png` });
await page.click('#btn-settings'); // close
await page.waitForTimeout(300);

// 4. code panel.
await page.click('#btn-code');
await page.locator('.code-panel.show').waitFor({ timeout: 8000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}tour-code.png` });
await page.click('#btn-code'); // close
await page.waitForTimeout(300);

// 5. leader hint (Control+K in headless).
await page.keyboard.press('Control+k');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}tour-leader.png` });
await page.keyboard.press('Escape');

// 6. theme swap: code-light-modern then tokyo-night (via the settings select).
for (const theme of ['code-light-modern', 'tokyo-night']) {
  await page.click('#btn-settings');
  await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
  await page.selectOption('.settings-select', theme);
  await page.waitForTimeout(500);
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}tour-theme-${theme}.png` });
}
// back to default
await page.click('#btn-settings');
await page.selectOption('.settings-select', 'mymux-night');
await page.waitForTimeout(300);

await browser.close();
console.log('tour done');
