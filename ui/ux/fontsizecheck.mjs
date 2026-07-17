// Terminal font zoom (⌘=/⌘-/⌘0, browser path = leader chords): the persisted
// pref drives EVERY terminal live — new cell metrics, xterm resize, daemon
// relayout. Covers step/reset, the clamps, the settings stepper, help rows,
// and persistence across reloads.
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

const spanSize = () =>
  page.evaluate(() => {
    const sp = document.querySelector('.xterm-rows span');
    return sp ? parseFloat(getComputedStyle(sp).fontSize) : 0;
  });
const prefSize = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}').fontSize);
const leader = async (key) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
};

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForSelector('.xterm-rows span', { timeout: 10000 });
await page.waitForTimeout(800);

check('boots at the default 13px', (await spanSize()) === 13, `${await spanSize()}`);
await leader('=');
check('⌘= steps up to 14px live', (await spanSize()) === 14, `${await spanSize()}`);
check('pref persisted (14)', (await prefSize()) === 14, `${await prefSize()}`);
await leader('=');
await leader('-');
await leader('-');
check('step down chains back to 13px', (await spanSize()) === 13, `${await spanSize()}`);
await leader('=');
await leader('=');
await leader('0');
check('⌘0 resets to the factory 13px', (await spanSize()) === 13 && (await prefSize()) === 13, `${await spanSize()}/${await prefSize()}`);

// High clamp at 28px.
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Control+k');
  await page.keyboard.press('=');
}
await page.waitForTimeout(500);
check('clamped at 28px', (await spanSize()) === 28 && (await prefSize()) === 28, `${await spanSize()}/${await prefSize()}`);
await leader('0');

// The settings stepper applies live too.
await page.keyboard.press('Control+k');
await page.keyboard.press('s');
await page.locator('.settings-panel.show').waitFor({ timeout: 10000 });
const frow = page.locator('.settings-row', { hasText: 'Terminal font size' });
check('settings row shows 13px', ((await frow.textContent()) ?? '').includes('13px'), await frow.textContent());
await frow.locator('.settings-fontstep').nth(1).click(); // +
await page.waitForTimeout(500);
check('settings + steps up to 14px live', (await spanSize()) === 14, `${await spanSize()}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Help overlay documents the new keys.
await page.keyboard.press('Control+k');
await page.keyboard.press('/');
await page.waitForTimeout(400);
const helpText = (await page.locator('.help-panel').textContent()) ?? '';
check('help lists the font-zoom keys', helpText.includes('bigger terminal font') && helpText.includes('reset terminal font size'));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Persistence: reload keeps the zoomed size.
await leader('0');
await leader('=');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
check('reload keeps the zoomed size', (await spanSize()) === 14, `${await spanSize()}`);
await leader('0');

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('terminal font-zoom checks passed');
