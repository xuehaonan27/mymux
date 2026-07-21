// Code-panel tree UX checks against a sandboxed daemon (own ptyd/socket/port):
//   #1 tree expansion survives panel close/reopen (per-session memory),
//   #3 the ▸ all / ▾ all toggle (expand-all skips dependency forests),
//   #4 side-panel search in name AND content modes (daemon walk skips
//      node_modules; content hits click through to the file at the line),
//   #2 overlay sheets anchor below the bar — no more bar occlusion, with the
//      host strip off AND forced on.
// Fixture: ~/ux-code-tree (created here).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8062, 'codetree');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The daemon's root override only honors paths inside $HOME — fixture in ~.
execSync(`
  rm -rf ~/ux-code-tree
  mkdir -p ~/ux-code-tree/src/deep/deeper ~/ux-code-tree/node_modules/forest
  printf 'needle alpha hit\\n' > ~/ux-code-tree/src/alpha.txt
  printf 'nothing on line one\\nsecond needle hit\\n' > ~/ux-code-tree/src/deep/beta.txt
  printf 'needle third\\n' > ~/ux-code-tree/src/deep/deeper/gamma.txt
  printf 'nothing here\\n' > ~/ux-code-tree/needle_name.md
  printf 'needle hidden\\n' > ~/ux-code-tree/node_modules/forest/needle.txt
`);

const rowTexts = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#code-tree .trow')].map((r) => r.textContent));
const hitTexts = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#code-hits .chit')].map((r) => r.textContent));
const waitFor = async (fn, ms = 6000) => {
  for (let i = 0; i < ms / 250; i++) {
    if (await fn()) return true;
    await sleep(250);
  }
  return fn();
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

// Point the pane at the fixture and open the panel.
await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-code-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1000);

// ---- #1 expansion memory across close/reopen --------------------------------
const clickDir = async (name) => {
  await page.locator('#code-tree .trow.tdir', { hasText: name }).first().click();
  await page.waitForTimeout(700);
};
await clickDir('src');
await clickDir('deep');
check('nested expand shows beta.txt', (await rowTexts(page)).some((t) => t.includes('beta.txt')));

await page.keyboard.press('Control+e'); // close
await page.waitForTimeout(500);
await page.keyboard.press('Control+e'); // reopen — no clicks this time
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
const remembered = await waitFor(async () => (await rowTexts(page)).some((t) => t.includes('beta.txt')));
check('#1 reopen restores src/deep expansion', remembered);

// ---- #3 fold toggle ----------------------------------------------------------
const foldTitle = () => page.locator('#tree-fold').getAttribute('title');
check('#3 fold starts as collapse (tree is open)', (await foldTitle()) === 'collapse all folders');
await page.click('#tree-fold');
await page.waitForTimeout(600);
let rows = await rowTexts(page);
check('#3 collapse-all leaves only root rows', rows.some((t) => t.includes('src')) && !rows.some((t) => t.includes('beta.txt')));
await page.click('#tree-fold'); // now expand-all
const deepShown = await waitFor(async () => (await rowTexts(page)).some((t) => t.includes('gamma.txt')), 10000);
check('#3 expand-all cascades to deeper/gamma.txt', deepShown);
rows = await rowTexts(page);
check('#3 expand-all skips node_modules forest', rows.some((t) => t.includes('node_modules')) && !rows.some((t) => t.includes('forest')));

// ---- #4 search: name mode then content mode ----------------------------------
await page.fill('#code-search-input', 'needle');
const nameHits = await waitFor(async () => (await hitTexts(page)).length > 0);
check('#4 name search returns hits', nameHits);
let hits = await hitTexts(page);
check('#4 name mode finds needle_name.md', hits.some((t) => t.includes('needle_name.md')), JSON.stringify(hits));
check('#4 name mode skips forests + content-only files', !hits.some((t) => t.includes('node_modules')) && !hits.some((t) => t.includes('alpha.txt')));
check('#4 tree hidden while hits show', (await page.locator('#code-tree').evaluate((el) => getComputedStyle(el).display)) === 'none');

await page.click('#code-search-mode'); // → content
await waitFor(async () => (await hitTexts(page)).some((t) => t.includes('alpha.txt')));
hits = await hitTexts(page);
check('#4 content mode finds alpha:1 + beta:2 + gamma:1', hits.some((t) => t.includes('src/alpha.txt:1')) && hits.some((t) => t.includes('src/deep/beta.txt:2')) && hits.some((t) => t.includes('deeper/gamma.txt:1')), JSON.stringify(hits));
check('#4 content mode ignores name-only + forest hits', !hits.some((t) => t.includes('needle_name.md')) && !hits.some((t) => t.includes('node_modules')));

// Click beta:2 → editor opens at line 2 with the needle on the cursor line.
await page.locator('#code-hits .chit', { hasText: 'src/deep/beta.txt:2' }).click();
await page.waitForTimeout(1200);
check('#4 hit click opens the file', ((await page.locator('#code-path').textContent()) ?? '').includes('beta.txt'));
const activeLine = await page.locator('.cm-activeLine').textContent().catch(() => '');
check('#4 lands on the match line', (activeLine ?? '').includes('second needle hit'), activeLine ?? '');

// Esc clears the search first, Esc again closes the panel.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('#4 Esc clears search (tree back)', (await page.locator('#code-hits').evaluate((el) => getComputedStyle(el).display)) === 'none' && (await page.locator('#code-tree').evaluate((el) => getComputedStyle(el).display)) !== 'none');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('second Esc closes the panel', (await page.locator('.code-panel.show').count()) === 0);

// ---- #2 sheet tops stay below the bar ----------------------------------------
const gap = async () => {
  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  const m = await page.evaluate(() => {
    const bar = document.getElementById('bar').getBoundingClientRect().bottom;
    const top = document.querySelector('.code-panel').getBoundingClientRect().top;
    const host = getComputedStyle(document.getElementById('hostbar')).display;
    return { bar, top, host };
  });
  await page.keyboard.press('Control+e'); // close again
  return m;
};
let m = await gap();
check('#2 sheet below bar (host strip hidden)', m.top >= m.bar - 1, `top=${m.top} bar=${m.bar}`);

// Force the host strip on (the regression case: 2 strips ≈ 62px of chrome).
await page.evaluate(() => {
  const p = JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}');
  p.hostBarAlways = true;
  localStorage.setItem('mymux.prefs', JSON.stringify(p));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
m = await gap();
check('#2 host strip visible for the regression case', m.host === 'flex');
check('#2 sheet still below the taller chrome', m.top >= m.bar - 1, `top=${m.top} bar=${m.bar} (2 strips)`);
await page.evaluate(() => {
  const p = JSON.parse(localStorage.getItem('mymux.prefs') ?? '{}');
  p.hostBarAlways = false;
  localStorage.setItem('mymux.prefs', JSON.stringify(p));
});

await page.keyboard.press('Control+e').catch(() => {});
await page.screenshot({ path: 'shots/codetree.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('code tree/search checks passed');
