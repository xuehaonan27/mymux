// Host-status state machine (P1-03 regression guard): the app folds transient
// supervisor Notes into the current phase's `why`, and reserves `{error}` for
// TERMINAL failures. Replayed at the hostmanager level with a stubbed Tauri
// IPC + a real sandbox daemon for the workspace to attach to:
//   C) connecting → {error}        → settles the attempt; a late `connected`
//                                    must NOT open a workspace.
//   A) connecting(why) → installing → connecting → connected  (the zero-touch
//                                    install sequence) → attempt never
//                                    settles, the workspace OPENS.
//   B) connected + why (one health miss folded by the backend) → the host
//                                    card stays live, never stuck on
//                                    connecting/error.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';

const sb = await startSandbox(8071, 'hoststatus');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? 'http://127.0.0.1:5173/';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fails.push(name);
};

const HOST = { id: 'h-1', label: 'zeroTouch', hostname: 'zt.example', user: 'u', port: 22, identity_path: '/tmp/k' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.addInitScript(
  ({ host, daemonPort }) => {
    window.__connected = false; // conns_list reports the live tunnel only once "connected" landed
    window.__CALLS__ = []; // recorded invoke arg shapes (owner rule: stubs assert shapes)
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        if (cmd === 'plugin:event|listen') {
          (window.__listeners ??= {})[args.event] ??= [];
          window.__listeners[args.event].push(args.handler);
          return Promise.resolve(args.handler);
        }
        if (cmd === 'plugin:event|unlisten') return Promise.resolve();
        if (['connect', 'disconnect', 'host_meta', 'host_meta_refresh'].includes(cmd)) {
          window.__CALLS__.push([cmd, Object.keys(args ?? {})]);
        }
        if (cmd === 'hosts_list') {
          const store = { hosts: [host], default_id: null };
          const d = window.__listDelay ?? 0; // C-23 probe: slow list I/O
          return d ? new Promise((r) => setTimeout(() => r(store), d)) : Promise.resolve(store);
        }
        if (cmd === 'conns_list') {
          return Promise.resolve(
            window.__connected ? [{ host_id: host.id, port: daemonPort, status: 'connected' }] : [],
          );
        }
        if (cmd === 'connect') return Promise.resolve(daemonPort);
        if (cmd === 'disconnect') return Promise.resolve();
        if (cmd === 'host_meta') return Promise.resolve(null);
        if (cmd === 'host_meta_refresh') return Promise.resolve(null);
        return Promise.reject(new Error(`stub: ${cmd}`));
      },
      transformCallback: (cb) => {
        window.__cbSeq = (window.__cbSeq ?? 0) + 1;
        window[`_${window.__cbSeq}`] = cb;
        return window.__cbSeq;
      },
      unregisterCallback: () => {},
    };
    // Drive a backend event exactly as Tauri would deliver it.
    window.__emit = (event, payload) => {
      for (const id of window.__listeners?.[event] ?? []) window[`_${id}`]({ event, id, payload });
    };
  },
  { host: HOST, daemonPort: 8071 },
);

const emitStatus = (status, why) =>
  page.evaluate(
    ([s, w]) => window.__emit('mymux:status', { host_id: 'h-1', status: s, ...(w ? { why: w } : {}) }),
    [status, why],
  );

await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.host-panel.show', { timeout: 20000 });
await page.waitForTimeout(500);

// ---- D) C-23 + #14: a late showList must not erase the form; inline error --
await page.keyboard.press('Escape'); // dismiss the boot gate (panel hides)
await page.waitForTimeout(300);
await page.evaluate(() => {
  window.__listDelay = 900; // the reopen's showList I/O resolves LATE
});
await page.click('#btn-host'); // reopen → showList pending, old list preserved
await page.locator('.host-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(200);
await page.locator('.host-card .host-icon[title="Edit"]').click(); // form claims a newer view
await page.waitForTimeout(100);
check(
  'edit form opens over the preserved list',
  await page.evaluate(
    () => document.querySelector('.host-title')?.textContent === 'Edit host' && document.querySelectorAll('.host-input').length > 0,
  ),
);
await page.waitForTimeout(1100); // the slow showList resolves in here
check(
  'C-23: late showList did NOT erase the form',
  await page.evaluate(
    () => document.querySelector('.host-title')?.textContent === 'Edit host' && document.querySelectorAll('.host-input').length > 0,
  ),
);
// #14: empty hostname/user → inline error, no inert alert, no navigation.
await page.locator('.host-field', { hasText: 'Hostname' }).locator('input').fill('');
await page.locator('.host-field', { hasText: 'User' }).locator('input').fill('');
await page.locator('.host-btn.primary', { hasText: 'Save' }).click();
await page.waitForTimeout(300);
check(
  '#14: empty save paints an inline error',
  await page.evaluate(() =>
    document.querySelector('.host-status.error')?.textContent.includes('Hostname and user are required.'),
  ),
);
check(
  '#14: form survives the failed save',
  await page.evaluate(() => document.querySelector('.host-title')?.textContent === 'Edit host'),
);
await page.evaluate(() => {
  window.__listDelay = 0;
});
await page.locator('.host-back').click(); // back to a fast list for the next sequence
await page.locator('.host-card-main', { hasText: 'zeroTouch' }).waitFor({ timeout: 5000 });

// ---- C) a TERMINAL {error} settles the attempt ------------------------------
await page.locator('.host-card-main', { hasText: 'zeroTouch' }).first().click();
await page.locator('.host-btn.primary', { hasText: 'Connect' }).waitFor({ timeout: 5000 });
await page.locator('.host-btn.primary').click();
await page.waitForTimeout(300);
await emitStatus('connecting');
await page.waitForTimeout(150);
await emitStatus({ error: 'boom (terminal)' });
await page.waitForTimeout(200);
check(
  'terminal error paints the inline error',
  await page.evaluate(() => document.querySelector('.host-status.error')?.textContent.includes('boom')),
);
check(
  'terminal error re-arms the Connect button',
  (await page.locator('.host-btn.primary').textContent()) === 'Connect',
);
await emitStatus('connected'); // late success must be ignored (attempt settled)
await page.waitForTimeout(600);
check(
  'no workspace from a post-settle connected',
  (await page.locator('.workspace').count()) === 0,
);

// ---- A) zero-touch install: notes never settle ------------------------------
await page.locator('.host-btn.primary').click(); // re-drive the same form
await page.waitForTimeout(300);
await emitStatus('connecting', 'mymuxd not answering on remote port 8088 after 14 probes — running the installer next');
await page.waitForTimeout(150);
check(
  'progress note rides the connecting phase',
  await page.evaluate(() => {
    const s = document.querySelector('.host-status');
    return s?.className.includes('info') && s.textContent.includes('running the installer next');
  }),
  await page.locator('.host-status').textContent(),
);
check(
  'attempt survives the note (button still Cancel)',
  (await page.locator('.host-btn.primary').textContent()) === 'Cancel',
);
await emitStatus('installing');
await page.waitForTimeout(150);
check(
  'installing phase shows progress, not failure',
  await page.evaluate(() => {
    const s = document.querySelector('.host-status');
    return s?.className.includes('info') && s.textContent.includes('installing it now');
  }),
);
await emitStatus('connecting');
await page.waitForTimeout(150);
await page.evaluate(() => {
  window.__connected = true; // the tunnel is live from here on
});
await emitStatus('connected');
await page.waitForSelector('.workspace', { timeout: 20000 });
check('zero-touch sequence opens the workspace', true);
await page.locator('.xterm').first().waitFor({ timeout: 20000 });
check('workspace terminal attached to the sandbox daemon', true);
check(
  'panel hidden after connect',
  (await page.locator('.host-panel.show').count()) === 0,
);

// ---- B) one folded health-miss must not stick on connecting/error -----------
await emitStatus('connected', 'health probe missed once — double-checking before declaring the link dead');
await page.waitForTimeout(400);
await page.click('#btn-host');
await page.locator('.host-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(400);
check(
  'card stays live after a folded health miss',
  (await page.locator('.host-card .host-live').count()) === 1,
);
check(
  'card is NOT stuck on connecting',
  await page.evaluate(
    () => ![...document.querySelectorAll('.host-card-sub')].some((x) => x.textContent.includes('connecting…')),
  ),
);
check(
  'no error painted anywhere in the panel',
  (await page.locator('.host-panel .host-status.error').count()) === 0,
);

// Tauri commands are all rename_all="snake_case": recorded calls must carry
// host_id, never hostId (the class that shipped broken once).
const badShapes = (await page.evaluate(() => window.__CALLS__)).filter(
  (c) => !c[1].includes('host_id') || c[1].includes('hostId'),
);
check('all recorded calls pass snake_case host_id', badShapes.length === 0, JSON.stringify(badShapes));

await page.screenshot({ path: 'shots/hoststatus.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('host status state-machine checks passed');
