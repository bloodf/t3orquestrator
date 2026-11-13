import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGit, defaultExec } from '../lib/git.mjs';

const git = createGit({ exec: defaultExec });

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-git-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repo, 'README.md'), 'hello\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  return { root, repo };
}

async function commit(cwd, files, msg = 'change') {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await fs.writeFile(path.join(cwd, name), body);
  }
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-m', msg);
}

test('defaultExec returns code, stdout and stderr', () => {
  const r = defaultExec('git', ['--version'], { cwd: os.tmpdir(), timeoutMs: 10000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^git version/);
  assert.equal(typeof r.stderr, 'string');
});

test('isClean reports clean and dirty trees', async (t) => {
  const { repo } = await makeRepo(t);
  assert.deepEqual(git.isClean(repo), { clean: true, files: [] });
  await fs.writeFile(path.join(repo, 'new.txt'), 'x');
  await fs.appendFile(path.join(repo, 'README.md'), 'more\n');
  const r = git.isClean(repo);
  assert.equal(r.clean, false);
  assert.deepEqual([...r.files].sort(), ['README.md', 'new.txt']);
});

test('commitsAhead counts commits since base', async (t) => {
  const { repo } = await makeRepo(t);
  sh(repo, 'checkout', '-b', 'feat');
  assert.equal(git.commitsAhead(repo, 'main'), 0);
  await commit(repo, { 'a.txt': '1' });
  await commit(repo, { 'b.txt': '2' });
  assert.equal(git.commitsAhead(repo, 'main'), 2);
});

test('changedFiles reports add, modify, delete and rename (old path as deleted)', async (t) => {
  const { repo } = await makeRepo(t);
  await commit(repo, { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'old.txt': 'same content here\nline two\nline three\n' });
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'added.txt': 'a\n', 'keep.txt': 'k2\n' });
  sh(repo, 'rm', 'gone.txt');
  sh(repo, 'mv', 'old.txt', 'new.txt');
  sh(repo, 'commit', '-m', 'rm and mv');
  const files = git.changedFiles(repo, 'main');
  const key = (f) => `${f.status} ${f.path}`;
  assert.deepEqual(files.map(key).sort(), ['A added.txt', 'D gone.txt', 'D old.txt', 'M keep.txt', 'R new.txt']);
});

test('addedLines lists added lines per file and skips headers', async (t) => {
  const { repo } = await makeRepo(t);
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'a.txt': 'one\n++ two\n', 'dir/b.txt': 'three\n' });
  await commit(repo, { 'README.md': 'hello\nextra\n' });
  const lines = git.addedLines(repo, 'main');
  assert.deepEqual(lines.map((l) => `${l.path}:${l.line}`).sort(), [
    'README.md:extra', 'a.txt:++ two', 'a.txt:one', 'dir/b.txt:three',
  ]);
});

test('ensureWorktree creates once and is idempotent', async (t) => {
  const { root, repo } = await makeRepo(t);
  const dir = path.join(root, 'wt');
  git.ensureWorktree(repo, dir, 'unit-a', 'main');
  assert.equal(git.currentBranch(dir), 'unit-a');
  await commit(dir, { 'a.txt': '1' });
  const head = git.headSha(dir);
  git.ensureWorktree(repo, dir, 'unit-a', 'main');
  assert.equal(git.headSha(dir), head);
});

test('ensureWorktree reuses an existing branch without resetting it', async (t) => {
  const { root, repo } = await makeRepo(t);
  sh(repo, 'branch', 'unit-a', 'main');
  const first = path.join(root, 'wt1');
  git.ensureWorktree(repo, first, 'unit-a', 'main');
  await commit(first, { 'a.txt': '1' });
  const head = git.headSha(first);
  sh(repo, 'worktree', 'remove', first);
  const second = path.join(root, 'wt2');
  git.ensureWorktree(repo, second, 'unit-a', 'main');
  assert.equal(git.headSha(second), head);
});

test('ensureWorktree refuses a directory that exists but is not a worktree', async (t) => {
  const { root, repo } = await makeRepo(t);
  const dir = path.join(root, 'plain');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'x');
  assert.throws(() => git.ensureWorktree(repo, dir, 'unit-a', 'main'), /not a registered worktree/);
  await fs.stat(path.join(dir, 'keep.txt'));
});

test('currentBranch, headSha and isAncestor', async (t) => {
  const { repo } = await makeRepo(t);
  assert.equal(git.currentBranch(repo), 'main');
  assert.match(git.headSha(repo), /^[0-9a-f]{40}$/);
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'a.txt': '1' });
  sh(repo, 'checkout', 'main');
  assert.equal(git.isAncestor(repo, 'main'), true);
  assert.equal(git.isAncestor(repo, 'feat'), false);
  sh(repo, 'merge', '--ff-only', 'feat');
  assert.equal(git.isAncestor(repo, 'feat'), true);
  assert.throws(() => git.isAncestor(repo, 'no-such-ref'), /merge-base/);
});

test('merge succeeds with a merge commit', async (t) => {
  const { repo } = await makeRepo(t);
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'a.txt': '1' });
  sh(repo, 'checkout', 'main');
  assert.deepEqual(git.merge(repo, 'feat'), { ok: true });
  assert.equal(sh(repo, 'rev-list', '--merges', '--count', 'HEAD'), '1');
});

test('merge reports conflicts, aborts and leaves the tree clean', async (t) => {
  const { repo } = await makeRepo(t);
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'README.md': 'from feat\n' });
  sh(repo, 'checkout', 'main');
  await commit(repo, { 'README.md': 'from main\n' });
  const before = git.headSha(repo);
  assert.deepEqual(git.merge(repo, 'feat'), { ok: false, conflicts: ['README.md'] });
  assert.equal(git.isClean(repo).clean, true);
  assert.equal(git.headSha(repo), before);
});

test('merge of an unknown branch throws', async (t) => {
  const { repo } = await makeRepo(t);
  assert.throws(() => git.merge(repo, 'nope'), /git merge/);
});

test('unexpected failures name the subcommand', () => {
  const failing = createGit({ exec: () => ({ code: 128, stdout: '', stderr: 'fatal: bad\nmore' }) });
  assert.throws(() => failing.commitsAhead('/x', 'main'), /git rev-list.*128.*more$/);
  assert.throws(() => failing.isClean('/x'), /git status/);
  assert.throws(() => failing.headSha('/x'), /git rev-parse/);
});

test('resolveSha resolves refs to full commit shas and rejects junk', async (t) => {
  const { repo } = await makeRepo(t);
  sh(repo, 'tag', 'v1');
  const head = git.headSha(repo);
  assert.equal(git.resolveSha(repo, 'v1'), head);
  assert.equal(git.resolveSha(repo, 'main'), head);
  assert.equal(git.resolveSha(repo, head), head);
  assert.throws(() => git.resolveSha(repo, 'no-such-ref'), /git rev-parse/);
  assert.throws(() => git.resolveSha(repo, '--output=x'), /git rev-parse/);
});

test('diff helpers use the given shas, not the checked-out HEAD', async (t) => {
  const { repo } = await makeRepo(t);
  const base = git.headSha(repo);
  sh(repo, 'checkout', '-b', 'feat');
  await commit(repo, { 'a.txt': 'one\n' });
  const head = git.headSha(repo);
  sh(repo, 'checkout', 'main');
  assert.equal(git.commitsAhead(repo, base, head), 1);
  assert.equal(git.commitsAhead(repo, head, base), 0);
  assert.deepEqual(git.changedFiles(repo, base, head), [{ status: 'A', path: 'a.txt' }]);
  assert.deepEqual(git.addedLines(repo, base, head), [{ path: 'a.txt', line: 'one' }]);
  assert.deepEqual(git.changedFiles(repo, base, base), []);
});

test('removedLines lists removed lines, including from deleted files', async (t) => {
  const { repo } = await makeRepo(t);
  await commit(repo, { 'a.txt': 'keep\ndrop\n', 'gone.txt': 'x\ny\n' });
  const base = git.headSha(repo);
  await commit(repo, { 'a.txt': 'keep\n' });
  sh(repo, 'rm', 'gone.txt');
  sh(repo, 'commit', '-m', 'rm');
  const lines = git.removedLines(repo, base, git.headSha(repo));
  assert.deepEqual(lines.map((l) => `${l.path}:${l.line}`).sort(), ['a.txt:drop', 'gone.txt:x', 'gone.txt:y']);
});

test('names with spaces and non-ASCII characters are exact', async (t) => {
  const { repo } = await makeRepo(t);
  const base = git.headSha(repo);
  await commit(repo, { 'a b.txt': 'sp\n', 'caf\u00e9/\u00fcber.txt': 'u\n' });
  const head = git.headSha(repo);
  const names = git.changedFiles(repo, base, head).map((f) => f.path).sort();
  assert.deepEqual(names, ['a b.txt', 'caf\u00e9/\u00fcber.txt']);
  const added = git.addedLines(repo, base, head).map((l) => l.path).sort();
  assert.deepEqual(added, ['a b.txt', 'caf\u00e9/\u00fcber.txt']);
});

test('addDetachedWorktree checks out the sha and removeWorktree deletes it even when dirty', async (t) => {
  const { root, repo } = await makeRepo(t);
  const head = git.headSha(repo);
  const dir = path.join(root, 'detached');
  git.addDetachedWorktree(repo, dir, head);
  assert.equal(git.headSha(dir), head);
  assert.equal(git.currentBranch(dir), 'HEAD');
  await fs.writeFile(path.join(dir, 'junk.txt'), 'x');
  git.removeWorktree(repo, dir);
  await assert.rejects(fs.stat(dir));
});

test('a rename is reported with the new path and the old path as deleted (names with spaces)', async (t) => {
  const { repo } = await makeRepo(t);
  await commit(repo, { 'old name.txt': 'same content here\nline two\nline three\n' });
  const base = git.headSha(repo);
  sh(repo, 'mv', 'old name.txt', 'new name.txt');
  sh(repo, 'commit', '-m', 'mv');
  const f = git.changedFiles(repo, base, git.headSha(repo)).map((x) => `${x.status} ${x.path}`).sort();
  assert.deepEqual(f, ['D old name.txt', 'R new name.txt']);
});

test('listWorktrees parses porcelain output, including a detached worktree', async (t) => {
  const { root, repo } = await makeRepo(t);
  sh(repo, 'worktree', 'add', '-q', '-b', 'orq/p/u-a1', path.join(root, 'b'));
  sh(repo, 'worktree', 'add', '-q', '--detach', path.join(root, 'd'));
  assert.deepEqual(git.listWorktrees(repo), [
    { path: repo, branch: 'refs/heads/main' },
    { path: path.join(root, 'b'), branch: 'refs/heads/orq/p/u-a1' },
    { path: path.join(root, 'd'), branch: null },
  ]);
});
