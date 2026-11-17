import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanAll } from '../lib/cleanup.mjs';
import { sweepIfDue, SWEEP_MINUTES } from '../lib/sweep.mjs';
import { writeLease } from '../lib/leases.mjs';
import { readState } from '../lib/ledger.mjs';
import { run } from '../lib/cli.mjs';
import { makeProject, unitSpec, sh } from './support/project.mjs';

import {
  NOW, exists, fxOf, orqDir, plan, launch, merged, writeLedger, ledger, worktreeOn, hasBranch, listed,
} from './support/cleanup.mjs';

test('cleanup: a worktree dirty only with ignored build files goes without a patch; links are removed, never their target', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.appendFile(path.join(p.repo, '.git', 'info', 'exclude'), '/node_modules\ndist/\n');
  const dir = worktreeOn(p, 'a1', 'orq/p/a-a1');
  await fs.mkdir(path.join(dir, 'dist'));
  await fs.writeFile(path.join(dir, 'dist', 'out.js'), 'x'.repeat(50_000));
  const shared = path.join(p.root, 'shared-node_modules');
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'dep.js'), 'dep');
  await fs.symlink(shared, path.join(dir, 'node_modules'));
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a')]);
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.removed.map((w) => [w.path, w.patch]), [[dir, null]]);
  assert.ok(r.freed >= 50_000, `freed ${r.freed}`);
  assert.equal(await exists(dir), false);
  assert.equal(await exists(orqDir(p, 'salvage')), false);
  assert.equal(await fs.readFile(path.join(shared, 'dep.js'), 'utf8'), 'dep');
  assert.ok(hasBranch(p, 'orq/p/a-a1'));
});

test('cleanup: uncommitted tracked changes and untracked source are saved as a patch that applies, then the worktree goes', async (t) => {
  const p = await makeProject(t, [unitSpec('c')]);
  const dir = worktreeOn(p, 'c1', 'orq/p/c-a1');
  await fs.writeFile(path.join(dir, 'shared.txt'), 'changed\n');
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'new.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(dir, 'huge.bin'), Buffer.alloc(300 * 1024, 1)); // over the per-file cap: named, not saved
  await ledger(p, [launch('c', 'orq/p/c-a1'), ...merged('c')]);
  const r = await cleanAll(fxOf(p));
  assert.equal(r.removed.length, 1);
  const { patch } = r.removed[0];
  assert.equal(patch, path.join('.orq', 'salvage', `c-a1-${NOW}.patch`));
  assert.equal(await exists(dir), false);
  assert.ok(hasBranch(p, 'orq/p/c-a1'));
  const text = await fs.readFile(path.join(p.repo, patch), 'utf8');
  assert.match(text, /^# orq salvage of orq\/p\/c-a1/);
  assert.match(text, /not saved .*huge\.bin/);
  const check = path.join(p.root, 'check');
  sh(p.repo, 'worktree', 'add', '-q', check, 'orq/p/c-a1');
  sh(check, 'apply', path.join(p.repo, patch));
  assert.equal(await fs.readFile(path.join(check, 'shared.txt'), 'utf8'), 'changed\n');
  assert.equal(await fs.readFile(path.join(check, 'src', 'new.ts'), 'utf8'), 'export const x = 1;\n');
});

test('cleanup keeps: a leased thread, a running unit, an unknown launch of the running plan, a locked worktree, the integration worktree', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('d')]);
  const leased = worktreeOn(p, 'd1', 'orq/p/d-a1');
  const running = worktreeOn(p, 'b1', 'orq/p/b-a1');
  const unknown = worktreeOn(p, 'x1', 'orq/p/new-a1'); // T3 made it; the launch is not recorded yet
  const locked = worktreeOn(p, 'a1', 'orq/p/a-a1');
  sh(p.repo, 'worktree', 'lock', locked);
  const integration = orqDir(p, 'integration');
  sh(p.repo, 'worktree', 'add', '-q', '-b', 'orq/p/integration', integration, p.baseSha);
  await fs.writeFile(path.join(integration, 'wip.txt'), 'x\n');
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), launch('d', 'orq/p/d-a1'), ...merged('d')]);
  await writeLease(path.join(p.home, 'leases'), {
    threadId: 't-d-a1', project: p.repo, unit: 'd', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: 1, blocked: false, abandoned: true,
  });
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.removed, []);
  for (const d of [leased, running, unknown, locked, integration]) assert.equal(await exists(d), true, d);
});

test('cleanup removes worktrees of archived plans, finished reviews and decisions; keeps running ones and a plan no ledger names', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const archived = worktreeOn(p, 'old', 'orq/old/x-a1');
  const earlier = worktreeOn(p, 'p0', 'orq/p0/review-1'); // a plan this project has no record of: not this project's
  const reviewDone = worktreeOn(p, 'r1', 'orq/p/review-1');
  const reviewRunning = worktreeOn(p, 'r2', 'orq/p/review-2');
  const askDone = worktreeOn(p, 'k1', 'orq/ask-1-abc');
  const askRunning = worktreeOn(p, 'k2', 'orq/p/ask-2');
  await fs.writeFile(path.join(archived, 'leftover.txt'), 'kept work\n');
  await fs.mkdir(orqDir(p, 'archive', 'old'), { recursive: true });
  await writeLedger(orqDir(p, 'archive', 'old', 'ledger.jsonl'), [plan(p, 'old'), launch('x', 'orq/old/x-a1')]);
  await ledger(p, []);
  await fs.writeFile(orqDir(p, 'reviews.json'), JSON.stringify({ reviews: [{ n: 1, threadId: 'r1', status: 'done' }, { n: 2, threadId: 'r2', status: 'running' }] }));
  await fs.writeFile(orqDir(p, 'asks.json'), JSON.stringify({ asks: [{ n: 1, threadId: 'k1', status: 'answered', branch: 'orq/ask-1-abc' }, { n: 2, threadId: null, status: 'starting' }] }));
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.removed.map((w) => w.path).sort(), [archived, reviewDone, askDone].sort());
  assert.equal(r.removed.find((w) => w.path === archived).patch, path.join('.orq', 'salvage', `x-a1-${NOW}.patch`));
  for (const d of [reviewRunning, askRunning, earlier]) assert.equal(await exists(d), true, d);
});

test('cleanup: a dropped unit keeps its worktree until T3 shows its thread is not active; an active thread always keeps it', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const dropped = worktreeOn(p, 'a1', 'orq/p/a-a1');
  const busy = worktreeOn(p, 'b1', 'orq/p/b-a1');
  await ledger(p, [launch('a', 'orq/p/a-a1'), { type: 'dropped', unit: 'a', at: 3 }, launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const threads = [{ id: 't-a-a1', status: 'running' }, { id: 't-b-a1', status: 'running' }];
  assert.deepEqual((await cleanAll(fxOf(p), { threads })).removed, []);
  // T3 not asked: the dropped unit's thread may still run; the integrated one's is done
  assert.deepEqual((await cleanAll(fxOf(p))).removed.map((w) => w.path), [busy]);
  const r = await cleanAll(fxOf(p), { threads: [{ id: 't-a-a1', status: 'completed' }] });
  assert.deepEqual(r.removed.map((w) => w.path), [dropped]);
});

test('cleanup: changes over the salvage cap keep the worktree; a missing worktree path is pruned', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const big = worktreeOn(p, 'a1', 'orq/p/a-a1');
  await fs.writeFile(path.join(big, 'shared.txt'), `${'line of changed text\n'.repeat(200_000)}`);
  const missing = worktreeOn(p, 'b1', 'orq/p/b-a1');
  await fs.rm(missing, { recursive: true });
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const r = await cleanAll(fxOf(p));
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.kept.map((k) => k.path), [big]);
  assert.match(r.kept[0].why, /over the .* salvage cap/);
  assert.equal(await exists(big), true);
  assert.doesNotMatch(listed(p), /wt\/b1\n/);
  assert.equal(await exists(orqDir(p, 'salvage')), false);
});

test('cleanup: gate checkouts and leftovers go unless their gate is running', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const gate = (n) => orqDir(p, 'gate', n);
  sh(p.repo, 'worktree', 'add', '-q', '--detach', gate('a'), p.baseSha); // a registered checkout a killed gate left
  await fs.mkdir(`${gate('a')}.gate-999999-1`, { recursive: true }); // a gate beside it, made by a process that is gone
  await fs.mkdir(gate('b'), { recursive: true });
  await fs.mkdir(orqDir(p, 'units', 'b'), { recursive: true });
  await fs.writeFile(orqDir(p, 'units', 'b', 'gate-1.pid'), `${process.pid}\n`); // b's gate is running
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a')]);
  const r = await cleanAll(fxOf(p));
  assert.equal(r.gates.length, 2);
  assert.equal(await exists(gate('a')), false);
  assert.equal(await exists(`${gate('a')}.gate-999999-1`), false);
  assert.equal(await exists(gate('b')), true);
  assert.doesNotMatch(listed(p), /gate/);
});

test('sweepIfDue: runs on the first poll, then only when a unit ended, a head shipped, or the interval passed', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  await ledger(p, [launch('a', 'orq/p/a-a1')]);
  const swept = async (now) => (await sweepIfDue(fxOf(p, now), await readState(p.repo))) !== null;
  assert.equal(await swept(NOW), true);
  assert.equal(await swept(NOW + 60_000), false);
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a')]);
  assert.equal(await swept(NOW + 120_000), true); // integrated
  assert.equal(await swept(NOW + 180_000), false);
  assert.equal(await swept(NOW + 120_000 + SWEEP_MINUTES * 60_000), true);
});

// `orq worktree prune --force` and `orq wait`, run as the CLI
async function orq(p, args, deps = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: { exec: () => ({ code: 0, stdout: '[]', stderr: '' }), ...deps },
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('worktree prune --force: salvages, removes and reports the space freed; --dry-run removes nothing', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const clean = worktreeOn(p, 'a1', 'orq/p/a-a1');
  const dirty = worktreeOn(p, 'b1', 'orq/p/b-a1');
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const dry = await orq(p, ['worktree', 'prune', '--force', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(dry.out.trim().split('\n').sort(), [`would remove ${clean}`, `would remove ${dirty}`].sort());
  assert.equal(await exists(dirty), true);
  const r = await orq(p, ['worktree', 'prune', '--force']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^removed 2 worker worktrees, freed \d+(\.\d)? [KMG]?B$/);
  assert.deepEqual(lines.slice(1), [`saved uncommitted work of orq/p/b-a1 to .orq/salvage/b-a1-${NOW}.patch`]);
  for (const d of [clean, dirty]) assert.equal(await exists(d), false);
  assert.equal((await orq(p, ['worktree', 'prune', '--force'])).out, 'nothing to clean\n');
});

test('orq status counts the orq worktrees and the salvage patches; config set cleanup takes true or false', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  worktreeOn(p, 'a1', 'orq/p/a-a1');
  await fs.mkdir(orqDir(p, 'salvage'));
  await fs.writeFile(orqDir(p, 'salvage', 'a-a1-1.patch'), '# x\n');
  const s = await orq(p, ['status'], { readMachine: () => ({ cores: 8, availableMemBytes: 16 * 1024 ** 3, load1: 0 }) });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /\nworktrees: 1 on orq branches; 1 salvage patch in \.orq\/salvage\/ \(kept 30 days; past 7 days, at most 100\)\n/);
  assert.equal((await orq(p, ['config', 'set', 'cleanup', 'false'])).out, 'cleanup = false\n');
  assert.equal(JSON.parse(await fs.readFile(orqDir(p, 'config.json'), 'utf8')).cleanup, false);
  assert.notEqual((await orq(p, ['config', 'set', 'cleanup', 'maybe'])).code, 0);
});

test('cleanup review fixes: patch applies under diff.noprefix; a nested repository keeps the worktree; T3 at work on an unknown branch keeps it', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  sh(p.repo, 'config', 'diff.noprefix', 'true');
  const dir = worktreeOn(p, 'a1', 'orq/p/a-a1');
  await fs.writeFile(path.join(dir, 'shared.txt'), 'changed\n');
  await fs.writeFile(path.join(dir, 'big.log'), Buffer.alloc(300 * 1024, 1));
  const nested = worktreeOn(p, 'b1', 'orq/p/b-a1');
  sh(nested, 'init', '-q', 'inner');
  const foreign = worktreeOn(p, 'z1', 'orq/zz/z-a1'); // no plan knows it, but T3 shows a thread at work there
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a'), launch('b', 'orq/p/b-a1'), ...merged('b')]);
  const r = await cleanAll(fxOf(p), { threads: [{ id: 'tz', status: 'running', branch: 'orq/zz/z-a1', worktreePath: foreign }] });
  assert.deepEqual(r.removed.map((w) => [w.path, w.skipped]), [[dir, 1]]);
  assert.deepEqual(r.kept.map((k) => k.path), [nested]);
  assert.match(r.kept[0].why, /nested repository/);
  assert.equal(await exists(foreign), true);
  const check = path.join(p.root, 'check');
  sh(p.repo, 'worktree', 'add', '-q', check, 'orq/p/a-a1');
  sh(check, 'apply', path.join(p.repo, r.removed[0].patch));
  assert.equal(await fs.readFile(path.join(check, 'shared.txt'), 'utf8'), 'changed\n');
});

test('archive: when T3 cannot be read, the cleanup removes nothing by force', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await ledger(p, [launch('a', 'orq/p/a-a1'), ...merged('a')]);
  const dirty = worktreeOn(p, 'old', 'orq/p/a-a1');
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  const r = await orq(p, ['plan', 'archive'], {
    readMachine: () => ({ cores: 8, availableMemBytes: 16 * 1024 ** 3, load1: 0 }), exec: () => ({ code: 1, stdout: '', stderr: 't3 down' }),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /note: kept worktree .*old: /);
  assert.equal(await exists(path.join(dirty, 'notes.txt')), true);
});
