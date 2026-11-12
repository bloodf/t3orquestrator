import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGit, defaultExec } from '../lib/git.mjs';
import { integrate } from '../lib/integrate.mjs';

const git = createGit({ exec: defaultExec });

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function setup(t, unitFiles) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-int-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  const baseSha = sh(repo, 'rev-parse', 'HEAD');
  const units = [];
  for (const [id, files] of Object.entries(unitFiles)) {
    sh(repo, 'checkout', '-b', `unit-${id}`, 'main');
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(repo, name), body);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', id);
    units.push({ id, sha: sh(repo, 'rev-parse', 'HEAD') });
  }
  sh(repo, 'checkout', 'main');
  return { root, repo, baseSha, dir: path.join(root, 'integration'), units };
}

const go = (s, units = s.units, extra = {}) =>
  integrate({ repo: s.repo, dir: s.dir, branch: 'integration', baseSha: s.baseSha, units, git, ...extra });

test('merges two clean units in order', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' }, b: { 'b.txt': '2' } });
  const r = go(s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, ['a', 'b']);
  assert.equal(r.head, git.headSha(s.dir));
  assert.equal(git.currentBranch(s.dir), 'integration');
  await fs.stat(path.join(s.dir, 'a.txt'));
  await fs.stat(path.join(s.dir, 'b.txt'));
});

test('stops at the first conflict and leaves the worktree clean', async (t) => {
  const s = await setup(t, { a: { 'shared.txt': 'from a\n' }, b: { 'shared.txt': 'from b\n' }, c: { 'c.txt': '3' } });
  const r = go(s);
  assert.deepEqual(r, { ok: false, merged: ['a'], conflict: { unit: 'b', files: ['shared.txt'] } });
  assert.equal(git.isClean(s.dir).clean, true);
  await assert.rejects(fs.stat(path.join(s.dir, 'c.txt')));
});

test('re-running after a partial merge skips merged units', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' }, b: { 'b.txt': '2' } });
  const first = go(s, s.units.slice(0, 1));
  assert.deepEqual(first.merged, ['a']);
  const mergesBefore = Number(sh(s.dir, 'rev-list', '--merges', '--count', 'HEAD'));
  const second = go(s);
  assert.equal(second.ok, true);
  assert.deepEqual(second.merged, ['a', 'b']);
  assert.equal(sh(s.dir, 'rev-list', '--merges', '--count', 'HEAD'), String(mergesBefore + 1));
  assert.equal(go(s).head, second.head);
});

test('re-running after a full merge performs no merge at all', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' }, b: { 'b.txt': '2' } });
  const first = go(s);
  let merges = 0;
  const spy = { ...git, merge: (...args) => { merges += 1; return git.merge(...args); } };
  const again = go(s, s.units, { git: spy });
  assert.equal(merges, 0);
  assert.equal(again.head, first.head);
});

test('no units returns the base head', async (t) => {
  const s = await setup(t, {});
  assert.deepEqual(go(s, []), { ok: true, merged: [], head: s.baseSha });
});

test('a removed worktree directory keeps earlier merges and skips merged units', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' }, b: { 'b.txt': '2' } });
  const first = go(s, s.units.slice(0, 1));
  sh(s.repo, 'worktree', 'remove', s.dir);
  const second = go(s);
  assert.equal(second.ok, true);
  assert.deepEqual(second.merged, ['a', 'b']);
  assert.equal(sh(s.dir, 'rev-list', '--merges', '--count', 'HEAD'), '2');
  assert.ok(git.isAncestor(s.dir, first.head));
});

test('only the gated sha is merged, not later commits on the unit branch', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' } });
  sh(s.repo, 'checkout', 'unit-a');
  await fs.writeFile(path.join(s.repo, 'late.txt'), 'after the gate');
  sh(s.repo, 'add', '-A');
  sh(s.repo, 'commit', '-m', 'late');
  sh(s.repo, 'checkout', 'main');
  const r = go(s);
  assert.equal(r.ok, true);
  await fs.stat(path.join(s.dir, 'a.txt'));
  await assert.rejects(fs.stat(path.join(s.dir, 'late.txt')));
});

test('shas must be full 40-hex commit ids', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' } });
  assert.throws(() => go(s, s.units, { baseSha: 'main' }), /baseSha must be a full commit SHA/);
  assert.throws(() => go(s, [{ id: 'a', sha: 'unit-a' }]), /unit a sha must be a full commit SHA/);
});

test('an existing integration worktree on another branch is refused', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' } });
  go(s, []);
  sh(s.dir, 'checkout', '-b', 'other');
  assert.throws(() => go(s), /integration worktree is on other, expected integration/);
});

test('an existing integration worktree with uncommitted changes is refused', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' } });
  go(s, []);
  await fs.writeFile(path.join(s.dir, 'stray.txt'), 'x');
  assert.throws(() => go(s), /integration worktree has uncommitted changes/);
});

test('worker-planted hooks and fsmonitor never run during integrate', async (t) => {
  const s = await setup(t, { a: { 'a.txt': '1' }, b: { 'b.txt': '2' } });
  await fs.writeFile(path.join(s.repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${s.root}/hook-marker"\n`, { mode: 0o755 });
  const fsm = path.join(s.root, 'fsm.sh');
  await fs.writeFile(fsm, `#!/bin/sh\ntouch "${s.root}/fsmonitor-marker"\nexit 0\n`, { mode: 0o755 });
  sh(s.repo, 'config', 'core.fsmonitor', fsm);
  assert.equal(go(s).ok, true);
  await assert.rejects(fs.stat(path.join(s.root, 'hook-marker')));
  await assert.rejects(fs.stat(path.join(s.root, 'fsmonitor-marker')));
});
