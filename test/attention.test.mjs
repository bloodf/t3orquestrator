import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attention, ownQueue, queuedRuns, BALANCE_AFTER_MS, BALANCE_REPEAT_MS, PENDING_REPEAT_MS,
} from '../lib/attention.mjs';
import { reduce } from '../lib/ledger.mjs';
import { writeLease } from '../lib/leases.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const A = 'a'.repeat(40);
const run1 = (n) => `run:thread:mcp%3Aown:ordinal:${n}`;
const started = { type: 'plan-started', at: 1, planId: 'p', baseSha: A, integrationBranch: 'orq/p/integration' };
const launched = (u) => ({
  type: 'launched', unit: u, at: 2, attempt: 1, threadId: `t-${u}`, key: 'a::m2', instance: 'a', model: 'm2', branch: `orq/p/${u}-a1`, baseSha: A, tier: 2,
});
const plan = { goal: 'g', units: [{ id: 'a' }, { id: 'b' }] };
const blockedA = reduce([started, launched('a'), launched('b'), { type: 'blocked', unit: 'a', at: 3 }]);
const running = reduce([started, launched('a'), launched('b')]);
const QUIET = { held: false, heldBack: 0 };

// threads: what `t3 thread show <id>` answers, by id
async function setup(t, threads = {}, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-attention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'repo', '.orq'), { recursive: true });
  const ctx = { cwd: path.join(root, 'repo'), env: { T3ORQ_HOME: path.join(root, 'home'), ...env }, clock: NOW, shown: [], deps: {} };
  ctx.now = () => ctx.clock;
  const showThread = (id) => {
    ctx.shown.push(id);
    if (!threads[id]) throw new Error('thread show failed (exit 1): not found');
    return { thread: threads[id], messages: [] };
  };
  return { ctx, run: { fx: { t3: { showThread } }, plan, machine: {} }, threads };
}

test('queuedRuns: the runs counted beyond the active one', () => {
  assert.equal(queuedRuns({ runCount: 45, activeRunId: run1(45) }), 0);
  assert.equal(queuedRuns({ runCount: 47, activeRunId: run1(45) }), 2);
  assert.equal(queuedRuns({ runCount: 3, activeRunId: null }), 0);
  assert.equal(queuedRuns({ runCount: null, activeRunId: run1(1) }), 0);
  assert.equal(queuedRuns(undefined), 0);
});

test('own queue: told once per new message, looked at once a minute, and never outside a T3 thread', async (t) => {
  const own = { runCount: 47, activeRunId: run1(45) };
  const { ctx, run } = await setup(t, { own }, { T3CODE_THREAD_ID: 'own' });
  const [line] = await ownQueue(ctx, run);
  assert.match(line, /^queued: 2 messages wait in your own thread's queue/);
  assert.match(line, /t3_queue \(action "list", then "read"\).*cancel them \(action "cancel"\)/);
  assert.equal(await ownQueue(ctx, run), null); // same poll minute: T3 is not asked again
  assert.deepEqual(ctx.shown, ['own']);
  ctx.clock += MIN;
  assert.equal(await ownQueue(ctx, run), null); // the same messages: told already
  own.runCount = 48;
  ctx.clock += MIN;
  assert.match((await ownQueue(ctx, run))[0], /^queued: 3 messages/);
  const fresh = { fx: run.fx, plan };
  assert.equal(await ownQueue(ctx, fresh), null); // another `orq wait` call reads the mark
  const { ctx: shell, run: r2 } = await setup(t, { own });
  assert.equal(await ownQueue(shell, r2), null);
  assert.deepEqual(shell.shown, []);
});

test('own queue: one message reads in the singular, and a thread T3 cannot show is skipped', async (t) => {
  const { ctx, run } = await setup(t, { own: { runCount: 2, activeRunId: run1(1) } }, { T3CODE_THREAD_ID: 'own' });
  assert.match((await ownQueue(ctx, run))[0], /^queued: 1 message waits .* read it now .* act on it, then cancel it /);
  const { ctx: gone, run: r2 } = await setup(t, {}, { T3CODE_THREAD_ID: 'own' });
  assert.equal(await ownQueue(gone, r2), null);
});

test('pending: a blocked unit is told at once, again every ten minutes, and forgotten once answered', async (t) => {
  const { ctx, run } = await setup(t);
  const answer = 'answer it (t3_pending_request, action "respond") or interrupt the thread (t3_thread_interrupt) so orq replaces it';
  assert.deepEqual(await attention(ctx, run, blockedA, QUIET), [`pending: unit a: thread t-a waits on a request: ${answer}`]);
  ctx.clock += PENDING_REPEAT_MS - 1;
  assert.equal(await attention(ctx, run, blockedA, QUIET), null);
  ctx.clock += 1;
  assert.deepEqual(await attention(ctx, run, blockedA, QUIET), [`pending: unit a: thread t-a waits on a request (for 10 min): ${answer}`]);
  assert.equal(await attention(ctx, run, running, QUIET), null); // answered
  assert.match((await attention(ctx, run, blockedA, QUIET))[0], /^pending: unit a: thread t-a waits on a request: /); // asks again: told at once
});

test('pending: a review or decision thread of this project that waits on a request is told too', async (t) => {
  const { ctx, run } = await setup(t, { 't-rev': { pending: 1 }, 't-ask': { pending: 0 } });
  const lease = (threadId, unit, project = ctx.cwd) => writeLease(path.join(ctx.env.T3ORQ_HOME, 'leases'), {
    threadId, project, unit, instance: 'a', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false,
  });
  await lease('t-rev', 'review-1');
  await lease('t-ask', 'ask-2');
  await lease('t-a', 'a'); // a unit's own thread: tick reads it
  await lease('t-other', 'review-1', '/another/project');
  const out = await attention(ctx, run, running, QUIET);
  assert.equal(out.length, 1);
  assert.match(out[0], /^pending: review 1: thread t-rev waits on a request: answer it /);
  assert.deepEqual(ctx.shown.sort(), ['t-ask', 't-rev']);
});

const peerStatus = (over = {}) => JSON.stringify({ at: NOW + BALANCE_AFTER_MS, cores: 32, load: 0.2, cap: 16, active: 7, free: 9, held: false, pressure: {}, protect: {}, ...over });

test('balance: a machine held for ten minutes with work waiting names the least-loaded peer with room, every 30 minutes', async (t) => {
  const { ctx, run } = await setup(t);
  ctx.deps.ssh = async (target) => ({ code: 0, stdout: target === 'storm' ? peerStatus() : peerStatus({ load: 1.4, free: 2 }), stderr: '' });
  run.machine = { peers: [{ host: 'busy', ssh: 'busy' }, { host: 'host-2', ssh: 'storm' }] };
  run.admission = { held: true, since: NOW, reasons: ['io pressure 72% (limit 40%)'] };
  const held = { held: true, heldBack: 3 };
  ctx.clock = NOW + BALANCE_AFTER_MS - 1;
  assert.equal(await attention(ctx, run, running, held), null);
  ctx.clock += 1;
  assert.deepEqual(await attention(ctx, run, running, held), [
    'balance: this machine has started nothing new for 10 min (io pressure 72% (limit 40%)); 3 launches or checks wait. '
    + 'Peer host-2 has 9 free slots at load 0.2 per core: hand it work that has not started here',
  ]);
  ctx.clock += BALANCE_REPEAT_MS - 1;
  assert.equal(await attention(ctx, run, running, held), null);
});

test('balance: nothing is said without peers, without waiting work, or when no peer has room', async (t) => {
  const { ctx, run } = await setup(t);
  ctx.clock = NOW + BALANCE_AFTER_MS;
  ctx.deps.ssh = async () => ({ code: 0, stdout: peerStatus({ held: true, free: 0 }), stderr: '' });
  run.admission = { held: true, since: NOW, reasons: ['load 3.0 per core (limit 2)'] };
  assert.equal(await attention(ctx, run, running, { held: true, heldBack: 1 }), null); // no peers configured
  run.machine = { peers: [{ host: 'host-1', ssh: 'host-1' }] };
  assert.equal(await attention(ctx, run, running, { held: true, heldBack: 1 }), null); // the peer is held too
  assert.equal(await attention(ctx, run, running, QUIET), null); // nothing waits on the hold
});
