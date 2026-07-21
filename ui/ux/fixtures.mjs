// Shared fixture repos for the ux harness, built IDEMPOTENTLY: a fixture that
// already exists (non-empty) is NEVER clobbered — checks mutate these repos
// across runs, so rebuilding would erase state or fail on the dirt. Missing
// fixtures are created exactly as the checks expect them (the layouts below
// mirror what ~/ux-git-test, ~/ux-git-ops + ~/ux-git-ops-bare.git, and
// ~/ux-code-tree actually hold). Run directly (`node ui/ux/fixtures.mjs`) or
// import the per-fixture ensure from a check.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const note = (msg) => console.log(`mymux-ux: ${msg}`);
const git = (args) => execSync(`git ${args}`);
const present = (p) => existsSync(p) && readdirSync(p).length > 0;
// Fixture commits get a fixed REPO-LOCAL identity so builders need no global
// git config (and real users' names never leak into throwaway history).
const ident = (repo) => {
  git(`-C ${repo} config user.name 'mymux ux'`);
  git(`-C ${repo} config user.email 'ux@mymux.invalid'`);
};

// ~/ux-git-test — 3 commits on master, then one UNSTAGED (file.txt) and one
// STAGED (staged.txt) modification: the changes/hunk/jump checks' dirt.
// sub/note.txt is COMMITTED (a tracked subdir the repo-root auto-jump checks
// cd into — an untracked subdir would inflate the porcelain count).
export function ensureGitTest() {
  const repo = join(HOME, 'ux-git-test');
  if (present(repo)) return note(`${repo} exists — left as-is`);
  git(`init -q -b master ${repo}`);
  ident(repo);
  writeFileSync(join(repo, 'file.txt'), 'alpha\nbeta\n');
  writeFileSync(join(repo, 'staged.txt'), 'staged one\n');
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'note.txt'), 'sub note\n');
  git(`-C ${repo} add .`);
  git(`-C ${repo} commit -qm init`);
  appendFileSync(join(repo, 'staged.txt'), 'chore1\n');
  git(`-C ${repo} commit -qam 'chore: history 1'`);
  appendFileSync(join(repo, 'staged.txt'), 'chore2\n');
  git(`-C ${repo} commit -qam 'chore: history 2'`);
  appendFileSync(join(repo, 'file.txt'), 'beta CHANGED\n'); // unstaged
  appendFileSync(join(repo, 'staged.txt'), 'staged CHANGED\n');
  git(`-C ${repo} add staged.txt`); // staged
  note(`built ${repo} (3 commits + staged/unstaged dirt)`);
}

// ~/ux-git-ops + ~/ux-git-ops-bare.git — a clone with its own local "remote":
// 5 commits (init a / add b / chore 1-3), master pushed and tracking. The
// write-ops checks stage/commit/push/fetch/pull/rebase against this pair.
export function ensureGitOps() {
  const repo = join(HOME, 'ux-git-ops');
  const bare = join(HOME, 'ux-git-ops-bare.git');
  // The pair is one fixture: half-present state is for a human to resolve.
  if (present(repo) || present(bare)) return note(`${repo} pair exists — left as-is`);
  git(`init -q --bare -b master ${bare}`);
  git(`clone -q ${bare} ${repo}`);
  ident(repo);
  writeFileSync(join(repo, 'a.txt'), 'base a\n');
  git(`-C ${repo} add a.txt`);
  git(`-C ${repo} commit -qm 'init a'`);
  writeFileSync(join(repo, 'b.txt'), 'base b\n');
  git(`-C ${repo} add b.txt`);
  git(`-C ${repo} commit -qm 'add b'`);
  appendFileSync(join(repo, 'a.txt'), 'one\n');
  git(`-C ${repo} commit -qam 'chore: history 1'`);
  appendFileSync(join(repo, 'b.txt'), 'two\n');
  git(`-C ${repo} commit -qam 'chore: history 2'`);
  appendFileSync(join(repo, 'a.txt'), 'three\n');
  git(`-C ${repo} commit -qam 'chore: history 3'`);
  git(`-C ${repo} push -qu origin master`);
  note(`built ${repo} + ${bare} (5 commits, pushed master)`);
}

// ~/ux-code-tree — the search/tree fixture (needle hits at known depths plus
// a node_modules hit the ignore handling must reason about).
export function ensureCodeTree() {
  const root = join(HOME, 'ux-code-tree');
  if (present(root)) return note(`${root} exists — left as-is`);
  mkdirSync(join(root, 'src/deep/deeper'), { recursive: true });
  mkdirSync(join(root, 'node_modules/forest'), { recursive: true });
  writeFileSync(join(root, 'src/alpha.txt'), 'needle alpha hit\n');
  writeFileSync(join(root, 'src/deep/beta.txt'), 'nothing on line one\nsecond needle hit\n');
  writeFileSync(join(root, 'src/deep/deeper/gamma.txt'), 'needle third\n');
  writeFileSync(join(root, 'needle_name.md'), 'nothing here\n');
  writeFileSync(join(root, 'node_modules/forest/needle.txt'), 'needle hidden\n');
  note(`built ${root} (needle tree)`);
}

export function ensureFixtures() {
  ensureGitTest();
  ensureGitOps();
  ensureCodeTree();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureFixtures();
}
