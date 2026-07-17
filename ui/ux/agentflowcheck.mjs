// Agent-ask triage end-to-end (defer / consume): SANDBOXED ptyd+mymuxd pair
// (own socket — the production ptyd holding real shells is never touched).
// Two windows get hook-reported "waiting" asks; DEFER re-stamps the asker's
// needy-since so it sinks to the back of the attention ordering while the
// badge stays on; CONSUME drops the badge outright; and a FRESH hook report
// re-raises it (the consume suppression lifts on the next exchange).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8096';
const PORT = 8096;
const SOCK = '/tmp/mymux-flow-test.sock';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MYMUX_PTYD_SOCK: SOCK };
rmSync(SOCK, { force: true });

// Boot the sandbox drawer: ptyd on its own socket, mymuxd on 8096 on top.
const BIN = '/home/xuehaonan/mymux/target/debug';
const ptyd = spawn(`${BIN}/mymux-ptyd`, [], { env, stdio: 'ignore' });
for (let i = 0; i < 50 && !existsSync(SOCK); i++) await sleep(100);
check('sandbox ptyd socket up', existsSync(SOCK));
const daemon = spawn(`${BIN}/mymuxd`, [], { env: { ...env, MYMUX_ADDR: `127.0.0.1:${PORT}` }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/proc/tree`);
    if (r.ok) break;
  } catch { /* boot */ }
  await sleep(100);
}

const post = (op, pane) =>
  fetch(`http://127.0.0.1:${PORT}/agent/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pane }),
  });

// window panes in creation order == tab order (both are first-seen ordered).
const panesByTab = async () => {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/proc/tree`)).json();
  return t.windows
    .sort((a, b) => a.id - b.id)
    .map((w) => w.panes.map((p) => p.pane));
};

// Tab tooltip age in seconds: "waiting for 12s · double-click …".
const tabAge = async (page, i) => {
  const title = (await page.locator('.tab').nth(i).getAttribute('title')) ?? '';
  const m = title.match(/for (\d+)([smhd])/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 86400 : m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
check('one window at start', (await page.locator('.tab').count()) === 1);

await page.click('#btn-newwin');
await page.waitForTimeout(1500);
check('second window up', (await page.locator('.tab').count()) === 2);
const [paneA, paneB] = (await panesByTab()).map((p) => p[0]);
check('both panes enumerated', paneA != null && paneB != null && paneA !== paneB);

// Ask on window A (hook-style report); a beat later, one on window B.
await fetch(`http://127.0.0.1:${PORT}/agent?pane=${paneA}&state=waiting`);
let dot = 0;
for (let i = 0; i < 10 && !dot; i++) {
  dot = await page.locator('.tab').nth(0).locator('.adot.agent-waiting').count();
  if (!dot) await sleep(300);
}
check('hook report badges window A', dot === 1);
await sleep(2500);
await fetch(`http://127.0.0.1:${PORT}/agent?pane=${paneB}&state=waiting`);
dot = 0;
for (let i = 0; i < 10 && !dot; i++) {
  dot = await page.locator('.tab').nth(1).locator('.adot.agent-waiting').count();
  if (!dot) await sleep(300);
}
check('hook report badges window B', dot === 1);
await sleep(2500);

const ageA0 = await tabAge(page, 0);
const ageB0 = await tabAge(page, 1);
check('A asked first (older tooltip age)', ageA0 != null && ageB0 != null && ageA0 > ageB0, `A=${ageA0}s B=${ageB0}s`);

// DEFER A: badge stays, but its age reboots below B's (back of the queue).
await post('defer', paneA);
let ageA = null;
let ageB = null;
for (let i = 0; i < 14; i++) {
  ageA = await tabAge(page, 0);
  ageB = await tabAge(page, 1);
  if (ageA != null && ageB != null && ageA < ageB) break;
  await sleep(400);
}
check('defer keeps both badges', (await page.locator('.tab .adot.agent-waiting').count()) === 2);
check('defer sinks A to the queue tail', ageA != null && ageB != null && ageA < ageB, `A=${ageA}s B=${ageB}s`);

// CONSUME A: badge gone, B untouched; the glance count drops to one ask.
await post('consume', paneA);
let gone = false;
for (let i = 0; i < 14 && !gone; i++) {
  gone = (await page.locator('.tab').nth(0).locator('.adot').count()) === 0;
  if (!gone) await sleep(400);
}
check('consume drops A\u2019s badge', gone);
check('B\u2019s badge survives', (await page.locator('.tab').nth(1).locator('.adot.agent-waiting').count()) === 1);
check('glance summary back to a single ask', /1 waiting/.test(await page.locator('#agents').textContent() ?? ''));

// A FRESH hook report lifts the suppression: window A badges again.
await fetch(`http://127.0.0.1:${PORT}/agent?pane=${paneA}&state=waiting`);
dot = 0;
for (let i = 0; i < 10 && !dot; i++) {
  dot = await page.locator('.tab').nth(0).locator('.adot.agent-waiting').count();
  if (!dot) await sleep(300);
}
check('next hook report re-badges A', dot === 1);

await page.screenshot({ path: 'shots/agentflow.png' });
await browser.close();
daemon.kill();
ptyd.kill();
rmSync(SOCK, { force: true });
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('agent-flow (defer/consume) checks passed');
