// Theme preset checks: for every preset, apply it LIVE via the settings
// select (proves the reconfigure path — no reload), verify body[data-theme],
// the pane background, and the xterm bg, then screenshot terminal + editor.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

// [pane bg (terminal), editor bg (CodeMirror)] — they differ on the VS Code
// presets (workbench panel bg ≠ editor bg).
const EXPECT = {
  'mymux-night': ['#0b0e14', '#0b0e14'],
  'tokyo-night': ['#1a1b26', '#1a1b26'],
  'tokyo-storm': ['#24283b', '#24283b'],
  'catppuccin-mocha': ['#1e1e2e', '#1e1e2e'],
  'catppuccin-latte': ['#eff1f5', '#eff1f5'],
  'gruvbox-dark': ['#282828', '#282828'],
  nord: ['#2e3440', '#2e3440'],
  dracula: ['#282a36', '#282a36'],
  'one-dark': ['#282c34', '#282c34'],
  'code-dark-modern': ['#181818', '#1f1f1f'],
  'code-light-modern': ['#f8f8f8', '#ffffff'],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

// A highlighted file open for the editor face: Go file via the tree (pane at
// $HOME first — the tree is rooted at the pane's cwd).
await page.mouse.click(720, 450);
await page.keyboard.type('cd ~');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.trow.tdir')].find(
    (x) => x.offsetParent !== null && x.textContent.trim().endsWith('ux-lang-test'),
  );
  if (r) r.click();
});
await page.waitForTimeout(600);
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.trow.tfile')].find(
    (x) => x.offsetParent !== null && x.textContent.trim().endsWith('main.go'),
  );
  if (r) r.click();
});
await page.waitForTimeout(1200);

const fails = [];
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

for (const [id, [paneWant, editorWant]] of Object.entries(EXPECT)) {
  // Live switch through the settings select (toggle the panel closed with the
  // same button — Esc would close the CODE panel first).
  await page.click('#btn-settings');
  await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
  await page.selectOption('.settings-select', id);
  await page.waitForTimeout(500);
  await page.click('#btn-settings');
  await page.waitForTimeout(400);

  const ds = await page.evaluate(() => document.body.dataset.theme);
  const paneBg = await page.evaluate(
    () => getComputedStyle(document.querySelector('.pane')).backgroundColor,
  );
  const editorBg = await page.evaluate(() => {
    const el = document.querySelector('.cm-editor');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  const ok = ds === id && paneBg === rgb(paneWant) && editorBg === rgb(editorWant);
  console.log(
    `${ok ? '✓' : '✗ FAIL'} ${id}: dataset=${ds} pane=${paneBg} editor=${editorBg} (want ${rgb(paneWant)}/${rgb(editorWant)})`,
  );
  if (!ok) fails.push(id);
  await page.screenshot({ path: `${SHOTS}theme-${id}.png` });
}
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(', '));
  process.exit(1);
}
console.log('all theme preset checks passed');
