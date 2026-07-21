// Markdown preview end-to-end against a sandboxed daemon: rendering, the
// sanitizer chain against real XSS payloads, relative-resource rewriting
// through /fs/raw, and the toggle round-trip. Non-md files don't get the
// button at all.
import { chromium } from 'playwright-core';
import { startSandbox } from './sandbox.mjs';
import { execSync } from 'node:child_process';

const sb = await startSandbox(8063, 'mdcheck');
process.on('exit', () => sb.kill());
const UI = process.env.UI ?? sb.ui;
const REPO = '/home/xuehaonan/ux-git-ops';
const fails = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) fails.push(name);
};
const git = (args) => execSync(`git -C ${REPO} ${args}`, { encoding: 'utf8' });

execSync(`cp /home/xuehaonan/mymux/ui/ux/wall-test.png ${REPO}/pic.png`);
execSync(`cat > ${REPO}/doc.md << 'MDEOF'
# Doc Title

Some **bold** and \`inline code\` text, plus [a relative link](data.bin) and
[an external link](https://example.com) and [an anchor](#part-two).

\`\`\`sh
echo fenced
\`\`\`

| col a | col b |
| ----- | ----- |
| t1    | t2    |

![a picture](pic.png)

## part two

<img src=x onerror=alert('xss-img')>
<script>alert('xss-script')</script>
[evil link](javascript:alert('xss-href'))
MDEOF`);
execSync(`echo bin > ${REPO}/data.bin`);
git('add doc.md pic.png data.bin pic.png 2>/dev/null || true');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('dialog', (d) => {
  fails.push(`unexpected dialog: ${d.message()}`);
  void d.dismiss();
});
await page.goto(UI, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.xterm', { timeout: 20000 });
await page.waitForTimeout(1200);
await page.click('.xterm');
await page.keyboard.type('cd ~/ux-git-ops');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.keyboard.press('Control+e');
await page.locator('.code-panel.show').waitFor({ timeout: 10000 });
await page.waitForTimeout(1200);

// Non-md file: no Prev button.
await page.locator('.trow', { hasText: 'a.txt' }).first().click();
await page.waitForTimeout(600);
check('Prev hidden for non-md files', await page.locator('#code-md').isHidden());

// Open doc.md, toggle preview.
await page.locator('.trow', { hasText: 'doc.md' }).first().click();
await page.waitForTimeout(900);
check('Prev shows for md files', await page.locator('#code-md').isVisible());
await page.click('#code-md');
await page.waitForTimeout(900);
const pv = page.locator('.code-mdpreview');
check('preview visible, editor hidden', await pv.isVisible());
check('h1 rendered', ((await pv.locator('h1').textContent()) ?? '').includes('Doc Title'));
check('fenced code rendered', (await pv.locator('pre code').textContent())?.includes('echo fenced'));
check('table rendered', (await pv.locator('td').nth(0).textContent()) === 't1');
check('anchor link kept', (await pv.locator('a[href="#part-two"]').count()) === 1);
check('external link has noopener', ((await pv.locator('a[href^="https://example.com"]').getAttribute('rel')) ?? '').includes('noopener'));

// XSS wall: payloads are escaped/stripped, never live markup.
check('no script elements', (await pv.locator('script').count()) === 0);
check('no onerror handlers', (await pv.locator('[onerror]').count()) === 0);
check('no javascript: hrefs', (await pv.locator('a[href^="javascript:"]').count()) === 0);
const evilText = await pv.textContent();
check('payload remains as inert text', (evilText ?? '').includes('xss-href'));

// Relative resources resolve through /fs/raw.
const imgSrc = (await pv.locator('img').first().getAttribute('src')) ?? '';
check('relative img rewritten to /fs/raw', imgSrc.includes('/fs/raw?') && imgSrc.includes('pic.png'), imgSrc.slice(0, 120));
await page.waitForFunction(() => {
  const img = document.querySelector('.code-mdpreview img');
  return img && img.naturalWidth > 0;
}, undefined, { timeout: 5000 }).catch(() => null);
check('image actually loaded', await page.evaluate(() => document.querySelector('.code-mdpreview img')?.naturalWidth > 0));
const linkHref = (await pv.locator('a', { hasText: 'a relative link' }).getAttribute('href')) ?? '';
check('relative link rewritten to /fs/raw', linkHref.includes('/fs/raw?') && linkHref.includes('data.bin'), linkHref.slice(0, 120));

// Doc-sourced content: edit (preview off), save, toggle back on → new content.
await page.click('#code-md');
await page.waitForTimeout(400);
await page.click('.cm-content');
await page.keyboard.press('Control+End');
await page.keyboard.type('\n\nvisible-after-toggle');
await page.keyboard.press('Control+s');
await page.waitForTimeout(800);
await page.click('#code-md');
await page.waitForTimeout(700);
check('re-render reflects the doc', ((await pv.textContent()) ?? '').includes('visible-after-toggle'));

// Toggle off → editor visible again.
await page.click('#code-md');
await page.waitForTimeout(400);
check('editor back after toggle off', await page.locator('.cm-content').isVisible() && !(await pv.isVisible()));

await page.screenshot({ path: 'shots/md-preview.png' });
await browser.close();
sb.kill();
// Fixture hygiene: the add/never-commit flow leaves the index dirty otherwise.
git('reset -q --hard origin/master');
git('clean -fdq');
if (fails.length) {
  console.error('FAILURES:', fails.join(' | '));
  process.exit(1);
}
console.log('markdown preview checks passed');
