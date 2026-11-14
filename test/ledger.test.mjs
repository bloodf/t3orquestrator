import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduce, apply, emptyState, unitOf, FINAL, authorsOf,
} from '../lib/ledger.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
let clock = 0;
const ev = (type, unit, extra = {}) => ({ type, unit, at: (clock += 1), ...extra });
const launched = (unit, over = {}) => ev('launched', unit, {
  attempt: 1, threadId: 't1', key: 'i::m', instance: 'i', model: 'm', branch: `orq/p/${unit}-a1`, baseSha: A, tier: 2, ...over,
});
const started = ev('plan-started', null, { planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' });
const gated = (unit, verdict, over = {}) => ev('gated', unit, { attempt: 1, verdict, failures: [], flags: [], headSha: B, ...over });
const run = (...events) => reduce([started, ...events]);
const state = (s, id) => unitOf(s, id).state;

test('absent unit is queued with attempt 0', () => {
  const u = unitOf(emptyState(), 'x');
  assert.equal(u.state, 'queued');
  assert.equal(u.attempt, 0);
  assert.deepEqual(u.tried, []);
});

test('plan-started sets plan fields and the integration head', () => {
  const s = run();
  assert.deepEqual(s.plan, {
    planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration', integrationHead: A, final: null, finalGateStarts: 0, goal: null,
  });
  assert.throws(() => apply(s, started), /plan already started/);
});

test('happy path: queued -> running -> blocked -> running -> gating -> passed -> integrated', () => {
  const steps = [
    [launched('u'), 'running'],
    [ev('blocked', 'u'), 'blocked'],
    [ev('unblocked', 'u'), 'running'],
    [ev('thread-ended', 'u', { status: 'completed' }), 'gating'],
    [ev('gate-started', 'u', { attempt: 1, headSha: B, pid: 9 }), 'gating'],
    [gated('u', 'pass'), 'passed'],
    [ev('integrated', 'u', { sha: B, head: C }), 'integrated'],
  ];
  let s = run();
  for (const [e, want] of steps) {
    s = apply(s, e);
    assert.equal(state(s, 'u'), want, e.type);
  }
  const u = unitOf(s, 'u');
  assert.equal(u.attempt, 1);
  assert.equal(u.threadId, 't1');
  assert.equal(u.headSha, B);
  assert.equal(u.gateStarts, 1);
  assert.equal(s.plan.integrationHead, C);
});

test('blocked marks the unit reported; unblocked clears it', () => {
  const s = run(launched('u'), ev('blocked', 'u'));
  assert.equal(unitOf(s, 'u').blockedReported, true);
  assert.equal(unitOf(apply(s, ev('unblocked', 'u')), 'u').blockedReported, false);
});

test('provider failure returns the unit to queued, counts it and remembers the key as one to avoid, not exclude', () => {
  const s = run(launched('u'), ev('thread-ended', 'u', { status: 'failed' }));
  const u = unitOf(s, 'u');
  assert.equal(u.state, 'queued');
  assert.equal(u.attempt, 1);
  assert.equal(u.providerFailures, 1);
  assert.deepEqual(u.tried, []);
  assert.deepEqual(u.failedKeys, ['i::m']);
  assert.equal(u.threadId, null);
  const again = unitOf(apply(apply(s, launched('u', { threadId: 't2' })), ev('thread-ended', 'u', { status: 'missing' })), 'u');
  assert.equal(again.providerFailures, 2);
  assert.deepEqual(again.failedKeys, ['i::m']);
  assert.equal(again.launches, 2);
  const judged = apply(s, ev('needs-judgment', 'u', { reason: 'x' }));
  assert.deepEqual(unitOf(apply(judged, ev('retried', 'u')), 'u').failedKeys, []);
});

test('blocked thread that ends is a provider failure too', () => {
  const s = run(launched('u'), ev('blocked', 'u'), ev('thread-ended', 'u', { status: 'cancelled' }));
  assert.equal(state(s, 'u'), 'queued');
});

test('quality ladder: fail at 1 -> feedback attempt 2 -> fail -> queued attempt 3 one tier up', () => {
  let s = run(launched('u'), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'fail', { failures: ['x broke'] }));
  assert.equal(state(s, 'u'), 'queued');
  assert.equal(unitOf(s, 'u').attempt, 2);
  assert.deepEqual(unitOf(s, 'u').lastFailure, ['x broke']);
  s = apply(s, ev('feedback-sent', 'u', { attempt: 2, threadId: 't1' }));
  assert.equal(state(s, 'u'), 'running');
  assert.ok(unitOf(s, 'u').since > 0);
  s = apply(s, ev('thread-ended', 'u', { status: 'completed' }));
  s = apply(s, gated('u', 'fail', { attempt: 2, failures: ['y broke'] }));
  const u = unitOf(s, 'u');
  assert.equal(u.state, 'queued');
  assert.equal(u.attempt, 3);
  assert.equal(u.minTier, 3);
  assert.deepEqual(u.lastFailure, ['y broke']);
});

test('escalation caps at tier 4', () => {
  const s = run(launched('u', { tier: 4 }), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'fail'),
    ev('feedback-sent', 'u', { attempt: 2, threadId: 't1' }), ev('thread-ended', 'u', { status: 'completed' }),
    gated('u', 'fail', { attempt: 2 }));
  assert.equal(unitOf(s, 'u').minTier, 4);
});

test('no-evidence passes and keeps the flags', () => {
  const flags = [{ kind: 'no-evidence', path: '', detail: 'd' }];
  const s = run(launched('u'), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'no-evidence', { flags }));
  assert.equal(state(s, 'u'), 'passed');
  assert.deepEqual(unitOf(s, 'u').flags, flags);
});

test('needs-judgment, retry and drop', () => {
  let s = run(launched('u'), ev('thread-ended', 'u', { status: 'completed' }), ev('needs-judgment', 'u', { reason: 'gate could not complete' }));
  assert.equal(state(s, 'u'), 'failed');
  assert.equal(unitOf(s, 'u').reason, 'gate could not complete');
  s = apply(s, ev('retried', 'u', { tier: 3 }));
  const u = unitOf(s, 'u');
  assert.equal(u.state, 'queued');
  assert.equal(u.attempt, 0);
  assert.equal(u.providerFailures, 0);
  assert.deepEqual(u.tried, []);
  assert.equal(u.minTier, 3);
  assert.equal(u.reason, null);
  assert.equal(state(apply(s, ev('dropped', 'u')), 'u'), 'dropped');
  assert.equal(state(apply(run(), ev('needs-judgment', 'q', { reason: '3 provider failures' })), 'q'), 'failed');
});

test('illegal transitions throw', () => {
  const bad = [
    [run(), ev('blocked', 'u')],
    [run(), ev('gated', 'u', { attempt: 1, verdict: 'pass' })],
    [run(), ev('integrated', 'u', { sha: B, head: C })],
    [run(), ev('retried', 'u')],
    [run(launched('u')), launched('u')],
    [run(launched('u')), ev('unblocked', 'u')],
    [run(launched('u'), ev('dropped', 'u')), ev('dropped', 'u')],
    [run(launched('u'), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'pass'), ev('integrated', 'u', { sha: B, head: C })), ev('dropped', 'u')],
    [run(launched('u'), ev('thread-ended', 'u', { status: 'completed' })), gated('u', 'pass', { attempt: 2 })],
    [run(launched('u'), ev('thread-ended', 'u', { status: 'completed' })), gated('u', 'maybe')],
  ];
  for (const [s, e] of bad) assert.throws(() => apply(s, e), /illegal|attempt|verdict/, e.type);
  assert.throws(() => apply(run(), ev('nope', 'u')), /unknown event type "nope"/);
  assert.throws(() => apply(emptyState(), launched('u')), /plan not started/);
});

test('final gate events are plan-level', () => {
  let s = run();
  s = apply(s, ev('gate-started', FINAL, { attempt: 1, headSha: C, pid: 3 }));
  assert.equal(s.plan.finalGateStarts, 1);
  s = apply(s, ev('final-gated', null, { verdict: 'pass', failures: [], head: C }));
  assert.deepEqual(s.plan.final, { verdict: 'pass', failures: [], head: C });
});

test('reduce on a realistic sequence of two units', () => {
  const s = run(
    launched('a'),
    ev('thread-ended', 'a', { status: 'completed' }),
    ev('gate-started', 'a', { attempt: 1, headSha: B, pid: 1 }),
    gated('a', 'pass'),
    ev('integrated', 'a', { sha: B, head: C }),
    launched('b', { threadId: 't2', baseSha: C }),
    ev('thread-ended', 'b', { status: 'interrupted' }),
    launched('b', { threadId: 't3', key: 'j::m', instance: 'j', baseSha: C }),
    ev('blocked', 'b'),
  );
  assert.equal(state(s, 'a'), 'integrated');
  assert.deepEqual({ ...unitOf(s, 'b'), since: null }, {
    ...unitOf(emptyState(), 'b'),
    state: 'blocked', attempt: 1, launches: 2, providerFailures: 1, failedKeys: ['i::m'], triedInstances: ['i'], threadId: 't3', key: 'j::m', instance: 'j',
    model: 'm', branch: 'orq/p/b-a1', baseSha: C, tier: 2, blockedReported: true, since: null,
  });
  assert.equal(s.plan.integrationHead, C);
});

test('reduce does not mutate its input', () => {
  const events = [started, launched('u')].map((e) => Object.freeze({ ...e }));
  Object.freeze(events);
  assert.doesNotThrow(() => reduce(events));
});

test('launched stores the family; integrating resets the final gate start count', () => {
  let s = run(launched('u', { family: 'fam' }));
  assert.equal(unitOf(s, 'u').family, 'fam');
  s = apply(s, ev('gate-started', FINAL, { attempt: 1, headSha: C, pid: 3 }));
  s = apply(s, ev('thread-ended', 'u', { status: 'completed' }));
  s = apply(s, gated('u', 'pass'));
  s = apply(s, ev('integrated', 'u', { sha: B, head: C }));
  assert.equal(s.plan.finalGateStarts, 0);
});

test('authorsOf: highest tier among integrated units, first in the given order on ties', () => {
  const pass = (u) => [ev('thread-ended', u, { status: 'completed' }), gated(u, 'pass'), ev('integrated', u, { sha: B, head: C })];
  const s = run(launched('a', { tier: 3, family: 'x' }), launched('b', { tier: 4, family: 'y' }), launched('c', { tier: 4, family: 'z' }),
    launched('d', { tier: 4, family: 'w' }), ...pass('a'), ...pass('b'), ...pass('c'));
  assert.deepEqual(authorsOf(['a', 'c', 'b', 'd'], s), { maxTier: 4, family: 'z' });
  assert.equal(authorsOf(['d'], s), null);
});

test('item 3: the second quality failure adds the failed key to tried', () => {
  const s = run(launched('u'), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'fail'),
    ev('feedback-sent', 'u', { attempt: 2, threadId: 't1' }), ev('thread-ended', 'u', { status: 'completed' }), gated('u', 'fail', { attempt: 2 }));
  assert.deepEqual(unitOf(s, 'u').tried, ['i::m']);
});

test('item 5: final-retried resets the final gate start counter', () => {
  let s = run(ev('gate-started', FINAL, { attempt: 1, headSha: C, pid: 3 }), ev('gate-started', FINAL, { attempt: 1, headSha: C, pid: 4 }));
  assert.equal(s.plan.finalGateStarts, 2);
  s = apply(s, ev('final-retried', null));
  assert.equal(s.plan.finalGateStarts, 0);
});

test('provider failures record the instance; quality failures do not; retry clears it', () => {
  let s = run(launched('u'), ev('thread-ended', 'u', { status: 'failed' }));
  assert.deepEqual(unitOf(s, 'u').triedInstances, ['i']);
  s = apply(s, launched('u', { key: 'j::m', instance: 'j', threadId: 't2' }));
  s = apply(s, ev('thread-ended', 'u', { status: 'completed' }));
  s = apply(s, gated('u', 'fail'));
  s = apply(s, ev('feedback-sent', 'u', { attempt: 2, threadId: 't2' }));
  s = apply(s, ev('thread-ended', 'u', { status: 'completed' }));
  s = apply(s, gated('u', 'fail', { attempt: 2 }));
  assert.deepEqual(unitOf(s, 'u').triedInstances, ['i']);
  s = apply(s, ev('needs-judgment', 'u', { reason: 'x' }));
  assert.deepEqual(unitOf(apply(s, ev('retried', 'u')), 'u').triedInstances, []);
});

test('continuation: a provider failure remembers the failed launch; launched records what it continues; old ledgers replay', () => {
  const failed = run(launched('u', { family: 'f' }), ev('thread-ended', 'u', { status: 'failed' }));
  assert.deepEqual(unitOf(failed, 'u').failedLaunch, {
    threadId: 't1', branch: 'orq/p/u-a1', baseSha: A, key: 'i::m', attempt: 1, continues: null, continuesKey: null, status: 'failed',
  });
  const cont = apply(failed, launched('u', { threadId: 't2', key: 'j::m', instance: 'j', baseSha: A, continues: B }));
  assert.deepEqual([unitOf(cont, 'u').continues, unitOf(cont, 'u').failedLaunch], [B, null]);
  // a retry continues only after a judgment for provider reasons, and not with --tier
  const judged = apply(failed, ev('needs-judgment', 'u', { reason: '3 provider failures', provider: true }));
  assert.equal(unitOf(apply(judged, ev('retried', 'u')), 'u').failedLaunch.branch, 'orq/p/u-a1');
  assert.equal(unitOf(apply(judged, ev('retried', 'u', { tier: 3 })), 'u').failedLaunch, null);
  const other = apply(failed, ev('needs-judgment', 'u', { reason: 'depends on dropped unit x' }));
  assert.equal(unitOf(apply(other, ev('retried', 'u')), 'u').failedLaunch, null);
  // an old ledger (no continues field) replays with continues null
  const old = run(launched('u'), ev('thread-ended', 'u', { status: 'failed' }), launched('u', { threadId: 't2' }));
  assert.equal(unitOf(old, 'u').continues, null);
  assert.equal(unitOf(old, 'u').state, 'running');
});
