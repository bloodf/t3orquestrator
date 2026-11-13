import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const GIB = 1024 ** 3;
const A = 'a'.repeat(40);

async function orq(args, p) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: { readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }) },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const append = (p, ...events) => commit(p.repo, () => events.map((e) => ({ at: NOW, ...e })));
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const launched = (unit, threadId, over = {}) => ({
  type: 'launched', unit, attempt: 1, threadId, key: 'pa::m2', instance: 'pa', model: 'm2', branch: `orq/p/${unit}-a1`, baseSha: A, tier: 2,
  family: 'fam-a', ...over,
});

async function project(t) {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')], { cap: 3 });
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1'), launched('b', 'th2'), { type: 'blocked', unit: 'b' },
    { type: 'needs-judgment', unit: 'c', reason: '3 provider failures' });
  const dir = path.join(p.home, 'leases');
  await writeLease(dir, { threadId: 'th1', project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false });
  await writeLease(dir, { threadId: 'th2', project: p.repo, unit: 'b', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: true });
  await writeLease(dir, { threadId: 'x', project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false });
  await writeLease(dir, { threadId: 'old', project: '/gone', unit: 'z', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW - 31 * 60_000, blocked: false });
  return p;
}

test('status: plan line, counts, one line per unit, and the note', async (t) => {
  const p = await project(t);
  const r = await orq(['status'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    'plan: test goal (p1)',
    `integration: orq/p1/integration head=${A.slice(0, 12)} base=${A.slice(0, 12)}`,
    'cap=3 active=1 blocked=1 gates=0 machine_leases=3 expired_leases=1',
    'a running attempt=1 model=pa::m2 tier=2 thread=th1',
    'b blocked attempt=1 model=pa::m2 tier=2 thread=th2',
    'c failed 3 provider failures',
    'note: cap covers threads orq started; threads started by hand are not counted',
    '',
  ].join('\n'));
  const json = JSON.parse((await orq(['status', '--json'], p)).out);
  assert.equal(json.plan.planId, 'p1');
  assert.equal(json.cap, 3);
  assert.deepEqual(json.units.map((u) => [u.id, u.state]), [['a', 'running'], ['b', 'blocked'], ['c', 'failed']]);
});

test('status: a plan that has not started', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const r = await orq(['status'], p);
  assert.match(r.out, /^plan: test goal \(not started\)\ncap=.*\na queued\nnote: /);
});

test('unit retry: only from failed, resets the budget, optional tier', async (t) => {
  const p = await project(t);
  const bad = await orq(['unit', 'retry', 'a'], p);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, 'orq: unit a is running; only a failed unit can be retried\n');
  assert.equal((await orq(['unit', 'retry', 'c', '--tier', '9'], p)).code, 2);
  const r = await orq(['unit', 'retry', 'c', '--tier', '3'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'retried c: queued, minimum tier 3\n');
  const c = unitOf(await readState(p.repo), 'c');
  assert.deepEqual([c.state, c.attempt, c.providerFailures, c.minTier], ['queued', 0, 0, 3]);
  assert.equal((await orq(['unit', 'retry', 'zz'], p)).err, 'orq: unit zz is not in the plan\n');
});

test('unit drop: removes the lease and notes the thread still runs', async (t) => {
  const p = await project(t);
  const r = await orq(['unit', 'drop', 'a'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'dropped a\nnote: thread th1 keeps running in T3; stop it there if needed\n');
  assert.equal(unitOf(await readState(p.repo), 'a').state, 'dropped');
  assert.deepEqual((await listLeases(path.join(p.home, 'leases'))).map((l) => l.threadId).sort(), ['old', 'th2', 'x']);
  assert.equal((await orq(['unit', 'drop', 'a'], p)).err, 'orq: unit a is dropped; it cannot be dropped\n');
  assert.equal((await orq(['unit', 'drop', 'c'], p)).out, 'dropped c\n');
  assert.equal((await orq(['unit'], p)).code, 2);
});

test('help lists the new commands but hides gate-run', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const r = await orq(['help'], p);
  for (const name of ['wait', 'status', 'unit']) assert.match(r.out, new RegExp(`^${name} `, 'm'));
  assert.doesNotMatch(r.out, /gate-run/);
  await fs.stat(p.repo);
});

test('status: flags, tiers and the authors line once units are integrated', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')], { cap: 3 });
  const pass = (u, flags) => [{ type: 'thread-ended', unit: u, status: 'completed' },
    { type: 'gate-started', unit: u, attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: u, attempt: 1, verdict: 'pass', failures: [], flags, headSha: B }];
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1', { key: 'pb::m3', instance: 'pb', model: 'm3', tier: 3, family: 'fam-b' }),
    launched('b', 'th2', { key: 'pa::m4', instance: 'pa', model: 'm4', tier: 4, family: 'fam-c' }),
    launched('c', 'th3', { key: 'pa::m4b', instance: 'pa', model: 'm4b', tier: 4, family: 'fam-d' }),
    ...pass('a', [{ kind: 'flaky', path: '', detail: 'x' }, { kind: 'placeholder', path: 'a.txt', detail: 'y' }]),
    ...pass('b', []), ...pass('c', []),
    { type: 'integrated', unit: 'a', sha: B, head: C }, { type: 'integrated', unit: 'b', sha: B, head: C },
    { type: 'integrated', unit: 'c', sha: B, head: C });
  const r = await orq(['status'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[1], `integration: orq/p1/integration head=${C.slice(0, 12)} base=${A.slice(0, 12)}`);
  assert.equal(lines[3], 'a integrated attempt=1 model=pb::m3 tier=3 thread=th1 flags=flaky,placeholder');
  assert.equal(lines[4], 'b integrated attempt=1 model=pa::m4 tier=4 thread=th2');
  assert.equal(lines[6], 'authors: max_tier=4 family=fam-c');
  const json = JSON.parse((await orq(['status', '--json'], p)).out);
  assert.deepEqual(json.integration, { branch: 'orq/p1/integration', head: C, base: A });
  assert.deepEqual(json.authors, { maxTier: 4, family: 'fam-c' });
  assert.deepEqual(json.units[0].flagKinds, ['flaky', 'placeholder']);
  assert.equal(json.units[0].tier, 3);
});

test('route --job review fills the author from the project ledger; flags win; no ledger keeps the error', async (t) => {
  const p = await project(t);
  await append(p, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B }, { type: 'integrated', unit: 'a', sha: B, head: C });
  const r = await orq(['route', '--job', 'review'], p);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^1 pb m2 tier=2 family=f /);
  const tier4 = await makeProject(t, [unitSpec('a')]);
  await append(tier4, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1', { key: 'pb::m4', instance: 'pb', model: 'm4', tier: 4 }), { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B }, { type: 'integrated', unit: 'a', sha: B, head: C });
  const high = await orq(['route', '--job', 'fix'], tier4);
  assert.match(high.out, /^1 pb m4 tier=4/);
  assert.equal(high.out.trim().split('\n').length, 1);
  const flagged = await orq(['route', '--job', 'fix', '--author-tier', '3'], tier4);
  assert.match(flagged.out, /^1 pa m3 tier=3/);
  const none = await orq(['route', '--job', 'review'], await makeProject(t, [unitSpec('a')]));
  assert.equal(none.code, 1);
  assert.match(none.err, /needs authorTier/);
});

test('item 7: unit drop refuses a passed unit and one whose gate is running', async (t) => {
  const p = await project(t);
  await append(p, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B },
    { type: 'unblocked', unit: 'b' }, { type: 'thread-ended', unit: 'b', status: 'completed' },
    { type: 'gate-started', unit: 'b', attempt: 1, headSha: B, pid: process.pid });
  const pidFile = path.join(p.repo, '.orq', 'units', 'b', 'gate-1.pid');
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, `${process.pid}\n`);
  for (const id of ['a', 'b']) {
    const r = await orq(['unit', 'drop', id], p);
    assert.equal(r.code, 4);
    assert.equal(r.err, `orq: cannot drop ${id} while it is being gated or merged; run it again in a moment\n`);
  }
  await fs.writeFile(pidFile, '999999999\n');
  assert.equal((await orq(['unit', 'drop', 'b'], p)).code, 0);
});

test('item 5: unit retry integration restarts a final gate that was lost twice', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1'), { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B }, { type: 'integrated', unit: 'a', sha: B, head: C });
  const early = await orq(['unit', 'retry', 'integration'], p);
  assert.equal(early.code, 1);
  assert.equal(early.err, 'orq: the final gate is not stuck; nothing to retry\n');
  const lost = { type: 'gate-started', unit: 'integration', attempt: 1, headSha: C, pid: 1 };
  await append(p, lost, lost);
  const r = await orq(['unit', 'retry', 'integration'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'retried integration: the final gate will run again\n');
  assert.equal((await readState(p.repo)).plan.finalGateStarts, 0);
});

test('status: cooling instances are listed after the units', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const regFile = path.join(p.home, 'registry.json');
  const reg = JSON.parse(await fs.readFile(regFile, 'utf8'));
  reg.instances.pb = { ...reg.instances.pb, cooldownUntil: NOW + 600_000 };
  reg.instances.pa = { ...reg.instances.pa, cooldownUntil: NOW - 1 };
  await fs.writeFile(regFile, JSON.stringify(reg));
  const lines = (await orq(['status'], p)).out.split('\n');
  assert.equal(lines.at(-3), `cooling: pb until ${new Date(NOW + 600_000).toISOString()}`);
  assert.match(lines.at(-2), /^note: /);
  const json = JSON.parse((await orq(['status', '--json'], p)).out);
  assert.deepEqual(json.cooling, [{ instance: 'pb', until: NOW + 600_000 }]);
});

test('unit drop refuses while a unit that is not dropped depends on it, naming the way out', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b', { deps: ['a'] }), unitSpec('c', { deps: ['a'] })], { cap: 3 });
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' });
  const refused = await orq(['unit', 'drop', 'a'], p);
  assert.equal(refused.code, 4);
  assert.equal(refused.err, 'orq: cannot drop a: b, c depend on it; drop them first, or remove "a" from their deps in .orq/plan.json\n');
  assert.equal(unitOf(await readState(p.repo), 'a').state, 'queued');
  assert.equal((await orq(['unit', 'drop', 'b'], p)).code, 0);
  assert.match((await orq(['unit', 'drop', 'a'], p)).err, /cannot drop a: c depend/);
  assert.equal((await orq(['unit', 'drop', 'c'], p)).code, 0);
  assert.equal((await orq(['unit', 'drop', 'a'], p)).out, 'dropped a\n');
});

test('unit retry integration restarts a final gate whose setup failed', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1'), { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B }, { type: 'integrated', unit: 'a', sha: B, head: C },
    { type: 'gate-started', unit: 'integration', attempt: 1, headSha: C, pid: 1 });
  const file = path.join(p.repo, '.orq', 'units', 'integration', 'gate-1.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ verdict: 'fail', failures: ['setup failed (exit 1)'], flags: [], steps: [], headSha: C, setupFailed: true }));
  const r = await orq(['unit', 'retry', 'integration'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal((await readState(p.repo)).plan.finalGateStarts, 0);
});

test('unit retry after a setup failure gates the branch again and refuses --tier', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await append(p, { type: 'plan-started', unit: null, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' },
    launched('a', 'th1'), { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: B, pid: 1 },
    { type: 'needs-judgment', unit: 'a', reason: 'setup failed (exit 1)', setup: true });
  const tiered = await orq(['unit', 'retry', 'a', '--tier', '3'], p);
  assert.equal(tiered.code, 1);
  assert.equal(tiered.err, 'orq: unit a failed its setup: no new worker runs, its branch is gated again; retry without --tier\n');
  assert.equal(unitOf(await readState(p.repo), 'a').state, 'failed');
  const r = await orq(['unit', 'retry', 'a'], p);
  assert.equal(r.out, 'retried a: its branch will be gated again\n');
  assert.equal(unitOf(await readState(p.repo), 'a').state, 'gating');
});
