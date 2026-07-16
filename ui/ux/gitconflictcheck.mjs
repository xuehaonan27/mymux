// Merge-conflict resolution end-to-end against ~/ux-git-ops: the graph
// panel's conflict banner, jump into the editor, Accept-* widgets, stage →
// Continue; then a second round ending in Abort.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const UI = process.env.UI ?? 'http://127.0.0.1:5173/?port=8099';
const REPO = '/home/xuehaonan/ux-git-ops';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const git = (args) => execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' });
const gitTry = (args) => {
  try { return git(args); } catch { return ''; }
};
const read = (p) => readFileSync(`${REPO}/${p}`, 'utf8');

// Fresh conflict: c.txt = "beta" on master, "alpha" on branch c-a → UU.
gitTry('merge --abort'); // a crashed earlier run may linger mid-merge
gitTry('rebase --abort');
git('checkout -q master');
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D c-a');
git('checkout -q -b c-a');
execSync(`echo alpha > ${REPO}/c.txt`);
git('add -A'); git('commit -qm "a: alpha"');
git('checkout -q master');
execSync(`echo beta > ${REPO}/c.txt`);
git('add -A'); git('commit -qm "m: beta"');
gitTry('merge c-a'); // conflicts by design (non-zero exit swallowed)
check('fixture is mid-merge with 1 conflict', /(UU|AA) c\.txt/.test(git('status --porcelain')), git('status --porcelain'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-ops');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
await page.locator('.git-changes-side .git-detail-title').first().waitFor({ timeout: 10000 });

// 1. The uncommitted card carries the conflict banner.
const banner = page.locator('.git-conflict-banner');
check('conflict banner shows', (await banner.count()) === 1);
check('banner names the state + count', ((await banner.textContent()) ?? '').includes('merge in progress · 1 conflicted'), await banner.textContent());
check('Continue + Abort buttons', (await banner.locator('.pkgs-btn').count()) === 2);

// 2. Clicking the conflicted row opens the editor with the accept bar.
await page.locator('.git-file-conflict', { hasText: 'c.txt' }).first().click();
await page.waitForTimeout(1500);
check('code panel opened', (await page.locator('.code-panel.show').count()) === 1);
check('graph closed for the jump', (await page.locator('.git-panel.show').count()) === 0);
check('c.txt in the editor', ((await page.locator('#code-path').textContent()) ?? '').includes('c.txt'));
check('conflict bar rendered', (await page.locator('.cm-conflict-bar').count()) === 1);
check('three accept buttons', (await page.locator('.cm-conflict-btn').count()) === 3);
const editorText = () => page.evaluate(() => document.querySelector('.cm-content')?.textContent ?? '');
check('markers visible in the doc', (await editorText()).includes('<<<<<<<'), (await editorText()).slice(0, 120));

// 3. Accept Incoming → the doc becomes the theirs side; save it.
await page.locator('.cm-conflict-btn', { hasText: 'Accept Incoming' }).click();
await page.waitForTimeout(500);
check('bar melted after resolution', (await page.locator('.cm-conflict-bar').count()) === 0);
check('doc is now "alpha"', !(await editorText()).includes('beta') && (await editorText()).includes('alpha'), (await editorText()).slice(0, 60));
await page.click('.cm-content');
await page.keyboard.press('Control+s');
await page.waitForTimeout(900);
check('file saved as alpha', read('c.txt').trim() === 'alpha', read('c.txt'));

// 4. Back to the graph: still mid-merge → stage c.txt → Continue.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('#btn-git');
await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
// Panel shows before the async load() fills it — wait for real content.
await page.locator('.git-changes-side .git-detail-title').first().waitFor({ timeout: 10000 });
check('banner persists while unresolved', (await page.locator('.git-conflict-banner').count()) === 1);
await page.locator('.git-file', { hasText: 'c.txt' }).locator('.git-stage-btn').click();
await page.waitForTimeout(1200);
check('staging marked it resolved', git('status --porcelain').startsWith('M  c.txt'), git('status --porcelain'));
await page.click('.git-conflict-banner .pkgs-btn.primary');
await page.waitForTimeout(1500);
check('Continue completed the merge', git('log -1 --format=%s').startsWith('Merge branch'), git('log -1 --format=%s'));
check('banner gone after completion', (await page.locator('.git-conflict-banner').count()) === 0);
check('worktree clean', git('status --porcelain').trim() === '');

// 5. Round two: another conflict, this time Abort (two-click).
git('checkout -q -b c-b');
execSync(`echo gamma > ${REPO}/c2.txt`);
git('add -A'); git('commit -qm "b: gamma"');
git('checkout -q master');
execSync(`echo delta > ${REPO}/c2.txt`);
git('add -A'); git('commit -qm "m: delta"');
gitTry('merge c-b');
await page.click('.git-toolbar .pkgs-btn:text-is("Refresh")');
await page.waitForTimeout(900);
check('second conflict detected', ((await page.locator('.git-conflict-banner').textContent()) ?? '').includes('1 conflicted'));
const abort = page.locator('.git-conflict-banner .pkgs-btn.git-danger');
await abort.click();
check('abort armed, not run', /(UU|AA) c2\.txt/.test(git('status --porcelain')));
await page.locator('.git-conflict-banner .pkgs-btn.git-danger[data-armed="1"]').click();
await page.waitForTimeout(1500);
check('abort ran', git('status --porcelain').trim() === '', git('status --porcelain'));
check('MERGE_HEAD cleared', gitTry('rev-parse --verify MERGE_HEAD') === '');
check('ours content survived the abort', read('c2.txt').trim() === 'delta');

await page.screenshot({ path: 'shots/git-conflict.png' });
await browser.close();

// Leave the fixture pristine.
git('reset -q --hard origin/master');
git('clean -fdq');
gitTry('branch -D c-a');
gitTry('branch -D c-b');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git conflict checks passed');
