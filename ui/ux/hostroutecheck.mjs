// Multi-host panel routing: with TWO connected hosts, the code panel opened
// from one host's window must show THAT host's filesystem (pane-scope and
// api-base must follow the ACTIVE workspace — the reported bug: the second
// host's editor kept showing the first host's content). Two stubbed hosts
// → two REAL sandbox daemon pairs (h-a@8077, h-b@8078), each driven to a
// distinct fixture dir; the tree must switch with the host chip.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { startSandbox } from './sandbox.mjs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

// Distinct fixtures per host.
execSync('mkdir -p ~/ux-host-a && echo aaa > ~/ux-host-a/markerAAA.txt');
execSync('mkdir -p ~/ux-host-b && echo bbb > ~/ux-host-b/markerBBB.txt');

// Two sandbox daemon pairs (own ptyd socket + tmux socket + port each).
const sbA = await startSandbox(8077, 'hr-a');
const sbB = await startSandbox(8078, 'hr-b');
process.on('exit', () => {
  sbA.kill();
  sbB.kill();
});

const HOSTS = [
  { id: 'h-a', label: 'hostA', hostname: 'a.example', user: 'u', port: 22, identity_path: '/tmp/k', _port: 8077 },
  { id: 'h-b', label: 'hostB', hostname: 'b.example', user: 'u', port: 22, identity_path: '/tmp/k', _port: 8078 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
if (process.env.DEBUG) {
  page.on('websocket', (ws) => {
    console.log('[ws open]', ws.url());
    ws.on('framereceived', (f) => {
      const p = typeof f.payload === 'string' ? f.payload.slice(0, 60) : `bin(${(f.payload ?? '').length ?? 0})`;
      if (!p.includes('ping')) console.log('[ws recv]', ws.url().slice(-8), p);
    });
  });
}
await page.addInitScript((hosts) => {
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push(`error:${e.message}`));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push(`rej:${String(e.reason).slice(0, 160)}`));
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === 'hosts_list') {
        return Promise.resolve({
          hosts: hosts.map(({ _port, ...h }) => h),
          default_id: null,
        });
      }
      if (cmd === 'conns_list') {
        return Promise.resolve(hosts.map((h) => ({ host_id: h.id, port: h._port, status: 'connected' })));
      }
      if (cmd === 'conn_status') return Promise.resolve(['connected', 0]);
      if (cmd === 'host_meta') {
        return Promise.resolve({
          daemon: { current: 'x', expected: 'x', outdated: false },
          hooks: { claude: true, codex: true, kimi: true, opencode: true },
        });
      }
      if (cmd === 'host_meta_refresh') return Promise.resolve(null);
      if (cmd === 'plugin:event|listen') return Promise.resolve(0);
      return Promise.reject(new Error(`stub: ${cmd}`));
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
  };
}, HOSTS);

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(800);

/** Open a host's workspace from the manager, then drive its shell somewhere. */
const openHost = async (label, cwd) => {
  await page.locator('.host-card-main', { hasText: label }).first().click();
  if (process.env.DEBUG) {
    await page.waitForTimeout(1500);
    const dump = await page.evaluate(() => ({
      workspaces: [...document.querySelectorAll('.workspace')].map((w) => ({
        display: getComputedStyle(w).display,
        panes: w.querySelectorAll('.pane').length,
      })),
      tabs: document.querySelectorAll('.tab').length,
      chips: [...document.querySelectorAll('.hostchip')].map((t) => t.textContent),
      bodyClass: document.body.className,
      paneHtml: (document.querySelectorAll('.workspace')[1] ?? document.querySelector('.workspace'))?.querySelector('.pane')?.innerHTML?.slice(0, 200) ?? '(no pane el)',
      errs: window.__errs,
    }));
    console.log(`DEBUG openHost(${label}):`, JSON.stringify(dump));
  }
  await page.locator('.xterm:visible').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('.xterm:visible').first().click();
  await page.keyboard.type(`cd ~/${cwd}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
};

/** Reopen the host manager, click the other card. */
const openManager = async () => {
  await page.click('#btn-host');
  await page.locator('.host-panel.show').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
};

const treeHas = async (needle) => ((await page.locator('#code-tree').textContent()) ?? '').includes(needle);

await openHost('hostA', 'ux-host-a');
if (process.env.DEBUG) {
  const dump = await page.evaluate(() => ({
    workspaces: [...document.querySelectorAll('.workspace')].map((w) => ({
      display: getComputedStyle(w).display,
      panes: w.querySelectorAll('.pane').length,
      width: Math.round(w.getBoundingClientRect().width),
    })),
    xterms: [...document.querySelectorAll('.xterm')].map((x) => {
      const r = x.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), vis: x.checkVisibility() };
    }),
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent),
    chips: [...document.querySelectorAll('.hostchip')].map((t) => t.textContent),
  }));
  console.log('DEBUG after openHost:', JSON.stringify(dump));
  await page.screenshot({ path: 'shots/routeprobe.png' });
}
await openManager();
await openHost('hostB', 'ux-host-b');
check('two host chips in the bar', (await page.locator('.hostchip').count()) === 2, `${await page.locator('.hostchip').count()}`);

// On hostB (active): the tree must show hostB's dir.
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
check('hostB editor shows markerBBB', await treeHas('markerBBB.txt'), (await page.locator('#code-tree').textContent())?.slice(0, 120));
check('hostB editor has NO markerAAA', !(await treeHas('markerAAA.txt')));
check('hostB root path is ux-host-b', ((await page.locator('#code-root-path').textContent()) ?? '').endsWith('/ux-host-b'), await page.locator('#code-root-path').textContent());
await page.keyboard.press('Control+e');
await page.waitForTimeout(300);

// Switch to hostA via its chip: the tree must swap to hostA's dir.
await page.locator('.hostchip', { hasText: 'hostA' }).first().click();
await page.waitForTimeout(900);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);
check('hostA editor shows markerAAA', await treeHas('markerAAA.txt'), (await page.locator('#code-tree').textContent())?.slice(0, 120));
check('hostA editor has NO markerBBB', !(await treeHas('markerBBB.txt')));
check('hostA root path is ux-host-a', ((await page.locator('#code-root-path').textContent()) ?? '').endsWith('/ux-host-a'), await page.locator('#code-root-path').textContent());

// The reported flow: the code panel is OPEN while the user switches hosts
// with a chip — the panel must swap sessions with the host, not keep the
// first host's tree on screen beside the second host's terminals.
await page.locator('.hostchip', { hasText: 'hostB' }).first().click();
await page.waitForTimeout(1400);
check('panel open: tree swaps to hostB on chip switch', await treeHas('markerBBB.txt') && !(await treeHas('markerAAA.txt')), (await page.locator('#code-tree').textContent())?.slice(0, 120));
check('panel open: root follows the chip switch', ((await page.locator('#code-root-path').textContent()) ?? '').endsWith('/ux-host-b'), await page.locator('#code-root-path').textContent());
await page.locator('.hostchip', { hasText: 'hostA' }).first().click();
await page.waitForTimeout(1400);
check('panel open: tree swaps back to hostA', await treeHas('markerAAA.txt') && !(await treeHas('markerBBB.txt')));

await page.screenshot({ path: 'shots/hostroute.png' });
await browser.close();
sbA.kill();
sbB.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('multi-host routing checks passed');
