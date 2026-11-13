import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { adoptLaunches, tendLeases } from '../lib/reconcile.mjs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import fs from 'node:fs/promises';
import { makeProject, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;

async function setup(t) {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  await commit(p.repo, () => [{ type: 'plan-started', unit: null, at: 1, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' }]);
  const dir = path.join(p.home, 'leases');
  const fx = { cwd: p.repo, env: p.env, now: () => NOW };
  const ahead = (unit, over = {}) => ({
    threadId: `th-${unit}`, project: p.repo, unit, instance: 'pa', model: 'm2', startedAt: NOW - MIN, heartbeatAt: NOW - MIN, blocked: false,
    attempt: 1, launch: 1, key: 'pa::m2', branch: `orq/p1/${unit}-a1`, baseSha: p.baseSha, tier: 2, family: 'f', ...over,
  });
  return { p, dir, fx, ahead, leases: async () => (await listLeases(dir)).sort((x, y) => (x.threadId < y.threadId ? -1 : 1)) };
}

test('adoptLaunches: a lease with a live thread and no launched event is adopted once', async (t) => {
  const s = await setup(t);
  await writeLease(s.dir, s.ahead('a', { wantedTier: 3 }));
  await writeLease(s.dir, s.ahead('b', { launch: 2 }));
  assert.deepEqual(await adoptLaunches(s.fx, []), []);
  assert.deepEqual(await adoptLaunches(s.fx, [{ id: 'th-a' }, { id: 'th-b' }]), ['a']);
  const a = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([a.state, a.threadId, a.launches, a.branch, a.key, a.tier, a.family], ['running', 'th-a', 1, 'orq/p1/a-a1', 'pa::m2', 2, 'f']);
  assert.equal(a.wantedTier, 3); // launched below its tier: status still says so after a crash
  assert.equal(unitOf(await readState(s.p.repo), 'b').state, 'queued');
  assert.deepEqual(await adoptLaunches(s.fx, [{ id: 'th-a' }]), []);
});

test('tendLeases: refreshes referenced leases, reaps orphans and stale reservations, leaves other projects alone', async (t) => {
  const s = await setup(t);
  await writeLease(s.dir, s.ahead('a'));
  await writeLease(s.dir, s.ahead('b'));
  await adoptLaunches(s.fx, [{ id: 'th-a' }, { id: 'th-b' }]);
  await commit(s.p.repo, () => [{ type: 'dropped', unit: 'b', at: NOW }]);
  await writeLease(s.dir, { ...s.ahead('a'), threadId: 'reserve-1-a-a1', reservation: true, startedAt: NOW - 3 * MIN, heartbeatAt: NOW - 3 * MIN });
  await writeLease(s.dir, { ...s.ahead('b'), threadId: 'reserve-2-b-a1', reservation: true, startedAt: NOW - MIN });
  await writeLease(s.dir, { ...s.ahead('a'), threadId: 'elsewhere', project: '/other' });
  const state = await readState(s.p.repo);
  const r = await tendLeases(s.fx, state, { 'th-a': { id: 'th-a', status: 'running' }, 'th-b': { id: 'th-b', status: 'running' } });
  assert.deepEqual(r, {
    refreshed: ['th-a'], removed: ['reserve-1-a-a1', 'th-b'],
    notes: ['note: unit b is no longer running; thread th-b left running — interrupt it'],
  });
  const after = await s.leases();
  assert.deepEqual(after.map((l) => l.threadId), ['elsewhere', 'reserve-2-b-a1', 'th-a']);
  assert.equal(after.find((l) => l.threadId === 'th-a').heartbeatAt, NOW);
  assert.equal(after.find((l) => l.threadId === 'elsewhere').heartbeatAt, NOW - MIN);
  const ended = await tendLeases(s.fx, state, { 'th-a': { id: 'th-a', status: 'failed' } });
  assert.deepEqual(ended.removed, ['th-a']);
});

test('tendLeases: a review lease lives while its review is running and its thread is active', async (t) => {
  const s = await setup(t);
  const reviewLease = (n) => ({ ...s.ahead(`review-${n}`), launch: undefined, threadId: `rv${n}`, kind: 'review' });
  await writeLease(s.dir, reviewLease(1));
  const state = await readState(s.p.repo);
  const reviews = path.join(s.p.repo, '.orq', 'reviews.json');
  const running = { rv1: { id: 'rv1', status: 'running' } };
  await fs.writeFile(reviews, JSON.stringify({ reviews: [{ n: 1, threadId: 'rv1', status: 'running' }] }));
  assert.deepEqual((await tendLeases(s.fx, state, running)).removed, []);
  assert.equal((await s.leases())[0].heartbeatAt, NOW);
  assert.deepEqual((await tendLeases(s.fx, state, { rv1: { id: 'rv1', status: 'completed' } })).removed, ['rv1']);
  await writeLease(s.dir, { ...reviewLease(1), startedAt: NOW - 3 * MIN }); // unlisted past the grace period: gone
  assert.deepEqual((await tendLeases(s.fx, state, {})).removed, ['rv1']);
  await writeLease(s.dir, reviewLease(1));
  await fs.writeFile(reviews, JSON.stringify({ reviews: [{ n: 1, threadId: 'rv1', status: 'done' }] }));
  assert.deepEqual((await tendLeases(s.fx, state, running)).removed, ['rv1']);
  await writeLease(s.dir, reviewLease(2));
  await fs.rm(reviews);
  assert.deepEqual((await tendLeases(s.fx, state, { rv2: { id: 'rv2', status: 'running' } })).removed, ['rv2']);
});

test('tendLeases: a plan unit named review-api is a unit lease, not a review lease', async (t) => {
  const p = await makeProject(t, [unitSpec('review-api')]);
  await commit(p.repo, () => [{ type: 'plan-started', unit: null, at: 1, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' }]);
  const dir = path.join(p.home, 'leases');
  const fx = { cwd: p.repo, env: p.env, now: () => NOW };
  await writeLease(dir, {
    threadId: 'th-r', project: p.repo, unit: 'review-api', instance: 'pa', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false,
    attempt: 1, launch: 1, key: 'pa::m2', branch: 'orq/p1/review-api-a1', baseSha: p.baseSha, tier: 2, family: 'f',
  });
  await adoptLaunches(fx, [{ id: 'th-r' }]);
  const r = await tendLeases(fx, await readState(p.repo), { 'th-r': { id: 'th-r', status: 'running' } });
  assert.deepEqual(r, { refreshed: ['th-r'], removed: [], notes: [] });
});

test('tendLeases: a just-started review lease whose thread is not listed yet is kept for the grace period', async (t) => {
  const s = await setup(t);
  const reviews = path.join(s.p.repo, '.orq', 'reviews.json');
  await fs.writeFile(reviews, JSON.stringify({ reviews: [{ n: 1, threadId: 'rv1', status: 'running' }] }));
  const lease = (startedAt) => ({ ...s.ahead('review-1'), launch: undefined, threadId: 'rv1', kind: 'review', startedAt, heartbeatAt: startedAt });
  const state = await readState(s.p.repo);
  await writeLease(s.dir, lease(NOW - 30_000));
  assert.deepEqual((await tendLeases(s.fx, state, {})).removed, []);
  await writeLease(s.dir, lease(NOW - 3 * MIN));
  assert.deepEqual((await tendLeases(s.fx, state, {})).removed, ['rv1']);
});
