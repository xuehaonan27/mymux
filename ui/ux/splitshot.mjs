// Split panes + forced host bar: chrome polish eyeball.
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const OUT = new URL('./shots/', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

// Force the host bar on via settings, then split right + down.
await page.click('#btn-settings');
await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.settings-row')].find((r) =>
    r.textContent.includes('Always show the host bar'),
  );
  row.querySelector('input').click();
});
await page.click('#btn-settings');
await page.waitForTimeout(400);

await page.click('#btn-splith');
await page.waitForTimeout(700);
await page.click('#btn-splitv');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}tour-splits.png` });

await browser.close();
console.log('splits done');
