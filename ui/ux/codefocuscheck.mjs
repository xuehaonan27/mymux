// Focus discipline on editor close (field report: after ⌘E-close, focus can
// stay captured by the editor — the terminal then gets NOTHING and the typed
// text CORRUPTS the hidden buffer). Three close paths must all land focus on
// the terminal: ⌘E, Esc, and the toolbar button. Plus the dirty buffer must
// be byte-identical after typing "into the void".
// Fixture: /tmp/mymux-ux-codefocus (created here, cleaned up on exit).
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DIR = '/tmp/mymux-ux-codefocus';
execSync(`rm -rf ${DIR} && mkdir -p ${DIR}`);
fs.writeFileSync(`${DIR}/f.txt`, 'line-one\n');

const sb = await startSandbox(8046, 'codefocus');
process.on('exit', () => {
  sb.kill();
  execSync(`rm -rf ${DIR}`);
});
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(sb.ui, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.click('.xterm');
  await page.keyboard.type(`cd ${DIR}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('codefocus'), { timeout: 15000 });

  const focusInfo = () =>
    page.evaluate(() => {
      const ae = document.activeElement;
      const panel = document.querySelector('.code-panel');
      return {
        tag: ae?.tagName ?? '',
        inPanel: !!(panel && ae && panel.contains(ae)),
        isBody: ae === document.body,
        isXterm: !!(ae && ae.classList?.contains('xterm-helper-textarea')),
      };
    });
  const termText = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  const docText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
    );

  // Open the editor and the fixture file; make a REAL edit (dirty on purpose).
  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.locator('#code-tree .trow.tfile', { hasText: 'f.txt' }).first().click();
  await page.waitForTimeout(700);
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('X-EDIT');
  await page.waitForTimeout(300);
  check('setup: editor focused inside panel', (await focusInfo()).inPanel);

  // ---- path 1: ⌘E close -----------------------------------------------------
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(400);
  check('⌘E closes the panel', (await page.locator('.code-panel.show').count()) === 0);
  const f1 = await focusInfo();
  check('⌘E: focus NOT captured by hidden panel', !f1.inPanel, JSON.stringify(f1));
  check('⌘E: focus lands on the terminal', f1.isXterm, JSON.stringify(f1));
  await page.keyboard.type('POLLUTE-ONE');
  await page.waitForTimeout(400);
  check('⌘E: terminal receives subsequent typing', (await termText()).includes('POLLUTE-ONE'));
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(200);

  // Reopen: the stray text must NOT have entered the buffer; our edit stays.
  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const doc1 = await docText();
  check('⌘E: hidden buffer NOT polluted', !doc1.includes('POLLUTE-ONE') && doc1.includes('X-EDIT'));

  // ---- path 2: Esc close ----------------------------------------------------
  await page.click('.cm-content');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc closes the panel', (await page.locator('.code-panel.show').count()) === 0);
  const f2 = await focusInfo();
  check('Esc: focus lands on the terminal', f2.isXterm && !f2.inPanel, JSON.stringify(f2));
  await page.keyboard.type('POLLUTE-TWO');
  await page.waitForTimeout(400);
  check('Esc: terminal receives subsequent typing', (await termText()).includes('POLLUTE-TWO'));
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(200);

  // ---- path 3: toolbar button close -----------------------------------------
  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.click('.cm-content');
  await page.waitForTimeout(200);
  await page.click('#btn-code');
  await page.waitForTimeout(400);
  check('button closes the panel', (await page.locator('.code-panel.show').count()) === 0);
  const f3 = await focusInfo();
  check('button: focus lands on the terminal', f3.isXterm && !f3.inPanel, JSON.stringify(f3));

  // Final reopen: only our X-EDIT may be in the doc — nothing else leaked in.
  await page.keyboard.press('Control+e');
  await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const doc2 = await docText();
  check('final: buffer has the edit and zero stray text', doc2.includes('X-EDIT') && !doc2.includes('POLLUTE'), doc2.slice(0, 60));
} finally {
  await browser.close();
  sb.kill();
}
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('editor-close focus checks passed');
