// Modal-stack checks: Esc always closes the TOP overlay only.
//   code → settings → Esc = settings, code survives; Esc = code.
//   code → host panel → Esc = host, code survives.
// Plus: window-transparency classes (stubbed Tauri) and the image file
// picker → data-URL pref roundtrip.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8072, 'modal');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
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
  // Put DOM focus INSIDE the panel (the dangerous case): a real editor's
  // contenteditable if one is mounted, else any focusable in the panel.
  await page.evaluate(() => {
    const el = document.querySelector('.code-panel .cm-content, .code-panel input, .code-panel [tabindex]');
    if (el && 'focus' in el) el.focus();
  });
  await page.keyboard.press('Escape');
  check('Esc#2 closes code', await page.evaluate(() => !document.querySelector('.code-panel.show')));
  // Closing MUST release focus out of the panel. `.code-panel` hides via
  // display:none, and WebKit keeps a display:none subtree's element as
  // document.activeElement — a still-focused contenteditable then swallows
  // keystrokes and the typed text corrupts the file buffer (blur-on-close in
  // code.ts toggle()). Focus must not remain trapped in the hidden panel.
  check('closing code releases focus from the panel', await page.evaluate(
    () => !document.querySelector('.code-panel')?.contains(document.activeElement),
  ));
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
  // #9: the reconnect banner is pointer-events:none (clicks fall through to
  // panes) — its "Hosts" escape button must opt back in to receive clicks.
  check('ws-banner-btn opts back into pointer events', await page.evaluate(() => {
    const b = document.createElement('div');
    b.className = 'ws-banner';
    const btn = document.createElement('button');
    btn.className = 'ws-banner-btn';
    b.appendChild(btn);
    document.body.appendChild(b);
    const ok =
      getComputedStyle(b).pointerEvents === 'none' &&
      getComputedStyle(btn).pointerEvents === 'auto';
    b.remove();
    return ok;
  }));
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
  // Remove button clears it again (and re-enables solid mode).
  await page.click('.settings-panel .pkgs-btn + .pkgs-btn');
  await page.waitForTimeout(300);
  const bgAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}').bgImage ?? 'x');
  check('Remove clears the image pref', bgAfter === '');
  check('has-bgimage removed', await page.evaluate(() => !document.body.classList.contains('has-bgimage')));
  // Sliders span the full 0..100% range.
  const mins = await page.evaluate(() =>
    [...document.querySelectorAll('.settings-panel input[type=range]')].map((s) => s.min),
  );
  check('sliders start at 0', mins.every((m) => m === '0'));
  // #12: a quota failure on write must roll back, not poison later writes.
  const quota = await page.evaluate(async () => {
    const m = await import('/src/prefs.ts');
    const before = m.getPrefs().fontSize;
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    m.setPrefs({ fontSize: 22 });
    localStorage.setItem = orig;
    const kept = m.getPrefs().fontSize === before;
    let notified = 0;
    m.onPrefsChange((p) => {
      notified = p.fontSize;
    });
    m.setPrefs({ fontSize: 21 });
    const ok = kept && notified === 21 && m.getPrefs().fontSize === 21;
    m.setPrefs({ fontSize: before }); // restore
    return ok;
  });
  check('quota write rolls back, later writes still apply + notify', quota);
  await page.close();
}

// ---- pairwise full-screen panel exclusion (P1-17): code/proc/pkgs/git ----
// Opening any one of the z-band panels must close whichever is open; the
// modal stack must never hold two of them (proc z-21 covered git z-20).
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(UI, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1000);
  const panels = [
    ['code', '#btn-code', '.code-panel.show'],
    ['proc', '#btn-proc', '.proc-panel.show'],
    ['pkgs', '#btn-pkgs', '.pkgs-panel.show'],
    ['git', '#btn-git', '.git-panel.show'],
  ];
  const shown = () =>
    page.evaluate(() =>
      ['.code-panel.show', '.proc-panel.show', '.pkgs-panel.show', '.git-panel.show'].filter(
        (s) => document.querySelector(s),
      ).length,
    );
  for (const [aName, aBtn, aSel] of panels) {
    for (const [bName, bBtn, bSel] of panels) {
      if (aName === bName) continue;
      await page.click(aBtn);
      await page.locator(aSel).waitFor({ timeout: 10000 });
      await page.click(bBtn);
      await page.locator(bSel).waitFor({ timeout: 10000 });
      const aGone = (await page.locator(aSel).count()) === 0;
      const oneShown = (await shown()) === 1;
      check(`${aName}→${bName}: ${aName} closes, exactly one panel shown`, aGone && oneShown);
      await page.click(bBtn); // close B for the next pair
      await page.waitForTimeout(150);
    }
  }
  await page.close();
}

await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('modal-stack + transparency checks passed');
