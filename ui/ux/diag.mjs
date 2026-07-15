import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => console.error(`[console:${m.type()}]`, m.text().slice(0, 300)));
page.on('websocket', (ws) => {
  console.log('[ws]', ws.url());
  ws.on('close', () => console.log('[ws closed]', ws.url()));
  ws.on('socketerror', (e) => console.log('[ws error]', e));
});
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const html = await page.evaluate(() => document.body.innerHTML.slice(0, 1200));
console.log('--- body ---');
console.log(html);
await page.screenshot({ path: 'shots/diag.png' });
await browser.close();
