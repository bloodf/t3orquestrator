import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanAll } from '../lib/cleanup.mjs';
import { sweepIfDue } from '../lib/sweep.mjs';
import { removeGate } from '../lib/gate-leftovers.mjs';
import { readState } from '../lib/ledger.mjs';
import { run } from '../lib/cli.mjs';
import { makeProject, unitSpec, sh } from './support/project.mjs';
import {
  NOW, exists, fxOf, orqDir, plan, launch, merged, writeLedger, ledger, worktreeOn,
} from './support/cleanup.mjs';

async function orq(p, args, deps = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: {
      exec: () => ({ code: 0, stdout: '[]', stderr: '' }), readMachine: () => ({ cores: 8, availableMemBytes: 16 * 1024 ** 3, load1: 0 }), ...deps,
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('cleanup keeps orq/* worktrees no ledger of this project knows: a second orq project in a linked worktree, a hand-made one', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const second = path.join(p.root, 'second'); // another orq project: a linked worktree of the same repository
  sh(p.repo, 'worktree', 'add', '-q', '-b', 'second', second, p.baseSha);
  await fs.mkdir(path.join(second, '.orq'));
  await writeLedger(path.join(second, '.orq', 'ledger.jsonl'), [plan(p, 'q'), launch('x', 'orq/q/x-a1')]);
  const theirs = worktreeOn(p, 'q1', 'orq/q/x-a1');
  await fs.writeFile(path.join(theirs, 'live.txt'), 'their live work\n');
  const mine = worktreeOn(p, 'hand', 'orq/scratch'); // a person's own orq/* worktree
  await ledger(p, []);
  const r = await cleanAll(fxOf(p), { threads: [] });
  assert.deepEqual(r.removed, []);
  for (const d of [theirs, mine]) assert.equal(await exists(d), true, d);
});

test('cleanup keeps a known branch checked out somewhere other than where T3 says its thread works', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const dir = worktreeOn(p, 'a1', 'orq/p/a-a1');
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a')]);
  const elsewhere = [{ id: 't-a-a1', status: 'completed', worktreePath: path.join(p.root, 't3', 'a-a1') }];
  assert.deepEqual((await cleanAll(fxOf(p), { threads: elsewhere })).removed, []);
  const here = [{ id: 't-a-a1', status: 'completed', worktreePath: dir }];
  assert.deepEqual((await cleanAll(fxOf(p), { threads: here })).removed.map((w) => w.path), [dir]);
});

test('cleanup keeps a worktree whose submodule has changes; a rename in the worktree is saved as one', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const withSub = worktreeOn(p, 'a1', 'orq/p/a-a1');
  sh(withSub, 'init', '-q', 'sub');
  await fs.writeFile(path.join(withSub, 'sub', 'f.txt'), 'one\n');
  sh(path.join(withSub, 'sub'), 'add', '-A');
  sh(path.join(withSub, 'sub'), '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'sub');
  sh(withSub, 'add', 'sub'); // a gitlink: the commit inside lives nowhere else
  const renamed = worktreeOn(p, 'b1', 'orq/p/b-a1');
  await fs.rename(path.join(renamed, 'shared.txt'), path.join(renamed, 'moved.txt'));
  sh(renamed, 'add', '-N', 'moved.txt');
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.kept.map((k) => [k.path, /submodule/.test(k.why)]), [[withSub, true]]);
  assert.deepEqual(r.removed.map((w) => w.path), [renamed]);
  const check = path.join(p.root, 'check');
  sh(p.repo, 'worktree', 'add', '-q', check, 'orq/p/b-a1');
  sh(check, 'apply', path.join(p.repo, r.removed[0].patch));
  assert.equal(await fs.readFile(path.join(check, 'moved.txt'), 'utf8'), 'base\n');
});

test('a sweep stops at its time budget and the next poll goes on with the rest', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')]);
  for (const u of ['a', 'b', 'c']) worktreeOn(p, `${u}1`, `orq/p/${u}-a1`);
  await ledger(p, ['a', 'b', 'c'].flatMap((u) => [launch(u, `orq/p/${u}-a1`), ...merged(u)]));
  let ms = 0;
  const clock = () => { ms += 40_000; return ms; }; // every removal looks like 40 s
  const r = await cleanAll(fxOf(p), { budgetMs: 60_000, clock });
  assert.equal(r.removed.length, 1);
  assert.equal(r.left, 2);
  const state = await readState(p.repo);
  const first = await sweepIfDue({ ...fxOf(p), clock }, state);
  assert.deepEqual([first.removed.length, first.left], [1, 1]);
  const next = await sweepIfDue(fxOf(p, NOW + 1000), state); // a second later, nothing new ended: still due for the rest
  assert.deepEqual([next.removed.length, next.left], [1, 0]);
  assert.equal(await sweepIfDue(fxOf(p, NOW + 2000), state), null);
});

test('a gate checkout is checked again right before it goes: one whose gate started meanwhile stays', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const dir = orqDir(p, 'gate', 'a');
  await fs.mkdir(dir, { recursive: true });
  await ledger(p, [launch('a', 'orq/p/a-a1'), { type: 'thread-ended', unit: 'a', at: 3, status: 'completed' }]);
  assert.equal((await removeGate(p.repo, dir)).error, 'its gate is running');
  assert.equal(await exists(dir), true);
});

test('prune --force with T3 unreadable removes only clean worktrees; --dry-run reports what the run would keep', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const dirty = worktreeOn(p, 'a1', 'orq/p/a-a1');
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  const nested = worktreeOn(p, 'b1', 'orq/p/b-a1');
  sh(nested, 'init', '-q', 'inner');
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const dry = await orq(p, ['worktree', 'prune', '--force', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, new RegExp(`^would remove ${dirty}$`, 'm'));
  assert.match(dry.out, new RegExp(`^would keep ${nested}: .*nested repository`, 'm'));
  const down = await orq(p, ['worktree', 'prune', '--force'], { exec: () => ({ code: 1, stdout: '', stderr: 't3 down' }) });
  assert.equal(down.code, 0, down.err);
  assert.equal(await exists(path.join(dirty, 'notes.txt')), true);
  assert.equal(await exists(orqDir(p, 'salvage')), false);
});

test('salvage keeps at most 30 days and 100 patches; status names the limit; a broken archive is skipped with a note', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const dir = orqDir(p, 'salvage');
  await fs.mkdir(dir);
  for (let i = 0; i < 102; i += 1) {
    const f = path.join(dir, `u-a1-${NOW - i}.patch`);
    await fs.writeFile(f, '# x\n');
    await fs.utimes(f, (NOW - i * 1000) / 1000, (NOW - i * 1000) / 1000);
  }
  const old = path.join(dir, 'old-a1-1.patch');
  await fs.writeFile(old, '# x\n');
  const month = (NOW - 31 * 86_400_000) / 1000;
  await fs.utimes(old, month, month);
  await fs.mkdir(orqDir(p, 'archive', 'bad'), { recursive: true });
  await fs.writeFile(orqDir(p, 'archive', 'bad', 'ledger.jsonl'), '{not json\n');
  await ledger(p, []);
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.notes, ['note: skipped archive bad: its files cannot be read']);
  const left = await fs.readdir(dir);
  assert.equal(left.length, 100);
  assert.equal(left.includes('old-a1-1.patch'), false);
  assert.equal(left.includes(`u-a1-${NOW}.patch`), true);
  const s = await orq(p, ['status']);
  assert.match(s.out, /\nworktrees: 0 on orq branches; 100 salvage patches in \.orq\/salvage\/ \(kept 30 days, at most 100\)\n/);
});
