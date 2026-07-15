// Language-coverage check: open files of several types in the code panel and
// verify CodeMirror emits STYLED spans (highlighting) — plain text would have
// none. Screenshot each for the visual record.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const FILES = ['main.go', 'config.yaml', 'script.sh', 'Dockerfile', 'main.cpp', 'plain.xyz'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

// Code panel, then open each file via the file TREE (⌘P quick-open is
// git-repo-scoped and the test home dir is no repo).
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1000);

async function openViaTree(rel) {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const name = segs[i];
    const dir = i < segs.length - 1;
    const clicked = await page.evaluate(
      ({ name, dir }) => {
        const rows = [...document.querySelectorAll(dir ? '.trow.tdir' : '.trow.tfile')];
        const r = rows.find(
          (x) => x.offsetParent !== null && x.textContent.trim().endsWith(name),
        );
        if (!r) return 'missing';
        // Directories toggle: click only to EXPAND (▸), never to collapse (▾).
        if (dir && r.textContent.trim().startsWith('▾')) return 'already-open';
        r.click();
        return 'clicked';
      },
      { name, dir },
    );
    if (clicked === 'missing') throw new Error(`tree row not found: ${name} (in ${rel})`);
    await page.waitForTimeout(i === segs.length - 1 ? 1400 : 600);
  }
}

const fails = [];
for (const f of FILES) {
  await openViaTree(`ux-lang-test/${f}`);
  const styled = await page.evaluate(
    () => document.querySelectorAll('.cm-content .cm-line span[class]').length,
  );
  const lines = await page.evaluate(
    () => document.querySelectorAll('.cm-content .cm-line').length,
  );
  const expectHighlight = f !== 'plain.xyz';
  const ok = expectHighlight ? styled > 0 && lines > 0 : styled === 0 && lines > 0;
  console.log(
    `${ok ? '✓' : '✗ FAIL'} ${f}: ${lines} lines, ${styled} styled spans (want ${expectHighlight ? '>0' : '0'})`,
  );
  if (!ok) fails.push(f);
  await page.screenshot({ path: `${SHOTS}lang-${f.replace(/\W+/g, '_')}.png` });
}
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(', '));
  process.exit(1);
}
console.log('all language checks passed');
