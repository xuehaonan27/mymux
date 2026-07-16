// Blame gutter end-to-end against ~/ux-git-ops: Blame toggle in the code
// panel, CM gutter annotations, click-through to the graph panel, dirty
// buffer auto-drop + save guard.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const REPO = '/home/xuehaonan/ux-git-ops';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const git = (args) => execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' });

// Clean slate.
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-ops');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

// 1. Open a.txt from the tree, toggle Blame.
await page.locator('.trow', { hasText: 'a.txt' }).first().click();
await page.waitForTimeout(900);
check('a.txt open', (await page.locator('#code-path').textContent())?.includes('a.txt'));
await page.click('#code-blame');
await page.waitForTimeout(1000);
const markers = page.locator('.cm-blame');
check('blame markers rendered', (await markers.count()) >= 1);
const firstText = await page.locator('.cm-blame.link').first().textContent();
check('annotation looks like "author · date"', /· .*(ago|m$)/.test(firstText ?? ''), firstText);
check('toggle button is lit', (await page.locator('#code-blame.on').count()) === 1);

// 2. Click the first annotation → code closes, graph opens on that commit.
// (The hash comes from the hover card now — no native title tooltip.)
await page.locator('.cm-blame.link').first().hover();
await page.waitForTimeout(400);
const cardHead = (await page.locator('.cm-blame-card-head').textContent()) ?? '';
const hash10 = (cardHead.match(/[0-9a-f]{10}/) ?? [''])[0];
check('hover card carries the commit hash', /^[0-9a-f]{10}$/.test(hash10), cardHead);
await page.mouse.move(720, 500);
await page.waitForTimeout(500);
await page.locator('.cm-blame.link').first().click();
await page.waitForTimeout(1500);
check('code panel closed for the jump', (await page.locator('.code-panel.show').count()) === 0);
check('git graph opened', (await page.locator('.git-panel.show').count()) === 1);
const detailHash = (await page.locator('.git-detail-title .git-hash').first().textContent()) ?? '';
check('graph detail is the blamed commit', hash10.startsWith(detailHash), `${hash10} vs ${detailHash}`);

// 3. Back to code (Esc then ⌘E): the gutter persisted; typing drops it.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
check('gutter persisted across the jump', (await page.locator('.cm-blame').count()) >= 1);
await page.click('.cm-content');
await page.keyboard.press('Home');
await page.keyboard.type('x');
await page.waitForTimeout(500);
check('edit drops the gutter', (await page.locator('.cm-blame').count()) === 0);
check('button unlit after the drop', (await page.locator('#code-blame.on').count()) === 0);

// 4. Dirty buffer refuses to blame until saved; then it works.
await page.click('#code-blame');
await page.waitForTimeout(400);
check('dirty buffer gets the save hint', ((await page.locator('#code-hint').textContent()) ?? '').includes('save the file'));
check('still no markers', (await page.locator('.cm-blame').count()) === 0);
// Focus must be IN the editor for CM's Mod-s keymap (a focused button eats it).
await page.click('.cm-content');
await page.keyboard.press('Control+s');
await page.waitForTimeout(900);
await page.click('#code-blame');
await page.waitForTimeout(1000);
check('blame after save works', (await page.locator('.cm-blame').count()) >= 1);

// 5. Extras: current-line ghost follows the cursor. (Deterministic cursor
// placement: Ctrl+Home → line 1 → ArrowDown → line 2; a mid-doc click could
// land on the blame-uncovered trailing newline and flake.)
await page.click('.cm-content');
await page.keyboard.press('Control+Home');
await page.waitForTimeout(400);
check('current-line ghost shows', (await page.locator('.cm-blame-ghost').count()) === 1);
const ghostText = (await page.locator('.cm-blame-ghost').textContent()) ?? '';
check('ghost annotates author·summary·date', /· .* ago/.test(ghostText), ghostText);
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(400);
const ghostText2 = (await page.locator('.cm-blame-ghost').count() ? await page.locator('.cm-blame-ghost').textContent() : '') ?? '';
check('ghost follows the cursor (still exactly one)', (await page.locator('.cm-blame-ghost').count()) === 1);
check('ghost updated for the new line', ghostText2.length > 0 && ghostText2 !== ghostText, `${ghostText} → ${ghostText2}`);

// 6. Heatmap: markers across differently-aged groups get different colors.
const colors = await page.evaluate(() =>
  [...document.querySelectorAll('.cm-blame.link')].map((m) => m.style.color),
);
check('heat colors differ by age', new Set(colors).size >= 2, colors.join('|'));

// 7. Hover card: shows hash/summary/author meta, hides on mouse-away.
await page.locator('.cm-blame.link').first().hover();
await page.waitForTimeout(400);
check('hover card appears', (await page.locator('.cm-blame-card').count()) === 1);
const cardText = (await page.locator('.cm-blame-card').textContent()) ?? '';
check('card carries hash + author', /[0-9a-f]{10}/.test(cardText) && cardText.includes(' · '), cardText.slice(0, 120));
await page.mouse.move(720, 500);
await page.waitForTimeout(600);
check('card hides after mouse-away', (await page.locator('.cm-blame-card').count()) === 0);

await page.screenshot({ path: 'shots/git-blame.png' });
await browser.close();

// Leave the fixture pristine.
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git blame checks passed');
