// Submodule --init + graph S badge end-to-end: deinit the fixture submodule,
// then the tree offers a one-click init; after that the graph panel badges
// the dirty gitlink S. Fixture rebuilt per run.
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
const subs = async () => (await (await fetch(`${API}/git/submodules?root=${encodeURIComponent(R)}`)).json());

// Fresh fixture: super-repo with submodule lib/, then DEINIT it.
sh(`rm -rf ${R} ${R}-lib`);
sh(`git init -q ${R}-lib && echo v1 > ${R}-lib/lib.txt && git -C ${R}-lib add -A && git -C ${R}-lib commit -qm lib-init`);
sh(`git init -q ${R} && echo top > ${R}/top.txt && git -C ${R} add -A && git -C ${R} commit -qm init`);
sh(`git -C ${R} -c protocol.file.allow=always submodule add -q ${R}-lib lib && git -C ${R} commit -qm with-sub`);
sh(`git -C ${R} submodule deinit -q -f lib`);

let s = await subs();
check('daemon sees lib uninitialized', s.some((x) => x.path === 'lib' && x.initialized === false), JSON.stringify(s));

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

// Expand lib (empty dir) → the init row appears.
await page.locator('.trow.tdir', { hasText: 'lib' }).first().click();
await page.waitForTimeout(900);
check('init row offered', (await page.locator('.trow.tsubinit').count()) === 1);
await page.click('.trow.tsubinit');
await page.waitForTimeout(2500);
check('init populated the dir', (await page.locator('.trow', { hasText: 'lib.txt' }).count()) === 1);
check('init row melted away', (await page.locator('.trow.tsubinit').count()) === 0);
s = await subs();
check('daemon sees lib initialized', s.some((x) => x.path === 'lib' && x.initialized === true));

// Dirty inside the submodule → the graph badges the gitlink S.
sh(`echo dirt >> ${R}/lib/lib.txt`);
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.click('.git-tab[data-page="changes"]'); // default landing is the History graph now
await page.locator('.git-changes-side .git-detail-title').first().waitFor({ timeout: 10000 });
check('graph badges the submodule S', (await page.locator('.git-file', { hasText: 'lib' }).locator('.gbadge.gsub').count()) === 1);
check('plain files keep their letter', (await page.locator('.git-file .gbadge.gsub').count()) === 1);

await page.screenshot({ path: 'shots/git-subinit.png' });
await browser.close();
sh(`git -C ${R}/lib checkout -q -- lib.txt`);
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git submodule-init checks passed');
