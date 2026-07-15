// End-to-end test of the agent attention notifier against a LIVE daemon.
// Drives the real transition/dedup/focus-suppression rules; Notification is a
// recording stub (headless chrome shows nothing anyway — the unit under test
// is OUR logic, not the browser's notification display).
//
//   UI=http://127.0.0.1:5173/?port=8099 API=http://127.0.0.1:8099 node notify.mjs
import { chromium } from 'playwright-core';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const API = process.env.API ?? 'http://127.0.0.1:8099';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const rec = [];
  window.__notifs = rec;
  window.Notification = class {
    static get permission() {
      return 'granted';
    }
    static async requestPermission() {
      return 'granted';
    }
    constructor(title, opts) {
      this.title = title;
      this.body = opts?.body;
      this.onclick = null;
      rec.push(this);
    }
    close() {}
  };
});
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};
const notifs = () => page.evaluate(() => window.__notifs.map((n) => ({ title: n.title, body: n.body })));
const metaPane = () =>
  page.evaluate(() => (document.getElementById('meta').textContent.match(/pane (\d+)/) || [])[1]);

// Arm the bell (permission is pre-granted by the stub).
await page.click('#btn-notify');
await page.waitForTimeout(400);
check(
  'bell turns on',
  await page.evaluate(() => document.getElementById('btn-notify').classList.contains('on')),
);

// Really unfocus the page. Headless-shell reports hasFocus()=true even for
// background tabs, so: prefer the real CDP visibility emulation, fall back to
// an in-page hasFocus double (standard practice for focus-dependent code; it
// exercises OUR unfocused() rule, which is the unit under test).
let refocus;
{
  const cdp = await context.newCDPSession(page);
  let via = 'cdp visibility';
  try {
    await cdp.send('Emulation.setVisibilityState', { state: 'hidden' });
  } catch {
    via = '';
  }
  if ((await page.evaluate(() => document.visibilityState)) !== 'hidden') {
    via = 'hasFocus double';
    await page.evaluate(() => {
      window.__origHasFocus = document.hasFocus.bind(document);
      document.hasFocus = () => false;
    });
    refocus = async () => {
      await page.evaluate(() => {
        document.hasFocus = window.__origHasFocus;
      });
    };
  } else {
    refocus = async () => {
      await cdp.send('Emulation.setVisibilityState', { state: 'visible' });
    };
  }
  console.log(`   (unfocused via ${via})`);
}
const unf = await page.evaluate(() => document.visibilityState === 'hidden' || !document.hasFocus());
check('page is unfocused', unf === true);

const pane = Number(await metaPane());
check(`pane id from meta (${pane})`, Number.isInteger(pane) && pane > 0);
const report = async (state) => {
  const r = await fetch(`${API}/agent?pane=${pane}&state=${state}`);
  if (!r.ok) throw new Error(`/agent ${state}: HTTP ${r.status}`);
  await page.waitForTimeout(700);
};
// Clean slate: clear any leftover badge on our pane (earlier probe runs
// reported states that persist in the daemon).
await report('idle');
const tabs0 = await page.locator('#tabs .tab').count();

// 1. First transition into waiting fires.
await report('waiting');
let ns = await notifs();
check('waiting fires 1 notification', ns.length === 1 && ns[0].title.includes('decision'));
if (ns[0]) console.log('   →', JSON.stringify(ns[0]));

// 2. Same state again: no duplicate.
await report('waiting');
ns = await notifs();
check('same state re-report: dedup', ns.length === 1);

// 3. waiting→done is a new transition: fires.
await report('done');
ns = await notifs();
check('waiting→done fires a 2nd', ns.length === 2 && ns[1].title.includes('finished'));
if (ns[1]) console.log('   →', JSON.stringify(ns[1]));

// 4. Back to running, then waiting again: fires again.
await report('running');
await report('waiting');
ns = await notifs();
check('running→waiting fires a 3rd', ns.length === 3);

// 5. Click jumps to the notifying window: open ANOTHER window (⌘K n), then
// re-badge the FIRST window's pane and click its notification.
await page.keyboard.press('Control+k');
await page.keyboard.press('n');
await page.waitForFunction((want) => document.querySelectorAll('#tabs .tab').length === want, tabs0 + 1, {
  timeout: 10000,
});
await page.waitForTimeout(800);
const activeBefore = await page.evaluate(
  () => document.querySelector('#tabs .tab.active')?.textContent,
);
await report('running');
await report('waiting');
ns = await notifs();
check('window-1 pane badges while window 2 active', ns.length === 4);
await page.evaluate(() => window.__notifs[3].onclick());
await page.waitForTimeout(700);
const landedPane = await metaPane();
const activeAfter = await page.evaluate(
  () => document.querySelector('#tabs .tab.active')?.textContent,
);
check(
  `onclick lands on the agent pane (was ${JSON.stringify(activeBefore)}, now pane ${landedPane} on ${JSON.stringify(activeAfter)})`,
  String(pane) === String(landedPane) && activeBefore !== activeAfter,
);

// 6. Focused again: suppressed.
await refocus();
await page.waitForTimeout(400);
const focusedNow = await page.evaluate(
  () => document.visibilityState === 'visible' && document.hasFocus(),
);
check('page refocused', focusedNow === true);
await report('running');
await report('waiting');
ns = await notifs();
check('focused: suppressed (no 5th)', ns.length === 4);

await page.screenshot({ path: 'shots/notify-e2e.png' });
await report('idle'); // leave the daemon as we found it
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('all notify e2e checks passed');
