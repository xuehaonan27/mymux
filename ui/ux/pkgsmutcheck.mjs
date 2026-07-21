// Packages mutation discipline (P1-10 / #33), stub-level: route-stubbed
// catalog/install/remove against a sandbox daemon. After a SUCCESSFUL
// install the panel must REFETCH the catalog (the mutation invalidates the
// cache + any pre-mutation request) and the button must settle on "Remove" —
// the stale-cache bug flipped it back to "Install" and made the op look like
// a no-op. The remove leg flips it back.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8088, 'pkgsmut');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

let installed = false;
let catalogCalls = 0;
const catalog = () => [
  {
    name: 'fake-server',
    title: 'Fake server',
    version: '1.0.0',
    kind: 'lsp-server',
    langs: ['fake'],
    desc: 'stub entry',
    installed,
    ...(installed ? { installed_version: '1.0.0' } : {}),
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.route('**/pkgs/catalog', async (route) => {
  catalogCalls++;
  await route.fulfill({ json: catalog() });
});
await page.route('**/pkgs/install', async (route) => {
  installed = true;
  await route.fulfill({ json: { ok: true } });
});
await page.route('**/pkgs/remove', async (route) => {
  installed = false;
  await route.fulfill({ json: { ok: true } });
});
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

const cardBtn = page.locator('.pkgs-card .pkgs-btn').first();
await page.click('#btn-pkgs');
await cardBtn.waitFor({ timeout: 10000 });
check('first paint fetched the catalog once', catalogCalls === 1, `calls=${catalogCalls}`);
check('card starts at Install', (await cardBtn.textContent()) === 'Install', await cardBtn.textContent());

// Install → the finally path invalidates + reloads: a SECOND catalog fetch
// must happen and the button must settle on Remove (not flip back).
await cardBtn.click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.pkgs-card .pkgs-btn')].some((b) => b.textContent === 'Remove'),
  undefined,
  { timeout: 8000 },
);
check('install triggered a catalog refetch', catalogCalls >= 2, `calls=${catalogCalls}`);
check('button settles on Remove after install', (await cardBtn.textContent()) === 'Remove', await cardBtn.textContent());
check('card shows the installed version', ((await page.locator('.pkgs-card').textContent()) ?? '').includes('1.0.0 installed'));

// Remove → back to Install, with another refetch.
const before = catalogCalls;
await cardBtn.click();
await page.waitForFunction(
  () => [...document.querySelectorAll('.pkgs-card .pkgs-btn')].some((b) => b.textContent === 'Install'),
  undefined,
  { timeout: 8000 },
);
check('remove triggered a catalog refetch', catalogCalls > before, `calls=${catalogCalls}`);
check('button settles on Install after remove', (await cardBtn.textContent()) === 'Install', await cardBtn.textContent());

await page.screenshot({ path: 'shots/pkgs-mut.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('packages mutation checks passed');
