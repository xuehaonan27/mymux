// Verify: backdrop image + pane opacity, settings controls, host panel
// redesign + its three dismiss paths (Esc / backdrop click / ✕).
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const OUT = new URL('./shots/', import.meta.url).pathname;
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();

// ---- 1. backdrop image + pane opacity (browser seat) ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(() => {
    localStorage.setItem(
      'mymux.prefs',
      JSON.stringify({
        theme: 'mymux-night',
        bgImage: '/ux/wall-test.png',
        bgDim: 0.35,
        paneOpacity: 0.8,
      }),
    );
  });
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1200);
  check('has-bgimage class on body', await page.evaluate(() => document.body.classList.contains('has-bgimage')));
  const termBg = await page.evaluate(() => getComputedStyle(document.getElementById('term')).backgroundColor);
  check('#term transparent under backdrop', termBg === 'rgba(0, 0, 0, 0)');
  // split once: gaps between panes should show the image too
  await page.click('#btn-splith');
  await page.waitForTimeout(700);
  check('multi class with 2 panes', await page.evaluate(() => document.querySelector('.workspace')?.classList.contains('multi')));
  await page.screenshot({ path: `${OUT}bg-full.png` });

  // settings controls visible
  await page.click('#btn-settings');
  await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  const sliders = await page.locator('.settings-panel input[type=range]').count();
  const bgInput = await page.locator('.settings-bginput').count();
  check(`settings: 3 sliders + image input (s=${sliders} i=${bgInput})`, sliders === 3 && bgInput === 1);
  await page.screenshot({ path: `${OUT}bg-settings.png` });
  await page.keyboard.press('Escape');
  await page.close();
}

// ---- 2. host panel redesign + dismiss (stubbed Tauri) ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd) => {
        if (cmd === 'hosts_list')
          return Promise.resolve({
            hosts: [
              { id: 'h1', label: 'devmachine', hostname: 'dev.example.com', port: 22, user: 'dev', identity_path: '~/.ssh/id' },
              { id: 'h2', label: 'm0', hostname: 'm0.example.com', port: 22, user: 'dev', identity_path: '~/.ssh/id' },
            ],
            default_id: null,
          });
        if (cmd === 'conns_list') return Promise.resolve([]);
        if (cmd === 'plugin:event|listen') return Promise.resolve(0);
        return Promise.reject(new Error(`stub: ${cmd}`));
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
    };
  });
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.host-panel.show', { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}host-list.png` });

  // ✕ dismisses; reopen via the bar's host button.
  await page.click('.host-x');
  check('✕ closes the panel', await page.locator('.host-panel.show').count().then((n) => n === 0));
  await page.click('#btn-host');
  await page.waitForSelector('.host-panel.show', { timeout: 5000 });

  // backdrop click dismisses.
  await page.mouse.click(60, 450); // far from the centered .host-inner
  check('backdrop click closes', await page.locator('.host-panel.show').count().then((n) => n === 0));
  await page.click('#btn-host');
  await page.waitForSelector('.host-panel.show', { timeout: 5000 });

  // connect form visual + Esc dismiss.
  await page.locator('.host-card-main').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}host-connect.png` });
  await page.keyboard.press('Escape');
  check('Esc closes the panel', await page.locator('.host-panel.show').count().then((n) => n === 0));

  await page.close();
}

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('bg + host-panel checks passed');
