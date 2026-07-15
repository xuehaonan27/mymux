// Modal-stack checks: Esc always closes the TOP overlay only.
//   code → settings → Esc = settings, code survives; Esc = code.
//   code → host panel → Esc = host, code survives.
// Plus: window-transparency classes (stubbed Tauri) and the image file
// picker → data-URL pref roundtrip.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const WALL = fileURLToPath(new URL('./wall-test.png', import.meta.url));
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};

const TAURI_STUB = () => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === 'hosts_list') return Promise.resolve({ hosts: [], default_id: null });
      if (cmd === 'conns_list') return Promise.resolve([]);
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
};

const browser = await chromium.launch();

// ---- Esc order: code + settings (plain browser seat) ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => console.log('[console]', m.text()));
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1000);

  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.click('#btn-settings');
  await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });

  await page.keyboard.press('Escape');
  check('Esc#1 closes settings (top), code survives', await page.evaluate(
    () => !document.querySelector('.settings-panel.show') && !!document.querySelector('.code-panel.show'),
  ));
  await page.keyboard.press('Escape');
  check('Esc#2 closes code', await page.evaluate(() => !document.querySelector('.code-panel.show')));
  await page.close();
}

// ---- Esc order: code + host panel (stubbed Tauri) ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(TAURI_STUB);
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-panel.show', { timeout: 20000 });
  await page.keyboard.press('Escape'); // dismiss the boot gate
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.click('#btn-host');
  await page.waitForSelector('.host-panel.show', { timeout: 5000 });

  await page.keyboard.press('Escape');
  check('Esc closes host panel (top), code survives', await page.evaluate(
    () => !document.querySelector('.host-panel.show') && !!document.querySelector('.code-panel.show'),
  ));
  await page.keyboard.press('Escape');
  check('Esc then closes code', await page.evaluate(() => !document.querySelector('.code-panel.show')));
  await page.close();
}

// ---- window transparency classes (stubbed Tauri + pref) ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(TAURI_STUB);
  await page.addInitScript(() => {
    localStorage.setItem('mymux.prefs', JSON.stringify({ theme: 'mymux-night', windowOpacity: 0.5 }));
  });
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-panel.show', { timeout: 20000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('has-winalpha on body', await page.evaluate(() => document.body.classList.contains('has-winalpha')));
  const htmlBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  check(`html transparent (${htmlBg})`, htmlBg === 'rgba(0, 0, 0, 0)');
  const termBg = await page.evaluate(() => getComputedStyle(document.getElementById('term')).backgroundColor);
  check('#term transparent under window alpha', termBg === 'rgba(0, 0, 0, 0)');
  await page.close();
}

// ---- image file picker → data-URL pref ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.click('#btn-settings');
  await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
  await page.setInputFiles('.settings-panel input[type=file]', WALL);
  await page.waitForTimeout(800);
  const bg = await page.evaluate(() => JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}').bgImage ?? '');
  check('file picker stores a jpeg data URL', bg.startsWith('data:image/jpeg'));
  check('has-bgimage after file pick', await page.evaluate(() => document.body.classList.contains('has-bgimage')));
  await page.close();
}

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('modal-stack + transparency checks passed');
