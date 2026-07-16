// Submodule support end-to-end: the daemon flags gitlinks in /git/status,
// the changes list badges them S, and clicking one switches the panel root
// INTO the submodule (its own status/diffs then work). Fixture is rebuilt
// from scratch each run (a repo with one dirty local submodule).
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const API = process.env.API ?? 'http://127.0.0.1:8099';
const R = '/home/xuehaonan/ux-git-sub';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' });

// Fresh fixture: super-repo with top.txt + submodule lib/ (dirty inside).
sh(`rm -rf ${R} ${R}-lib`);
sh(`git init -q ${R}-lib && echo v1 > ${R}-lib/lib.txt && git -C ${R}-lib add -A && git -C ${R}-lib commit -qm lib-init`);
sh(`git init -q ${R} && echo top > ${R}/top.txt && git -C ${R} add -A && git -C ${R} commit -qm init`);
sh(`git -C ${R} -c protocol.file.allow=always submodule add -q ${R}-lib lib && git -C ${R} commit -qm with-sub`);
sh(`echo topchange >> ${R}/top.txt && echo subchange >> ${R}/lib/lib.txt`);

// 1. Daemon level: the gitlink is flagged, the plain file is not.
const st = await (await fetch(`${API}/git/status?root=${encodeURIComponent(R)}`)).json();
const libRow = st.find((f) => f.path === 'lib');
const topRow = st.find((f) => f.path === 'top.txt');
check('status flags the submodule gitlink', libRow?.submodule === true, JSON.stringify(libRow));
check('plain files are not flagged', topRow?.submodule === false, JSON.stringify(topRow));

// 2. UI level: badge + click-through into the submodule root.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-sub');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

const subBadge = page.locator('.grow', { hasText: 'lib' }).locator('.gbadge.gsub');
check('changes list badges the submodule S', (await subBadge.count()) === 1);
check('plain file has no S badge', (await page.locator('.grow', { hasText: 'top.txt' }).locator('.gbadge.gsub').count()) === 0);

// Click it → the panel roots INSIDE the submodule; its own changes show.
await page.locator('.grow', { hasText: 'lib' }).first().click();
await page.waitForTimeout(1200);
const rootPath = () => page.locator('#code-root-path').textContent();
check('root switched into the submodule', (await rootPath())?.endsWith('/ux-git-sub/lib'), await rootPath());
check('submodule changes list shows lib.txt', (await page.locator('.grow', { hasText: 'lib.txt' }).count()) === 1);
check('submodule files tree lists its contents', (await page.locator('.trow', { hasText: 'lib.txt' }).count()) >= 1);

// Its diff works too (nested repo resolves itself).
await page.locator('.grow', { hasText: 'lib.txt' }).first().click();
await page.waitForTimeout(1000);
check('diff inside the submodule renders', ((await page.locator('#code-diff').textContent()) ?? '').includes('subchange'));

// ⎇ root-repo stays (a submodule IS its own toplevel); ⌂ goes back to the pane.
await page.click('#root-repo');
await page.waitForTimeout(900);
check('⎇ stays at the submodule root', (await rootPath())?.endsWith('/ux-git-sub/lib'), await rootPath());
await page.click('#root-home');
await page.waitForTimeout(900);
check('⌂ returns to the super-repo view', (await rootPath())?.endsWith('/ux-git-sub'), await rootPath());
check('the S badge is back', (await page.locator('.grow .gbadge.gsub').count()) === 1);

await page.screenshot({ path: 'shots/git-submodule.png' });
await browser.close();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git submodule checks passed');
