// Settings surface check: panel controls write the store, consumers react
// (bell lights, default root auto-jump), and prefs survive a reload.
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
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

// 1. Open via the ⚙ button: two checkboxes + radio pair.
await page.click('#btn-settings');
await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
const boxes = await page.locator('.settings-panel input[type=checkbox]').count();
const radios = await page.locator('.settings-panel input[type=radio]').count();
check('panel: 2 checkboxes + 2 radios', boxes === 2 && radios === 2, `cb=${boxes} r=${radios}`);

// 2. Tick 'notify' → the bell lights up (onPrefsChange re-renders it).
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.settings-row')].find((r) => r.textContent.includes('Notify when an agent'));
  row.querySelector('input').click();
});
await page.waitForTimeout(500);
check('bell lights when notify pref set', await page.evaluate(() => document.getElementById('btn-notify').classList.contains('on')));

// 3. Pick 'repo root' → pref persists in localStorage.
await page.evaluate(() => {
  const rbs = [...document.querySelectorAll('.settings-panel input[type=radio]')];
  rbs.find((r) => r.parentElement?.textContent?.includes('repo root'))?.click();
});
await page.waitForTimeout(400);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}'));
check('localStorage has codeRoot=repo', stored.codeRoot === 'repo', JSON.stringify(stored));

// 4. Default root auto-jump: pane in a repo SUBDIR, code panel opens at the
//    repo root (once per pane).
await page.keyboard.press('Escape'); // close settings
await page.waitForTimeout(400);
await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-git-test/sub');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1500);
const rootPath = await page.evaluate(() => document.getElementById('code-root-path').textContent);
check('codeRoot=repo auto-jumps to the toplevel', rootPath?.endsWith('/ux-git-test'), rootPath ?? '');

// 5. Reload: prefs persist (bell still on, radio still repo).
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
check('bell persists across reload', await page.evaluate(() => document.getElementById('btn-notify').classList.contains('on')));
await page.click('#btn-settings');
await page.locator('.settings-panel.show').waitFor({ timeout: 5000 });
const repoChecked = await page.evaluate(() => {
  const rbs = [...document.querySelectorAll('.settings-panel input[type=radio]')];
  return rbs.find((r) => r.parentElement?.textContent?.includes('repo root'))?.checked;
});
check('repo radio persists across reload', repoChecked === true);

// 6. ⌘K s toggles too; Esc closes. Untick notify to leave a clean state.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Control+k');
await page.keyboard.press('s');
await page.waitForTimeout(500);
check('⌘K s opens settings', (await page.locator('.settings-panel.show').count()) === 1);
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.settings-row')].find((r) => r.textContent.includes('Notify when an agent'));
  row.querySelector('input').click();
});
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc closes settings', (await page.locator('.settings-panel.show').count()) === 0);
await page.screenshot({ path: 'shots/settings.png' });

await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('settings checks passed');
