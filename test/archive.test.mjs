import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { archivePlan } from '../lib/archive.mjs';
import { commit, readState } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import {
  makeProject, unitSpec, commitOn, sh,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const GIB = 1024 ** 3;
const ctxFor = (p, out = [], err = []) => ({
  stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW,
  deps: {
    readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
    exec: (_bin, args) => ({ code: 0, stdout: args[1] === 'list' ? '[]' : '{}', stderr: '' }), // never a real t3
  },
});

async function orq(args, p) {
  const out = [];
  const err = [];
  const code = await run(args, ctxFor(p, out, err));
  return { code, out: out.join(''), err: err.join('') };
}

const exists = (f) => fs.stat(f).then(() => true, () => false);
const orqPath = (p, ...f) => path.join(p.repo, '.orq', ...f);
const append = (p, ...events) => commit(p.repo, () => events.map((e) => ({ at: NOW, ...e })));
const launched = (p, unit, threadId) => ({
  type: 'launched', unit, attempt: 1, threadId, key: 'pa::m2', instance: 'pa', model: 'm2', branch: `orq/p1/${unit}-a1`, baseSha: p.baseSha, tier: 2, family: 'f',
});

// A finished plan: a integrated through a real integration worktree, b failed, c queued.
async function finished(t) {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')]);
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' });
  sh(p.repo, 'branch', 'orq/p1/a-a1', p.baseSha);
  const sha = await commitOn(p.repo, 'orq/p1/a-a1', { 'a.txt': 'A\n' });
  sh(p.repo, 'worktree', 'add', '-q', '-b', 'orq/p1/integration', orqPath(p, 'integration'), p.baseSha);
  sh(orqPath(p, 'integration'), '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-ff', '--no-edit', sha);
  const head = sh(orqPath(p, 'integration'), 'rev-parse', 'HEAD');
  await append(p, launched(p, 'a', 'th1'), { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: sha },
    { type: 'integrated', unit: 'a', sha, head }, { type: 'needs-judgment', unit: 'b', reason: '3 provider failures' });
  await fs.mkdir(orqPath(p, 'units', 'a'), { recursive: true });
  await fs.writeFile(orqPath(p, 'units', 'a', 'gate-1.json'), JSON.stringify({ verdict: 'pass', failures: [], flags: [], steps: [], headSha: sha }));
  await fs.writeFile(orqPath(p, 'reviews.json'), JSON.stringify({ reviews: [{ n: 1, key: 'pb::m4', status: 'done' }] }));
  await fs.writeFile(orqPath(p, 'summary.md'), '# Goal\n');
  await fs.writeFile(orqPath(p, 'memory.md'), 'keep me\n');
  await fs.writeFile(orqPath(p, 'capabilities.json'), '{}');
  await fs.mkdir(orqPath(p, 'gate', 'a'), { recursive: true });
  return { p, head };
}

test('archive with a standing goal adds the goal: and next: lines; without one the output is unchanged', async (t) => {
  const { p } = await finished(t);
  const file = orqPath(p, 'config.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), goal: 'ship it' }));
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').slice(-3).join('\n'),
    'goal: ship it\nnext: the goal is still open: plan its next part now and call "orq wait"; run "orq config set goal null" only when nothing of it is left to build\n');
  assert.equal(r.out.split('\n').length, 6);
});

test('archive moves the plan state, keeps config and the branch, removes the worktree', async (t) => {
  const { p } = await finished(t);
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    'archived: plan p1 (1 integrated, 2 not) -> .orq/archive/p1/',
    'integration branch kept: orq/p1/integration',
    'note: 2 units were not integrated: b, c',
    '',
  ].join('\n'));
  for (const f of ['plan.json', 'ledger.jsonl', 'units', 'orders', 'reviews.json', 'summary.md', 'integration', 'gate']) {
    assert.equal(await exists(orqPath(p, f)), false, f);
  }
  for (const f of ['plan.json', 'ledger.jsonl', 'units/a/gate-1.json', 'orders/a.md', 'reviews.json', 'summary.md', 'archive.json']) {
    assert.equal(await exists(orqPath(p, 'archive', 'p1', f)), true, f);
  }
  for (const f of ['config.json', 'memory.md', 'capabilities.json']) assert.equal(await exists(orqPath(p, f)), true, f);
  sh(p.repo, 'rev-parse', '--verify', 'refs/heads/orq/p1/integration');
  assert.doesNotMatch(sh(p.repo, 'worktree', 'list'), /integration/);
  assert.equal((await readState(p.repo)).plan.planId, null);
  assert.deepEqual(await orq(['plan', 'archive'], p), { code: 4, out: '', err: 'orq: plan: nothing to archive\n' });
});

test('archive refuses while anything is in flight, naming the first blocker', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' },
    launched(p, 'a', 'th1'));
  const busy = await orq(['plan', 'archive'], p);
  assert.deepEqual([busy.code, busy.err], [4, 'orq: plan: cannot archive: unit a is running\n']);
  await append(p, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: p.baseSha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: p.baseSha });
  assert.equal((await orq(['plan', 'archive'], p)).err, 'orq: plan: cannot archive: unit a is passed\n');
  await append(p, { type: 'integrated', unit: 'a', sha: p.baseSha, head: p.baseSha });
  await fs.writeFile(orqPath(p, 'reviews.json'), JSON.stringify({ reviews: [{ n: 2, status: 'running' }] }));
  assert.equal((await orq(['plan', 'archive'], p)).err, 'orq: plan: cannot archive: review 2 is running\n');
  await fs.writeFile(orqPath(p, 'reviews.json'), JSON.stringify({ reviews: [{ n: 2, status: 'done' }] }));
  await append(p, { type: 'gate-started', unit: 'integration', attempt: 1, headSha: p.baseSha, pid: process.pid });
  await fs.mkdir(orqPath(p, 'units', 'integration'), { recursive: true });
  await fs.writeFile(orqPath(p, 'units', 'integration', 'gate-1.pid'), `${process.pid}\n`);
  assert.equal((await orq(['plan', 'archive'], p)).err, 'orq: plan: cannot archive: the final gate is running\n');
  await fs.rm(orqPath(p, 'units', 'integration', 'gate-1.pid'));
  await fs.writeFile(orqPath(p, 'runner.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
  const waiting = await orq(['plan', 'archive'], p);
  assert.deepEqual([waiting.code, waiting.err], [4, `orq: plan: cannot archive: orq wait is running (pid ${process.pid})\n`]);
  await fs.rm(orqPath(p, 'runner.lock'));
  assert.equal(await exists(orqPath(p, 'ledger.jsonl')), true);
});

test('archive refuses an integration worktree with uncommitted changes', async (t) => {
  const { p } = await finished(t);
  await fs.writeFile(orqPath(p, 'integration', 'stray.txt'), 'x\n');
  const r = await orq(['plan', 'archive'], p);
  assert.deepEqual([r.code, r.err], [4, 'orq: plan: cannot archive: the integration worktree has uncommitted changes (stray.txt)\n']);
  assert.equal(await exists(orqPath(p, 'ledger.jsonl')), true);
});

test('archive removes leftover leases of this project with a note', async (t) => {
  const { p } = await finished(t);
  const dir = path.join(p.home, 'leases');
  const lease = (threadId, project) => ({ threadId, project, unit: 'a', instance: 'pa', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false });
  await writeLease(dir, lease('mine', p.repo));
  await writeLease(dir, lease('theirs', '/other'));
  const r = await orq(['plan', 'archive'], p);
  assert.match(r.out, /\nnote: removed 1 lease left by the archived plan\n$/);
  assert.deepEqual((await listLeases(dir)).map((l) => l.threadId), ['theirs']);
});

const FROZEN = 'an archive of plan p1 was interrupted; run "orq plan archive" to finish it (or delete .orq/archiving.json to unfreeze without archiving)';
const wayOut = (name) => 'The project is frozen until this finishes. Fix the cause and run "orq plan archive" again. To unfreeze without archiving, '
  + `delete .orq/archiving.json: whatever plan state is still under .orq/ stays in use, and a partial copy may remain under .orq/archive/${name}/.`;
const STEPS = ['marker written', 'copied', 'renamed', 'removed plan.json', 'removed ledger.jsonl', 'before marker removal'];

for (const step of STEPS) {
  test(`a crash at "${step}" freezes the project until archive is run again, and loses nothing`, async (t) => {
    const { p } = await finished(t);
    const ledger = await fs.readFile(orqPath(p, 'ledger.jsonl'));
    await assert.rejects(archivePlan(ctxFor(p), { onStep: async (at) => { if (at === step) throw new Error(`crash at ${at}`); } }), /crash at/);
    assert.equal(await exists(orqPath(p, 'archiving.json')), true);
    for (const args of [['wait'], ['status'], ['unit', 'retry', 'b'], ['unit', 'drop', 'c'], ['review', 'start'], ['review', 'show'],
      ['summary'], ['plan', 'check'], ['route', '--job', 'review'], ['gate-run', 'a', '1', 'a'.repeat(40)]]) {
      assert.deepEqual(await orq(args, p), { code: 4, out: '', err: `orq: ${FROZEN}\n` }, args.join(' '));
    }
    const r = await orq(['plan', 'archive'], p);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^archived: plan p1 \(1 integrated, 2 not\) -> \.orq\/archive\/p1\/\n/);
    assert.deepEqual(await fs.readFile(orqPath(p, 'archive', 'p1', 'ledger.jsonl')), ledger);
    for (const f of ['plan.json', 'units/a/gate-1.json', 'orders/a.md', 'reviews.json', 'summary.md']) {
      assert.equal(await exists(orqPath(p, 'archive', 'p1', f)), true, f);
    }
    for (const f of ['ledger.jsonl', 'plan.json', 'archiving.json']) assert.equal(await exists(orqPath(p, f)), false, f);
    assert.deepEqual((await fs.readdir(orqPath(p, 'archive'))).sort(), ['p1']);
    assert.equal((await orq(['status'], p)).code, 0);
  });
}

test('a re-run refuses when the live ledger no longer matches the archived copy, deleting nothing', async (t) => {
  const { p } = await finished(t);
  await assert.rejects(archivePlan(ctxFor(p), { onStep: async (at) => { if (at === 'renamed') throw new Error('crash'); } }));
  await fs.appendFile(orqPath(p, 'ledger.jsonl'), `${JSON.stringify({ type: 'dropped', unit: 'c', at: NOW })}\n`);
  const r = await orq(['plan', 'archive'], p);
  assert.deepEqual([r.code, r.err], [4, 'orq: plan: cannot archive: archive mismatch for p1: .orq/ledger.jsonl differs from '
    + `.orq/archive/p1/ledger.jsonl; nothing deleted. ${wayOut('p1')}\n`]);
  for (const f of ['ledger.jsonl', 'plan.json', 'units', 'archiving.json']) assert.equal(await exists(orqPath(p, f)), true, f);
});

test('an archive name already taken gets a -2 suffix', async (t) => {
  const { p } = await finished(t);
  await fs.mkdir(orqPath(p, 'archive', 'p1'), { recursive: true });
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^archived: plan p1 \(1 integrated, 2 not\) -> \.orq\/archive\/p1-2\/\n/);
  assert.equal(await exists(orqPath(p, 'archive', 'p1-2', 'ledger.jsonl')), true);
});

test('an interrupted unstarted archive keeps its name on the re-run', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await assert.rejects(archivePlan(ctxFor(p), { onStep: async (at) => { if (at === 'copied') throw new Error('crash'); } }));
  const later = { ...ctxFor(p), now: () => NOW + 5000 };
  await archivePlan(later);
  assert.deepEqual(await fs.readdir(orqPath(p, 'archive')), [`unstarted-${NOW.toString(36)}`]);
});

test('a planId read from the ledger is validated before it names a path', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.writeFile(orqPath(p, 'ledger.jsonl'), `${JSON.stringify({ type: 'plan-started', unit: null, at: 1, planId: '../x', baseSha: p.baseSha, integrationBranch: 'b' })}\n`);
  const r = await orq(['plan', 'archive'], p);
  assert.deepEqual([r.code, r.err], [4, 'orq: plan: cannot archive: invalid planId "../x" in the ledger\n']);
});

test('a plan that never started archives as unstarted-<time>', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  const name = `unstarted-${NOW.toString(36)}`;
  assert.equal(r.out, `archived: plan ${name} (0 integrated, 1 not) -> .orq/archive/${name}/\nnote: 1 units were not integrated: a\n`);
  assert.equal(await exists(orqPath(p, 'archive', name, 'plan.json')), true);
  assert.equal(await exists(orqPath(p, 'plan.json')), false);
});

test('status with no plan, archives listed; summary of an archived plan', async (t) => {
  const { p } = await finished(t);
  await orq(['plan', 'archive'], p);
  const s = await orq(['status'], p);
  assert.equal(s.code, 0, s.err);
  const lines = s.out.split('\n');
  assert.equal(lines[0], 'plan: none');
  assert.match(lines[1], /^cap=2 active=0 blocked=0 gates=0 machine_leases=0$/);
  assert.equal(lines[2], 'archives: 1 (latest p1)');
  assert.deepEqual(JSON.parse((await orq(['status', '--json'], p)).out).archives, { count: 1, latest: 'p1' });
  const sum = await orq(['summary', '--plan', 'p1'], p);
  assert.equal(sum.code, 0, sum.err);
  assert.match(sum.out, /^## Goal\n\ntest goal\n/);
  assert.match(sum.out, /\| a \| do a \|/);
  assert.match(sum.out, /review 1: pb::m4 — done/);
  assert.equal((await orq(['summary', '--plan', 'nope'], p)).err, 'orq: summary: no archived plan nope\n');
  assert.equal((await orq(['summary', '--plan', '../x'], p)).code, 2);
});

test('an archive that fails after the marker says the way out; deleting the marker unfreezes the intact state', async (t) => {
  const { p } = await finished(t);
  const ledger = await fs.readFile(orqPath(p, 'ledger.jsonl'));
  const disk = async (at) => { if (at === 'copied') throw new Error('copy failed\nENOSPC: no space left on device'); };
  await assert.rejects(archivePlan(ctxFor(p), { onStep: disk }), (e) => e.message === `ENOSPC: no space left on device. ${wayOut('p1')}`);
  assert.equal(await exists(orqPath(p, 'archiving.json')), true);
  assert.deepEqual(await fs.readFile(orqPath(p, 'ledger.jsonl')), ledger);
  assert.equal(await exists(orqPath(p, 'plan.json')), true);
  assert.equal((await orq(['status'], p)).code, 4);
  await fs.rm(orqPath(p, 'archiving.json'));
  const s = await orq(['status'], p);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /^plan: test goal \(p1\)\n/);
});

// Worker worktrees: T3 Code creates them outside the repo on orq/<plan>/<unit>-a<n> branches.
const addWorker = (p, name, branch) => {
  const dir = path.join(p.root, name);
  sh(p.repo, 'worktree', 'add', '-q', '-b', branch, dir, p.baseSha);
  return dir;
};
const branches = (p) => sh(p.repo, 'branch', '--format=%(refname:short)').split('\n');

test('archive removes a clean worker worktree and keeps its branch', async (t) => {
  const { p } = await finished(t);
  const dir = addWorker(p, 'w1', 'orq/p1/a-a1-w');
  const before = branches(p);
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\nremoved 1 worker worktrees\n/);
  assert.equal(await exists(dir), false);
  assert.deepEqual(branches(p), before);
});

test('archive keeps a worker worktree with an untracked file and says so, exit 0', async (t) => {
  const { p } = await finished(t);
  const dir = addWorker(p, 'w1', 'orq/p1/a-a1-w');
  await fs.writeFile(path.join(dir, 'stray.txt'), 'x\n');
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`\\nnote: kept worktree ${dir}: .*(untracked|modified)`));
  assert.doesNotMatch(r.out, /removed \d+ worker/);
  assert.equal(await exists(dir), true);
  assert.ok(branches(p).includes('orq/p1/a-a1-w'));
});

test('archive leaves worktrees on non-orq branches alone', async (t) => {
  const { p } = await finished(t);
  const dir = addWorker(p, 'w1', 'feature/x');
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /worker worktrees|kept worktree/);
  assert.equal(await exists(dir), true);
});

test('archive also removes clean leftovers from an earlier plan', async (t) => {
  const { p } = await finished(t);
  const dir = addWorker(p, 'old', 'orq/p0/review-1');
  const r = await orq(['plan', 'archive'], p);
  assert.match(r.out, /\nremoved 1 worker worktrees\n/);
  assert.equal(await exists(dir), false);
  assert.ok(branches(p).includes('orq/p0/review-1'));
});

test('archive removes decision worktrees, with and without a plan id in the branch', async (t) => {
  const { p } = await finished(t);
  const dirs = [addWorker(p, 'ask1', 'orq/ask-1'), addWorker(p, 'ask2', 'orq/p1/ask-2')];
  const r = await orq(['plan', 'archive'], p);
  assert.match(r.out, /\nremoved 2 worker worktrees\n/);
  for (const d of dirs) assert.equal(await exists(d), false);
});

test('C1: archive keeps an abandoned lease (its thread may still run) and says to interrupt it', async (t) => {
  const { p } = await finished(t);
  const dir = path.join(p.home, 'leases');
  const lease = (threadId, over = {}) => ({ threadId, project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false, ...over });
  await writeLease(dir, lease('mine'));
  await writeLease(dir, lease('quiet', { abandoned: true }));
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.ok(lines.includes('note: removed 1 lease left by the archived plan'), r.out);
  assert.ok(lines.includes('note: thread quiet was given up and may still be running: interrupt it (t3_thread_interrupt)'), r.out);
  assert.deepEqual((await listLeases(dir)).map((l) => l.threadId), ['quiet']);
});
