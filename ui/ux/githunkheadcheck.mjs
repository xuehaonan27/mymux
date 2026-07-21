// Partial-staging hunk headers (P1-14): a reduced patch must keep BOTH hunk
// starts from the source header (an earlier unchosen hunk's net line change
// makes them differ) — only the counts are recomputed. Two fixture shapes,
// asserted at two levels:
//   unit — buildPatch() (imported straight from the vite-served module) on
//          hand-crafted diffs, asserting the exact emitted header bytes;
//   e2e  — real repos driven through the git panel's workbench: the
//          /git/apply POST body's hunk-2 header must equal git's own, and the
//          apply must land at the right place (no offset/fuzz rescue).
// Fixtures live under $HOME (the daemon confines root overrides to $HOME —
// /tmp repos 403/fall back), and are removed on exit.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8087, 'githunkhead');
const INS = `${process.env.HOME}/mymux-ux-hunk-ins`;
const DEL = `${process.env.HOME}/mymux-ux-hunk-del`;
const cleanFixtures = () => execSync(`rm -rf ${INS} ${DEL}`);
process.on('exit', () => {
  sb.kill();
  cleanFixtures();
});
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const git = (repo, args) => execSync(`git -C ${repo} ${args}`, { encoding: 'utf8' });

// ---- unit: exact header bytes out of buildPatch ------------------------------
// h1 adds 3 lines (insertion before a later hunk): h2's new start is old+3.
const DIFF_INS = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -5,6 +5,9 @@
 line 4
 line 5
+inserted-a
+inserted-b
+inserted-c
 line 6
 line 7
 line 8
@@ -35,6 +38,6 @@
 line 35
 line 36
-line 37 old
+line 37 CHANGED
 line 38
 line 39
 line 40
`;
// h1 deletes 2 lines (deletion before a later hunk): h2's new start is old-2.
const DIFF_DEL = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -5,8 +5,6 @@
 line 4
 line 5
-line 6
-line 7
 line 8
 line 9
 line 10
 line 11
@@ -38,6 +36,6 @@
 line 37
 line 38
-line 39 old
+line 39 CHANGED
 line 40
 line 41
 line 42
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1000);

const unit = await page.evaluate(async ({ diffIns, diffDel }) => {
  const m = await import('/src/gitgraph.ts');
  // Choose every +/- line of the SECOND hunk only.
  const pickSecondHunk = (diff) => {
    const lines = diff.split('\n');
    const hunks = lines.map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);
    const chosen = new Set();
    for (let i = hunks[1] + 1; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) break;
      if (lines[i][0] === '+' || lines[i][0] === '-') chosen.add(i);
    }
    return m.buildPatch(lines, chosen);
  };
  // Line-level: ONLY the added line of the second hunk.
  const pickAddedLine = (diff) => {
    const lines = diff.split('\n');
    const hunks = lines.map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);
    const chosen = new Set();
    for (let i = hunks[1] + 1; i < lines.length; i++) {
      if (lines[i][0] === '+') chosen.add(i);
    }
    return m.buildPatch(lines, chosen);
  };
  return { ins: pickSecondHunk(diffIns), del: pickSecondHunk(diffDel), insLine: pickAddedLine(diffIns) };
}, { diffIns: DIFF_INS, diffDel: DIFF_DEL });

const headerOf = (patch) => (patch.match(/^@@ .* @@$/m) ?? [''])[0];
check(
  'insertion-before-later-hunk keeps the new-side start',
  headerOf(unit.ins) === '@@ -35,6 +38,6 @@',
  headerOf(unit.ins),
);
check(
  'deletion-before-later-hunk keeps the new-side start',
  headerOf(unit.del) === '@@ -38,6 +36,6 @@',
  headerOf(unit.del),
);
check(
  'line-pick recomputes only the counts',
  headerOf(unit.insLine) === '@@ -35,6 +38,7 @@',
  headerOf(unit.insLine),
);

// ---- e2e fixtures under $HOME (cleaned up on exit) ---------------------------
execSync(`
  rm -rf ${INS} ${DEL}
  mkdir -p ${INS} && cd ${INS} && git init -q
  git config user.email t@t && git config user.name t
  seq 1 40 | sed 's/^/line /' > f.txt && git add -A && git commit -qm base
  sed -i '6i inserted-a\\ninserted-b\\ninserted-c' f.txt
  sed -i '38s/.*/line 38 CHANGED/' f.txt

  mkdir -p ${DEL} && cd ${DEL} && git init -q
  git config user.email t@t && git config user.name t
  seq 1 40 | sed 's/^/line /' > f.txt && git add -A && git commit -qm base
  sed -i '6,7d' f.txt
  sed -i '36s/.*/line 36 CHANGED/' f.txt
`);

/** Drive the workbench of one fixture: stage ONLY hunk 2, capture the patch. */
const stageSecondHunk = async (repo, name) => {
  // git may suffix its header with a section heading — compare the @@ part.
  const raw = git(repo, 'diff').split('\n').filter((l) => l.startsWith('@@'))[1] ?? '';
  const expected = (raw.match(/^@@ .*? @@/) ?? [''])[0];
  await page.click('.xterm');
  await page.keyboard.type(`cd ${repo}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await page.click('#btn-git');
  await page.locator('.git-panel.show').waitFor({ timeout: 10000 });
  await page.click('.git-tab[data-page="changes"]');
  await page.locator('.git-changes-side .git-file').first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.locator('.git-changes-side .git-file', { hasText: 'f.txt' }).first().click();
  await page.waitForTimeout(900);
  check(`${name}: two hunks in the workbench`, (await page.locator('.git-workbench .dhunk').count()) === 2);
  const applyReq = page.waitForRequest('**/git/apply', { timeout: 8000 });
  await page.locator('.git-workbench .dhunk').nth(1).locator('.dl-hunk-btn').click();
  const patch = JSON.parse((await applyReq).postData() ?? '{}').patch ?? '';
  await page.waitForTimeout(1200);
  const emitted = headerOf(patch);
  check(`${name}: emitted hunk-2 header equals git’s own`, emitted === expected, `${emitted} vs ${expected}`);
  check(`${name}: hunk 2 staged`, git(repo, 'diff --staged').includes('CHANGED'));
  check(`${name}: hunk 1 NOT staged`, !git(repo, 'diff --staged').includes('inserted-a') && !git(repo, 'diff --staged').match(/^-line 6$/m));
  await page.keyboard.press('Escape'); // close the panel before the next fixture
  await page.waitForTimeout(300);
};

await stageSecondHunk(INS, 'insertion');
await stageSecondHunk(DEL, 'deletion');

await page.screenshot({ path: 'shots/git-hunkhead.png' });
await browser.close();
sb.kill();
cleanFixtures();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git hunk-header checks passed');
