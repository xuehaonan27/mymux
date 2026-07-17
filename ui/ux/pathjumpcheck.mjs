// Path-jump checks: ⌘P raw-path rows (relative file + absolute dir), a
// modifier-held terminal link click (./sub/inner.txt:2 → editor at line 2),
// and an editor ⌘+click on a path token inside a file. Fixture: ~/ux-git-tree
// (reused by gittreecheck; refs.txt is added here).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

execSync(`printf 'see sub/inner.txt:2 for details\\nplain text\\n' > ~/ux-git-tree/refs.txt`);

/** Screen rect of the first element matching (selector, text needle).
 * Measures a DOM Range over the matched text instead of dividing the element
 * box by length — block-level containers (.cm-line is full-width, unlike
 * xterm's snug spans) make char-index math land far right of the real text. */
const rectOf = async (page, selector, needle) =>
  page.evaluate(
    ([sel, n]) => {
      for (const el of document.querySelectorAll(sel)) {
        const t = el.textContent ?? '';
        const i = t.indexOf(n);
        if (i < 0) continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let node;
        while ((node = walker.nextNode())) {
          if (acc + node.data.length <= i) {
            acc += node.data.length;
            continue;
          }
          const r = document.createRange();
          r.setStart(node, i - acc);
          r.setEnd(node, Math.min(i - acc + n.length, node.data.length));
          const q = r.getBoundingClientRect();
          return { x: q.left + q.width / 2, y: q.top + q.height / 2 };
        }
      }
      return null;
    },
    [selector, needle],
  );

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-git-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(900);

// ---- ⌘P raw path: relative file ----------------------------------------------
await page.keyboard.press('Control+p');
await page.waitForSelector('.qopen', { state: 'visible', timeout: 5000 });
await page.keyboard.type('sub/inner.txt');
await page.waitForTimeout(400);
const prow = page.locator('.qopen-path');
check('path-ish input shows the ↪ row', (await prow.count()) === 1 && ((await prow.textContent()) ?? '').includes('/ux-git-tree/sub/inner.txt'));
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
check('⌘P relative path opens the file', ((await page.locator('#code-path').textContent()) ?? '').includes('sub/inner.txt'));

// ---- ⌘P raw path: absolute directory -----------------------------------------
await page.keyboard.press('Control+p');
await page.waitForSelector('.qopen', { state: 'visible', timeout: 5000 });
await page.keyboard.type('/home/xuehaonan/ux-git-tree/sub');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
const rootPath = await page.locator('#code-root-path').textContent();
check('⌘P absolute dir switches the root', (rootPath ?? '').endsWith('/ux-git-tree/sub'), rootPath ?? '');

// back to the repo root for the following jumps
await page.keyboard.press('Control+p');
await page.waitForSelector('.qopen', { state: 'visible', timeout: 5000 });
await page.keyboard.type('/home/xuehaonan/ux-git-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(1000);

// ---- terminal ⌘+click link ----------------------------------------------------
await page.keyboard.press('Control+e'); // close the panel — the click must reopen it
await page.waitForTimeout(500);
await page.click('.xterm');
await page.keyboard.type('echo LOOK ./sub/inner.txt:2 HERE');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const ter = await rectOf(page, '.xterm-rows div span', 'inner.txt:2');
check('terminal token located', ter != null);
await page.keyboard.down('Control');
if (ter) {
  await page.mouse.move(ter.x, ter.y);
  await page.waitForTimeout(500); // hover: modifier-gated provideLinks runs
  await page.mouse.click(ter.x, ter.y);
}
await page.keyboard.up('Control');
await page.waitForTimeout(1500);
check('⌘+click reopens the panel at inner.txt', ((await page.locator('#code-path').textContent()) ?? '').includes('inner.txt'));
const activeLine = await page.locator('.cm-activeLine').textContent().catch(() => '');
check('lands on the :2 line', (activeLine ?? '').includes('inner2'), activeLine ?? '');

// ---- editor ⌘+click on a path token -------------------------------------------
await page.keyboard.press('Control+p');
await page.waitForSelector('.qopen', { state: 'visible', timeout: 5000 });
await page.keyboard.type('refs');
await page.waitForTimeout(400);
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
check('refs.txt open', ((await page.locator('#code-path').textContent()) ?? '').includes('refs.txt'));
const ed = await rectOf(page, '.cm-content .cm-line', 'inner.txt');
check('editor token located', ed != null);
await page.keyboard.down('Control');
if (ed) {
  await page.mouse.move(ed.x, ed.y);
  await page.waitForTimeout(300);
  const underlined = await page.evaluate(() => document.querySelectorAll('.cm-jumplink').length);
  check('⌘ hover underlines the token', underlined === 1, `${underlined}`);
  await page.mouse.click(ed.x, ed.y);
}
await page.keyboard.up('Control');
await page.waitForTimeout(1500);
check('editor ⌘+click jumps to inner.txt', ((await page.locator('#code-path').textContent()) ?? '').includes('inner.txt'));

await page.screenshot({ path: 'shots/pathjump.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('path-jump checks passed');
