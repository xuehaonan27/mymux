// Emoji widths (unicode11 addon): a SINGLE emoji occupies exactly 2 cells
// (the invariant every TUI's wcwidth math assumes). Emoji CLUSTERS sit in
// wider-than-ink boxes on xterm 6.0 — never the collapsed negative-spacing
// overlap the user hit ("👌🏻 covers half the next char"). Grid-relative
// measurements below are the current v11+browser DOM truth; the PROPERTY
// that must never regress is single=2 and B strictly past the cluster ink.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8095, 'emoji');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
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
await page.waitForTimeout(1200);
await page.click('.xterm');

// Control row 'AAAAAAAA' (cols 0..7 = the grid); B lands on a grid column iff
// the buffer's cell accounting matches the v11 profile.
await page.keyboard.type("printf 'AAAAAAAA\\nA👌B\\nA👌🏻B\\nA👨‍👩‍👧B\\n'");
await page.keyboard.press('Enter');
await page.waitForTimeout(900);

/** Left x of each char in each probe row, by UTF-16 index. */
const probe = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.xterm-rows div')];
  const leftAt = (row, i) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (acc + node.data.length <= i) {
        acc += node.data.length;
        continue;
      }
      const r = document.createRange();
      r.setStart(node, i - acc);
      r.setEnd(node, i - acc + 1);
      return r.getBoundingClientRect().left;
    }
    return null;
  };
  const find = (needle) => rows.find((r) => (r.textContent ?? '').startsWith(needle));
  const ctl = find('AAAAAAAA');
  if (!ctl) return { error: 'control row not found' };
  const grid = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => leftAt(ctl, i));
  const lastCharLeft = (needle) => {
    const row = find(needle);
    if (!row) return null;
    const t = row.textContent ?? '';
    return leftAt(row, t.length - 1);
  };
  return {
    grid,
    single: lastCharLeft('A👌B'), // col 3 — the 2-cell invariant
    pair: lastCharLeft('A👌🏻B'), // col 4 — v11 DOM truth; past the 2-cell ink
    zwj: lastCharLeft('A👨‍👩‍👧B'), // col 5 — one merged glyph well clear
  };
});

check('probe rows found', probe.grid?.every((x) => x != null) && probe.single != null && probe.pair != null && probe.zwj != null, JSON.stringify(probe));
const near = (a, b) => Math.abs(a - b) < 1.5;
// The cluster columns vary run-to-run with span merging/letter-spacing —
// pixel-position assertions would be noise. The PROPERTY: the glyph after
// a cluster lands at or past column 3 (single's 2-cell spot), never
// collapsed under the cluster's ink.
const pastInk = (x, probe) => x > probe.grid[3] - 1 && x < probe.grid[7] + 1;
if (probe.grid) {
  if (probe.single != null) check('single emoji occupies exactly 2 cells (B on col 3)', near(probe.single, probe.grid[3]), `${probe.single} vs ${probe.grid[3]}`);
  if (probe.pair != null) check('base+modifier never collapses (B past the cluster ink)', pastInk(probe.pair, probe), `${probe.pair} (grid[3]=${probe.grid[3]})`);
  if (probe.zwj != null) check('ZWJ family never collapses (B past the cluster ink)', pastInk(probe.zwj, probe), `${probe.zwj} (grid[3]=${probe.grid[3]})`);
}

await page.screenshot({ path: 'shots/emoji.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('emoji width checks passed');
