// Packages panel open-path discipline: first open fetches the catalog
// (loading shown); reopening paints the CACHED list instantly (no loading
// flash, no refetch flicker). Search stays per-query. Daemon: the sandboxed
// pair — mymux-pkg's embedded index is local, no network needed.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8084, 'pkgsstyle');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

// Toggle helpers (panel class name from pkgs.ts is .show on its own panel).
const pkgsVisible = () => page.locator('.pkgs-panel.show').count();

await page.click('#btn-pkgs');
await page.waitForTimeout(1400); // first open: loading… → catalog
const firstText = (await page.locator('.pkgs-panel').textContent()) ?? '';
check('first open shows the catalog (rust-analyzer entry)', firstText.includes('rust-analyzer'), firstText.slice(0, 120));
check('panel is visible', (await pkgsVisible()) === 1);

// Close + reopen: cached rows repaint WITHOUT a loading flash.
await page.click('#btn-pkgs');
await page.waitForTimeout(300);
await page.click('#btn-pkgs');
await page.waitForTimeout(200); // one frame: the cache paints synchronously
const secondText = (await page.locator('.pkgs-panel').textContent()) ?? '';
check('reopen paints cached rows instantly', secondText.includes('rust-analyzer'));
check('reopen shows NO loading flash', !secondText.includes('loading…'), secondText.slice(0, 120));

// Search lane stays per-query.
const box = page.locator('.pkgs-search-input');
await box.fill('yaml');
await box.press('Enter');
await page.waitForTimeout(900);
const st = (await page.locator('.pkgs-panel').textContent()) ?? '';
check('search returns the yaml server', st.includes('yaml-language-server'), st.slice(0, 160));

await page.screenshot({ path: 'shots/pkgs.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('packages panel checks passed');
