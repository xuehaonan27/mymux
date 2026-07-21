// Process panel poll discipline (P1-11 / C-21), stub-level via route delays
// against one sandbox daemon pair:
//  1. a slow in-flight poll discarded by close→reopen NEVER renders its rows
//     (the mechanism that put host A's rows on host B — same gen guard);
//  2. a row's kill POSTs to the SAME api base its rows were fetched from
//     (the api is captured at render, never re-resolved at click time);
//  3. the fixed 1.5 s interval never stacks in-flight requests on a slow
//     daemon (in-flight dedup);
//  4. the 1.5 s refresh preserves the body's scroll position.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8086, 'proc');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const API = `http://127.0.0.1:${sb.port}`;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 200-row fake tree so the body can scroll at all. The comm marks which
// "host" (route phase) produced it; the pid is deliberately implausible.
const procs = (comm) =>
  Array.from({ length: 200 }, (_, i) => ({
    pid: 424242,
    ppid: 1,
    depth: 0,
    comm: `${comm}${i}`,
    cmd: `${comm}${i}`,
    state: 'S',
    rss_kb: 1024,
    cpu_jiffies: 100 + i,
  }));
const tree = (comm) => ({
  clk_tck: 100,
  windows: [{ id: 1, name: 'main', panes: [{ pane: 1, pid: 424242, procs: procs(comm) }] }],
});

let treeCalls = 0;
let phase = 'slow-first'; // slow-first → fast → dedup
let concurrent = 0;
let maxConcurrent = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.route('**/proc/tree', async (route) => {
  treeCalls++;
  concurrent++;
  maxConcurrent = Math.max(maxConcurrent, concurrent);
  try {
    if (phase === 'slow-first') {
      await sleep(1500); // the stale "host A" response, outlived by close+reopen
      await route.fulfill({ json: tree('STALE-A-') });
    } else if (phase === 'dedup') {
      await sleep(1600); // slower than the 1.5 s tick — ticks must skip, not stack
      await route.fulfill({ json: tree('DEDUP-') });
    } else {
      await route.fulfill({ json: tree('LIVE-B-') });
    }
  } finally {
    concurrent--;
  }
});
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

// 1. Open → the first (slow) poll is in flight; close + reopen before it lands.
await page.click('#btn-proc');
await page.locator('.proc-panel.show').waitFor({ timeout: 5000 });
await sleep(400); // slow poll still pending
await page.click('#btn-proc'); // close (gen bump)
await sleep(150);
phase = 'fast';
await page.click('#btn-proc'); // reopen (gen bump) → fast "host B" poll
await page.locator('.proc-panel.show').waitFor({ timeout: 5000 });
await sleep(2600); // the stale response lands mid-window and must be dropped
const bodyText = (await page.locator('#proc-body').textContent()) ?? '';
check('live rows rendered after reopen', bodyText.includes('LIVE-B-'), bodyText.slice(0, 80));
check('stale in-flight response never rendered', !bodyText.includes('STALE-A-'), bodyText.slice(0, 80));

// 2. Kill capture: the click must target the api base the rows came from.
// (DOM click, not a positional one: the body rebuilds every 1.5 s, so a
// coordinate-based click can land on a just-replaced row.)
const killReq = page.waitForRequest('**/proc/kill', { timeout: 5000 });
await page.evaluate(() => document.querySelector('#proc-body .pkill').click());
const kill = await killReq;
const killBody = JSON.parse(kill.postData() ?? '{}');
check('kill POSTs to the rows’ own api base', kill.url().startsWith(`${API}/proc/kill`), kill.url());
check('kill carries the clicked row’s pid', killBody.pid === 424242 && killBody.signal === 'TERM', JSON.stringify(killBody));

// 3. Scroll preservation across fast refreshes.
await sleep(2000); // a few fast polls so the list is fully settled
await page.evaluate(() => {
  document.querySelector('#proc-body').scrollTop = 600;
});
await sleep(3400); // two+ poll cycles
const st = await page.evaluate(() => document.querySelector('#proc-body').scrollTop);
check('scroll position preserved across refreshes', st >= 550, String(st));

// 4. In-flight dedup against a daemon slower than the poll interval.
phase = 'dedup';
maxConcurrent = 0;
await sleep(5000);
check('never two polls in flight at once', maxConcurrent === 1, `max=${maxConcurrent}`);

await page.screenshot({ path: 'shots/proc.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('process panel captured-host/dedup checks passed');
