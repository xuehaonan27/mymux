// Git decorations on the code-panel file tree (VS Code-style colors):
// modified → .git-m, untracked → .git-u, staged-new → .git-a, ignored →
// .git-ign (dimmed), and a directory inherits its dirtiest descendant.
// Ignored files must NOT pollute the changes list. Saving an edit in the
// editor flips the file's porcelain state live. Fixture: ~/ux-git-tree repo.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8092, 'gittree');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};

execSync(`
  rm -rf ~/ux-git-tree && mkdir -p ~/ux-git-tree/sub ~/ux-git-tree/ignored && cd ~/ux-git-tree && git init -q
  git config user.email t@t && git config user.name t
  printf 'clean\\n' > clean.txt && printf 'mod\\n' > mod.txt && printf 'inner\\n' > sub/inner.txt
  printf 'ign.txt\\nignored/\\n' > .gitignore
  git add -A && git commit -qm init
  printf 'mod2\\n' >> mod.txt                 # modified
  printf 'inner2\\n' >> sub/inner.txt         # modified inside a dir
  printf 'un\\n' > un.txt                     # untracked
  printf 'add\\n' > add.txt && git add add.txt  # staged new
  printf 'ign\\n' > ign.txt                   # ignored (match)
  printf 'x\\n' > ignored/x.txt               # inside ignored dir
`);

const cls = async (page, name) =>
  page.evaluate((n) => {
    const row = [...document.querySelectorAll('#code-tree .trow')].find((r) => r.textContent.replace(/^[▸▾] /, '') === n);
    return row ? row.className : null;
  }, name);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);

await page.mouse.click(720, 450);
await page.keyboard.type('cd ~/ux-git-tree');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1500); // loadChanges + decorate wave

check('modified file is git-m', (await cls(page, 'mod.txt'))?.includes('git-m'));
check('untracked file is git-u', (await cls(page, 'un.txt'))?.includes('git-u'));
check('staged-new file is git-a', (await cls(page, 'add.txt'))?.includes('git-a'));
check('ignored file is git-ign (dimmed)', (await cls(page, 'ign.txt'))?.includes('git-ign'));
check('ignored dir itself is git-ign', (await cls(page, 'ignored'))?.includes('git-ign'));
check('clean file wears no decoration', (await cls(page, 'clean.txt') ?? '').match(/git-[umad]/) === null && !(await cls(page, 'clean.txt'))?.includes('git-ign'));
check('dir inherits dirtiest child (sub → git-m)', (await cls(page, 'sub'))?.includes('git-m'));

// Ignored entries must stay OUT of the changes list.
const changes = await page.locator('#code-changes').textContent();
check('changes list hides ignored files', !changes?.includes('ign.txt') && !changes?.includes('ignored/'), changes ?? '');
check('changes list still shows real work', changes?.includes('mod.txt') && changes?.includes('un.txt') && changes?.includes('add.txt'));

// Edit + ⌘S a clean file: porcelain flips, the row repaints live.
const clickRow = async (name) => page.locator('#code-tree .trow', { hasText: name }).first().click();
await clickRow('clean.txt');
await page.waitForTimeout(1000);
await page.click('.cm-content');
await page.keyboard.type('dirty');
await page.keyboard.press('Control+s');
await page.waitForTimeout(1200);
check('save flips file to git-m live', (await cls(page, 'clean.txt'))?.includes('git-m'));

await page.screenshot({ path: 'shots/gittree.png' });
await browser.close();
sb.kill();
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('git tree decoration checks passed');
