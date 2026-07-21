// Window-switch integrity — the regression net for the rendering bugs the
// field reports kept circling:
//   P1-21/#38  truecolor reseeds shifted RGB (avt colon form vs xterm.js)
//   #39        reseeds ate ~a screen of scrollback above the viewport
//   P1-16      switching windows DISPOSED panes: scrollback, scroll position,
//              selection and DOM identity all died per switch
//   Bug4       per-window colours cross-bleeding / stale frames
//   #11-adj    bare modifier presses yanking the view to the bottom
// Native panes are now PRESERVED (hidden, still fed) across switches; tmux
// panes are disposed and faithfully re-seeded. SANDBOXED via sandbox.mjs.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8051, 'winswitch');
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
  check('sandbox starts from exactly one window', (await page.locator('.tab').count()) === 1);

  const type = async (cmd, wait = 700) => {
    await page.keyboard.type(cmd);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(wait);
  };
  const viewText = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');

  // win 1: RED marker, a CJK marker (snapshot replays must not sprinkle
  // spaces between wide chars), and an EXACT truecolor probe (P1-21: the
  // reseed path used to shift 37,83,149 → 83,149,0).
  await page.click('.xterm');
  await type(`printf 'REDAA-MARKER-A\\n'`);
  await type(`printf '你好世界AB\\n'`, 600);
  await type(`printf '\\033[38;2;37;83;149mCOLOR-PROBE\\033[0m\\n'`);
  const probeColor = () =>
    page.evaluate(() => {
      // The typed command's echo line also contains the literal marker text —
      // the OUTPUT span is the LAST match (and the only styled one).
      let found = null;
      for (const sp of document.querySelectorAll('.xterm-rows span')) {
        if (sp.textContent.includes('COLOR-PROBE')) found = getComputedStyle(sp).color;
      }
      return found;
    });
  check('truecolor exact on live paint', (await probeColor()) === 'rgb(37, 83, 149)', (await probeColor()) ?? 'span not found');
  // Pin the pane element itself: window switches must NOT replace it.
  await page.evaluate(() => {
    window.__paneEl = document.querySelector('.xterm');
  });

  // win 2: GREEN marker.
  await page.click('#btn-newwin');
  await page.waitForTimeout(1500);
  await page.click('.xterm');
  await type(`printf 'GREENBB-MARKER-B\\n'`, 800);
  check('win2 shows GREEN', (await viewText()).includes('GREENBB-MARKER-B'));
  check('win2 has no RED bleed', !(await viewText()).includes('REDAA-MARKER-A'));

  // Back to win 1: content, DOM identity, and exact colour must all survive.
  await page.locator('.tab').first().click();
  await page.waitForTimeout(700);
  check('win1 shows RED again', (await viewText()).includes('REDAA-MARKER-A'));
  check('win1 has no GREEN bleed', !(await viewText()).includes('GREENBB-MARKER-B'));
  check('win1 CJK replays contiguous (no wide-tail spaces)', (await viewText()).includes('你好世界AB'));
  check(
    'pane DOM identity preserved across A→B→A (P1-16)',
    await page.evaluate(() => {
      const el = document.querySelector('.xterm');
      return el === window.__paneEl && el.isConnected;
    }),
  );
  check('truecolor exact after switch-back (P1-21)', (await probeColor()) === 'rgb(37, 83, 149)', (await probeColor()) ?? 'span not found');

  // And back to win 2 — no stale frame of win1.
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(700);
  check('win2 shows GREEN again', (await viewText()).includes('GREENBB-MARKER-B'));
  check('win2 still has no RED bleed', !(await viewText()).includes('REDAA-MARKER-A'));
  await page.locator('.tab').first().click();
  await page.waitForTimeout(700);
  check('win1 CJK still contiguous after re-switch', (await viewText()).includes('你好世界AB'));

  // Deep scrollback: 5,500 lines (beyond ptyd's 4,096 snapshot cap — the old
  // dispose-on-switch path lost the oldest band deterministically). Flood,
  // switch A→B→A, then scroll to the very top: the sentinel must be there.
  await page.click('.xterm');
  await type(`printf 'HIST-FIRST\\n'; seq 1 5500`, 2500);
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(600);
  await page.locator('.tab').first().click();
  await page.waitForTimeout(600);
  let topView = '';
  for (let i = 0; i < 200 && !topView.includes('HIST-FIRST'); i++) {
    await page.keyboard.press('Shift+PageUp');
    await page.waitForTimeout(30);
    const v = await viewText();
    if (v === topView && i > 4) break; // reached the top, no sentinel
    topView = v;
  }
  check('oldest sentinel survives A→B→A (P1-16/#39)', topView.includes('HIST-FIRST'));

  // Scroll-position preservation: scroll down a little (so we're mid-buffer),
  // switch away and back — the viewport must not move.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+PageDown');
    await page.waitForTimeout(30);
  }
  const midView = await viewText();
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(500);
  await page.locator('.tab').first().click();
  await page.waitForTimeout(500);
  check('scroll position preserved across switch (P1-16)', (await viewText()) === midView);

  // Scroll discipline (the macOS screenshot complaint): bare modifiers must
  // not scroll; real input must. We are mid-scrollback in win1 now.
  await page.click('.xterm');
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await page.keyboard.down('Meta');
  await page.keyboard.up('Meta');
  await page.waitForTimeout(250);
  check('modifier-only presses stay put (no jump to bottom)', (await viewText()) === midView);
  await page.keyboard.type('x');
  await page.waitForTimeout(300);
  check('real input scrolls to the bottom again', (await viewText()) !== midView);
  // Clear the stray 'x' so later commands aren't corrupted (the old check's
  // 'xprintf' bug that made its colour assertion vacuous).
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(200);

  // Hue sanity with a REAL assertion: the REDACT span's computed colour must
  // be red-dominant, not merely present in the HTML.
  await type(`printf '\\033[31mREDACT\\033[0m\\n'`, 600);
  const redOk = await page.evaluate(() => {
    const m = (c) => c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    for (const sp of document.querySelectorAll('.xterm-rows span')) {
      if (!sp.textContent.includes('REDACT')) continue;
      const rgb = m(getComputedStyle(sp).color);
      if (rgb && Number(rgb[1]) > 120 && Number(rgb[2]) < Number(rgb[1]) * 0.7 && Number(rgb[3]) < Number(rgb[1]) * 0.7) return true;
    }
    return false;
  });
  check('SGR 31 span is computed-red (no vacuous pass)', redOk);

  // Alt-screen fixture: enter smcup, draw, switch A→B→A while inside — the
  // alt page must be intact on return (Coding CLIs live here).
  await page.click('.xterm');
  await page.keyboard.type(`printf '\\033[?1049h\\033[2J\\033[HALT-SCREEN-MARK\\n'; sleep 3; printf '\\033[?1049l'`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check('alt screen entered (marker visible)', (await viewText()).includes('ALT-SCREEN-MARK'));
  await page.locator('.tab').nth(1).click();
  await page.waitForTimeout(600);
  await page.locator('.tab').first().click();
  await page.waitForTimeout(600);
  check('alt-screen content intact across switch', (await viewText()).includes('ALT-SCREEN-MARK'));
  await page.waitForTimeout(2200); // rmcup lands; primary content returns
  check('primary content back after alt exit', (await viewText()).includes('REDACT'));

  // The macOS translucent-compositor nudge must fire on an EQUALLY-SIZED swap
  // (1 pane ↔ 1 pane): simulate the app's has-winalpha class and count style
  // flips on the workspace root across two switches.
  await page.evaluate(() => document.body.classList.add('has-winalpha'));
  const flips = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const rootNode = document.querySelector('.workspace');
        let n = 0;
        const mo = new MutationObserver((ms) => {
          for (const m of ms) if (m.type === 'attributes' && m.attributeName === 'style') n++;
        });
        mo.observe(rootNode, { attributes: true });
        document.querySelectorAll('.tab')[0].click();
        setTimeout(() => document.querySelectorAll('.tab')[1].click(), 250);
        setTimeout(() => {
          mo.disconnect();
          resolve(n);
        }, 900);
      }),
  );
  check('translucent-mode equal-size swap nudges repaints (flips ≥ 4)', flips >= 4, `${flips}`);

  // DOM-renderer metric sanity: no span may carry a baked ±1-cell
  // letter-spacing (the wide-spaced-glyph bug's signature).
  await page.waitForTimeout(400);
  const badSpacing = await page.evaluate(() => {
    let bad = 0,
      total = 0;
    for (const sp of document.querySelectorAll('.xterm-rows span')) {
      total++;
      const v = parseFloat(sp.style.letterSpacing || '0');
      if (Number.isFinite(v) && Math.abs(v) >= 1) bad++;
    }
    return `${bad}/${total}`;
  });
  check('no wide-spaced glyph bake (0 spans with letter-spacing)', badSpacing.startsWith('0/'), badSpacing);

  await page.screenshot({ path: 'shots/winswitch.png' });
} finally {
  await browser.close();
  sb.kill();
}
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('window switch checks passed');
