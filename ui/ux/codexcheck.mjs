// Codex notify → badge e2e: run scripts/mymux-codex-notify.sh with a real
// Codex-shaped JSON payload and assert the pane's tab gets the done dot.
// Covers the install-codex-notify.sh snippet + handler chain end to end.
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const sh = promisify(execFile);

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const HANDLER = new URL('../../scripts/mymux-codex-notify.sh', import.meta.url).pathname;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);

const pane = await page.evaluate(
  () => (document.getElementById('meta').textContent.match(/pane (\d+)/) || [])[1],
);
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
  if (!cond) fails.push(name);
};
check(`pane id from meta (${pane})`, Number.isInteger(Number(pane)) && Number(pane) > 0);

// The handler resolves the pane from TMUX_PANE first — replicate a NATIVE
// pane's env (MYMUX_PANE set, TMUX_PANE absent), since this harness runs
// OUTSIDE the pane (a real hook inherits the pane's own env).
const notify = (json) =>
  sh(HANDLER, [json], {
    env: { ...process.env, TMUX_PANE: '', MYMUX_PANE: String(pane), MYMUX_AGENT_PORT: '8099' },
  });

// Real Codex turn-complete payload → done badge on the active tab.
await notify(
  JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': 't-1',
    'turn-id': 'turn-1',
    'input-messages': ['fix the tests'],
    'output-messages': ['all green'],
  }),
);
await page.waitForFunction(
  () => document.querySelector('#tabs .tab.active .adot.agent-done') != null,
  null,
  { timeout: 8000 },
).then(
  () => check('turn-complete → done badge on the tab', true),
  async () => {
    console.log(
      '   tabs after notify:',
      await page.evaluate(() => document.getElementById('tabs').innerHTML),
    );
    check('turn-complete → done badge on the tab', false);
  },
);

// Unknown event type → nothing changes (badge clears via a fresh turn… we
// only assert it does NOT add a waiting badge).
await notify(JSON.stringify({ type: 'something-else' }));
await page.waitForTimeout(800);
const waiting = await page.evaluate(
  () => document.querySelector('#tabs .tab.active .adot.agent-waiting') != null,
);
check('unknown event → no waiting badge', waiting === false);

// Clean up: clear the badge so later tests start neutral.
await fetch(`http://127.0.0.1:8099/agent?pane=${pane}&state=idle`).catch(() => {});
await page.screenshot({ path: 'shots/codex-notify.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('codex notify e2e passed');
