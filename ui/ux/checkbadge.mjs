import { chromium } from 'playwright-core';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/?port=8099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
console.log('tabs:', await page.evaluate(() => document.getElementById('tabs').innerHTML.slice(0, 300)));
await browser.close();
