import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit, defaultExec } from '../lib/git.mjs';
import { spawnSync } from 'node:child_process';
import { removeUnitWorktrees, removeArgs } from '../lib/worktree-cleanup.mjs';
import { run } from '../lib/cli.mjs';
import { writeLease } from '../lib/leases.mjs';
import { makeProject, unitSpec, sh } from './support/project.mjs';

const git = createGit({ exec: defaultExec });
// the removal runs detached: wait for the directory to go
async function gone(dir) {
  for (let i = 0; i < 100; i += 1) {
    if (!(await fs.stat(dir).catch(() => null))) return;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.fail(`${dir} was not removed`);
}
const launched = (unit, branch) => ({ type: 'launched', unit, at: 1, attempt: 1, threadId: `t-${branch.split('/').at(-1)}`, branch });

test('an integrated unit: the worktrees of all its launches are removed, branches kept; dirty and foreign ones stay', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('a-a1')]);
  const wt = async (name, branch) => {
    const dir = path.join(p.root, 'wt', name);
    sh(p.repo, 'worktree', 'add', '-q', '-b', branch, dir, p.baseSha);
    return dir;
  };
  const first = await wt('a1', 'orq/p/a-a1'); // a launch whose provider failed
  const second = await wt('a1-l2', 'orq/p/a-a1-l2'); // the launch that passed
  const dirty = await wt('a2', 'orq/p/a-a2');
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  const other = await wt('other', 'orq/p/a-a1-a1'); // unit "a-a1": a name that only looks like a launch of "a"
  const running = await wt('a3', 'orq/p/a-a3'); // a thread orq gave up on that still holds its lease
  const events = [launched('a', 'orq/p/a-a1'), launched('a', 'orq/p/a-a1-l2'), launched('a', 'orq/p/a-a2'), launched('a', 'orq/p/a-a3'),
    launched('a-a1', 'orq/p/a-a1-a1')];
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await writeLease(path.join(p.home, 'leases'), {
    threadId: 't-a-a3', project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: 1, blocked: false, abandoned: true,
  });
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git }, 'a'), 3); // started; git itself refuses the dirty one
  await gone(first);
  await gone(second);
  await fs.stat(path.join(dirty, 'notes.txt'));
  await fs.stat(other);
  await fs.stat(running);
  for (const b of ['orq/p/a-a1', 'orq/p/a-a1-l2', 'orq/p/a-a2']) sh(p.repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);
});

test('worktree cleanup never throws: an unreadable ledger or a failing git removes nothing', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git }, 'a'), 0); // no ledger
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${JSON.stringify(launched('a', 'orq/p/a-a1'))}\n`);
  const broken = { listWorktrees: () => { throw new Error('git broke'); } };
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git: broken }, 'a'), 0);
});

// `orq worktree prune`, run as the CLI in a real repository
async function orq(p, ...args) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo,
  });
  return { code, out: out.join(''), err: err.join('') };
}
const worktreeOn = (p, name, branch) => {
  const dir = path.join(p.root, 'wt', name);
  sh(p.repo, 'worktree', 'add', '-q', '-b', branch, dir, p.baseSha);
  return dir;
};
const launch = (unit, branch, at) => ({
  type: 'launched', unit, at, attempt: 1, threadId: `t-${branch.split('/').at(-1)}`, branch, key: 'pa::m2', instance: 'pa', model: 'm2', tier: 2,
});
const ended = (unit, at, status = 'completed') => ({ type: 'thread-ended', unit, at, status });
const merged = (unit, at) => [
  { type: 'gated', unit, at, attempt: 1, verdict: 'pass', failures: [], headSha: 'h' }, { type: 'integrated', unit, at: at + 1, head: 'h' },
];
const writeLedger = (p, events) => fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'),
  `${[{ type: 'plan-started', unit: null, at: 1, planId: 'p', baseSha: p.baseSha, integrationBranch: 'orq/p/integration' }, ...events]
    .map((e) => JSON.stringify(e)).join('\n')}\n`);

test('worktree prune: what integrated units left is removed; open units, dirty and leased worktrees and every branch stay', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c'), unitSpec('d')]);
  const first = worktreeOn(p, 'a1', 'orq/p/a-a1'); // unit a: a launch whose provider failed, then the one that passed
  const second = worktreeOn(p, 'a1-l2', 'orq/p/a-a1-l2');
  const open = worktreeOn(p, 'b1', 'orq/p/b-a1'); // unit b is still running
  const dirty = worktreeOn(p, 'c1', 'orq/p/c-a1'); // unit c is integrated, with a file its worker never committed
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  const leased = worktreeOn(p, 'd1', 'orq/p/d-a1'); // unit d is integrated, but a thread still holds its lease
  await writeLedger(p, [
    launch('a', 'orq/p/a-a1', 2), ended('a', 3, 'failed'), launch('a', 'orq/p/a-a1-l2', 4), ended('a', 5), ...merged('a', 6),
    launch('b', 'orq/p/b-a1', 8),
    launch('c', 'orq/p/c-a1', 9), ended('c', 10), ...merged('c', 11),
    launch('d', 'orq/p/d-a1', 13), ended('d', 14), ...merged('d', 15),
  ]);
  await writeLease(path.join(p.home, 'leases'), {
    threadId: 't-d-a1', project: p.repo, unit: 'd', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: 1, blocked: false, abandoned: true,
  });

  const dry = await orq(p, 'worktree', 'prune', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(dry.out.trim().split('\n').sort(), [`would remove ${first}`, `would remove ${second}`, `would remove ${dirty}`].sort());
  await fs.stat(first); // a dry run removes nothing

  const r = await orq(p, 'worktree', 'prune');
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], 'removed 2 worktrees of integrated units');
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`^note: kept worktree ${dirty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .+`));
  for (const dir of [first, second]) await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  await fs.stat(path.join(dirty, 'notes.txt'));
  await fs.stat(open);
  await fs.stat(leased);
  for (const b of ['orq/p/a-a1', 'orq/p/a-a1-l2', 'orq/p/c-a1']) sh(p.repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);
});

test('worktree prune: nothing to do, bad usage, and a frozen project', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  assert.deepEqual(await orq(p, 'worktree', 'prune'), { code: 0, out: 'nothing to prune\n', err: '' }); // no ledger yet
  await writeLedger(p, [launch('a', 'orq/p/a-a1', 2)]);
  worktreeOn(p, 'a1', 'orq/p/a-a1');
  assert.equal((await orq(p, 'worktree', 'prune')).out, 'nothing to prune\n'); // a running unit keeps its worktree
  for (const args of [['worktree'], ['worktree', 'remove'], ['worktree', 'prune', 'x']]) {
    const r = await orq(p, ...args);
    assert.equal(r.code, 2);
    assert.match(r.err, /usage: worktree prune \[--dry-run\]/);
  }
  await fs.writeFile(path.join(p.repo, '.orq', 'archiving.json'), JSON.stringify({ planId: 'p' }));
  assert.equal((await orq(p, 'worktree', 'prune')).code, 4);
});

test('a worktree with an untracked file is kept even when the repository hides untracked files from git status', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  sh(p.repo, 'config', 'status.showUntrackedFiles', 'no'); // the user's setting, or one a worker wrote into the shared config
  const atMerge = worktreeOn(p, 'a1', 'orq/p/a-a1');
  const later = worktreeOn(p, 'b1', 'orq/p/b-a1');
  for (const dir of [atMerge, later]) await fs.writeFile(path.join(dir, 'notes.txt'), 'never committed\n');
  await writeLedger(p, [launch('a', 'orq/p/a-a1', 2), ended('a', 3), ...merged('a', 4), launch('b', 'orq/p/b-a1', 6), ended('b', 7), ...merged('b', 8)]);
  assert.notEqual(spawnSync('git', removeArgs(atMerge), { cwd: p.repo }).status, 0); // the command both removals run
  await fs.stat(path.join(atMerge, 'notes.txt'));
  const r = await orq(p, 'worktree', 'prune');
  assert.match(r.out, /^note: kept worktree .*\n^note: kept worktree /m);
  await fs.stat(path.join(later, 'notes.txt'));
});
