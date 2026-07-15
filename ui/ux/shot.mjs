// Headless UX driver for mymux (scratch tooling, not shipped).
//
//   node shot.mjs [scenario …]     default: boot newsh hello
//
// Env: UI    page URL            (default http://127.0.0.1:5173/?port=8099)
//      SHOTS screenshot out dir  (default ./shots next to this file)
//
// Scenarios run IN ORDER in one page; each ends with a screenshot whose name
// carries its index, so a run is a storyboard. Keys follow ui/src/keymap.ts
// (the leader table — ⌘K <letter>), pressed as Control because the app maps
// ⌘ → ctrlKey off macOS. Waits are STATE-BASED (tab counts, panel classes),
// not fixed sleeps — terminal spawns have real latency.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const SHOTS = process.env.SHOTS ?? new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const tabCount = (page) => page.locator('#tabs .tab').count();
async function waitTabs(page, n, ms = 10000) {
  await page.waitForFunction((want) => document.querySelectorAll('#tabs .tab').length === want, n, {
    timeout: ms,
  });
}
const leader = async (page, key) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.press(key);
};

let tabs = 0; // running tab count, so scenarios can wait for +1
const scenarios = {
  // Workspace as it boots (one ∞ window, created by the daemon).
  async boot(page) {
    tabs = await tabCount(page);
  },
  // Boot against a daemon whose ptyd is unavailable: the daemon must REPORT
  // the spawn failure (toast), not just show an empty workspace.
  async bootbroken(page) {
    await page.locator('.toast.show').waitFor({ timeout: 20000 });
    tabs = await tabCount(page);
  },
  // ⌘K n — new ⌁ ephemeral-shell tab.
  async newsh(page) {
    await leader(page, 'n');
    await waitTabs(page, ++tabs);
    await page.waitForTimeout(900);
  },
  // ⌘K t — new ∞ persistent window.
  async newwin(page) {
    await leader(page, 't');
    await waitTabs(page, ++tabs);
    await page.waitForTimeout(900);
  },
  // ⌘D — split the focused pane right (direct, both platforms).
  async split(page) {
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(1200);
  },
  // Run a command in the focused pane.
  async hello(page) {
    await page.mouse.click(720, 450); // make sure a terminal has focus
    await page.keyboard.type('echo hello-from-ux; uname -a');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
  },
  // ⌘E — code panel (direct, both platforms).
  async code(page) {
    await page.keyboard.press('Control+e');
    await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
  },
  // ⌘K i — process tree.
  async proc(page) {
    await leader(page, 'i');
    await page.locator('.proc-panel.show').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
  },
  // ⌘K g — packages panel.
  async pkgs(page) {
    await leader(page, 'g');
    await page.locator('.pkgs-panel.show').waitFor({ timeout: 10000 });
    await page.waitForTimeout(2000);
  },
  // ⌘K / — help overlay (click-to-dismiss; Esc is inert by design).
  async help(page) {
    await leader(page, '/');
    await page.locator('.help-panel.show').waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
  },
  // Esc — closes proc/pkgs/code panels (not help).
  async esc(page) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  },
  // Click the backdrop — dismisses click-to-dismiss overlays (help).
  async clickout(page) {
    await page.mouse.click(1100, 700);
    await page.waitForTimeout(500);
  },
};

const names = process.argv.slice(2);
const todo = names.length ? names : ['boot', 'newsh', 'hello'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

await page.goto(UI, { waitUntil: 'domcontentloaded' });
// A working boot shows a terminal; a broken ptyd shows the error toast.
await page.waitForSelector('.xterm, .toast.show', { timeout: 20000 });
await page.waitForTimeout(2000);

let i = 0;
for (const name of todo) {
  const fn = scenarios[name];
  if (!fn) {
    console.error(`unknown scenario: ${name}`);
    process.exitCode = 1;
    continue;
  }
  await fn(page);
  const file = `${SHOTS}${String(i).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  console.log(file);
  i += 1;
}
await browser.close();
