import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick } from '../lib/tick.mjs';
import { reduce, FINAL } from '../lib/ledger.mjs';
import { recordFailure } from '../lib/health.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const inst = { enabled: true, constraints: [], limit: 4, failures: 0, cooldownUntil: null };
const model = (instance, name, tier) => [`${instance}::${name}`, {
  instance, model: name, family: 'f', tier, tierSource: 'user', available: true, confirmedAt: null,
  failures: 0, cooldownUntil: null, lastUsedAt: null, outcomes: {},
}];
const registry = {
  version: 1,
  instances: { a: { ...inst }, b: { ...inst } },
  models: Object.fromEntries([model('a', 'm2', 2), model('b', 'm2', 2), model('a', 'm3', 3), model('b', 'm4', 4)]),
};
const unit = (id, over = {}) => ({
  id, title: id, job: 'implement', deps: [], paths: [`${id}/**`], forbidden: [], evidence: 'true', order: `.orq/${id}.md`, ...over,
});
const plan = { goal: 'g', units: [unit('a'), unit('b', { deps: ['a'] }), unit('c')] };

const started = { type: 'plan-started', at: 1, planId: 'p', baseSha: A, integrationBranch: 'orq/p/integration' };
const launched = (u, over = {}) => ({
  type: 'launched', unit: u, at: 2, attempt: 1, threadId: `t-${u}`, key: 'a::m2', instance: 'a', model: 'm2',
  branch: `orq/p/${u}-a1`, baseSha: A, tier: 2, ...over,
});
const ended = (u, status = 'completed') => ({ type: 'thread-ended', unit: u, at: 3, status });
const gateStarted = (u, attempt = 1) => ({ type: 'gate-started', unit: u, at: 4, attempt, headSha: B, pid: 7 });
const gatedEv = (u, verdict, attempt = 1) => ({
  type: 'gated', unit: u, at: 5, attempt, verdict, failures: verdict === 'fail' ? ['bad'] : [], flags: [], headSha: B,
});
const integratedEv = (u) => ({ type: 'integrated', unit: u, at: 6, sha: B, head: C });
const thread = (id, over = {}) => ({ id, status: 'running', pending: 0, updatedAt: NOW - MIN, ...over });
const lease = (threadId, over = {}) => ({
  threadId, project: '/other', unit: 'x', instance: 'b', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false, ...over,
});

const doneA = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'pass'), integratedEv('a')];

function go(events, over = {}) {
  return tick(deepFreeze({
    plan, state: reduce([started, ...events]), threads: {}, registry, rules, leases: [], cap: 4, gates: {}, config: {}, now: NOW, ...over,
  }));
}
const types = (r) => r.actions.map((a) => a.type);
const evTypes = (r) => r.events.map((e) => `${e.type}:${e.unit}`);
const launches = (r) => r.actions.filter((a) => a.type === 'launch');

test('project cap: a project cap below the machine cap limits this project; other projects use only the machine cap', () => {
  assert.deepEqual(launches(go(doneA)).map((x) => x.unit), ['b', 'c']); // no project cap: as before
  const capped = go(doneA, { projectCap: 1, project: '/p' });
  assert.deepEqual(launches(capped).map((x) => x.unit), ['b']);
  assert.deepEqual([capped.report.slotWaiting, capped.report.capBy], [['c'], 'project']);
  const mine = go(doneA, { projectCap: 2, project: '/p', leases: [lease('t-x', { project: '/p' })] });
  assert.deepEqual(launches(mine).map((x) => x.unit), ['b']);
  // two other projects' threads leave the machine 2 slots: this project's cap of 2 is untouched by them
  const others = go(doneA, { projectCap: 2, project: '/p', leases: [lease('t-x'), lease('t-y')] });
  assert.deepEqual([launches(others).map((x) => x.unit), others.report.capBy], [['b', 'c'], 'machine']);
  const full = go(doneA, { projectCap: 2, project: '/p', leases: [lease('t-x'), lease('t-y'), lease('t-z'), lease('t-w')] });
  assert.deepEqual([launches(full).map((x) => x.unit), full.report.capBy], [[], 'machine']);
});

test('rule 1: pending > 0 blocks once; back to 0 unblocks', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a', { pending: 1 }) } });
  assert.deepEqual(evTypes(r), ['blocked:a']);
  assert.deepEqual(r.actions, [{ type: 'lease-block', unit: 'a', threadId: 't-a' }]);
  assert.deepEqual(r.report.newlyBlocked, [{ unit: 'a', threadId: 't-a' }]);
  const again = go([launched('a'), { type: 'blocked', unit: 'a', at: 3 }], { threads: { 't-a': thread('t-a', { pending: 1 }) } });
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.report.newlyBlocked, []);
  const back = go([launched('a'), { type: 'blocked', unit: 'a', at: 3 }], { threads: { 't-a': thread('t-a') } });
  assert.deepEqual(evTypes(back), ['unblocked:a']);
  assert.deepEqual(back.actions, [{ type: 'lease-unblock', unit: 'a', threadId: 't-a' }]);
});

test('rule 1: completed thread moves to gating, removes the lease and starts a gate', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a', { status: 'completed' }) } });
  assert.deepEqual(evTypes(r), ['thread-ended:a']);
  assert.equal(r.events[0].status, 'completed');
  assert.deepEqual(r.actions, [
    { type: 'lease-remove', unit: 'a', threadId: 't-a' },
    { type: 'mark-alive', unit: 'a', key: 'a::m2' },
    { type: 'gate-start', unit: 'a', attempt: 1 },
  ]);
});

test('rule 1: a completed thread older than the feedback is not taken as the new run', () => {
  const events = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: NOW, attempt: 2, threadId: 't-a' }];
  const stale = go(events, { threads: { 't-a': thread('t-a', { status: 'completed', updatedAt: NOW - 1 }) } });
  assert.deepEqual(stale.events, []);
  const fresh = go(events, { threads: { 't-a': thread('t-a', { status: 'completed', updatedAt: NOW + 1 }) } });
  assert.deepEqual(evTypes(fresh), ['thread-ended:a']);
});

test('rule 2: pass records success (first pass) and integrates', () => {
  const r = go([launched('a'), ended('a'), gateStarted('a')], {
    gates: { a: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: B } } },
  });
  assert.deepEqual(evTypes(r), ['gated:a']);
  assert.deepEqual(r.actions, [
    { type: 'record-result', unit: 'a', key: 'a::m2', job: 'implement', pass: true },
    { type: 'record-success', unit: 'a', key: 'a::m2', job: 'implement', firstPass: true },
    { type: 'integrate', unit: 'a' },
    { type: 'launch', unit: 'c', attempt: 1, key: 'a::m2', instance: 'a', model: 'm2', tier: 2, family: 'f', job: 'implement', failures: null },
  ]);
});

test('rule 2: no-evidence passes with a flag', () => {
  const r = go([launched('a'), ended('a'), gateStarted('a')], {
    gates: { a: { running: false, result: { verdict: 'no-evidence', failures: [], flags: [], headSha: B } } },
  });
  assert.equal(r.events[0].verdict, 'no-evidence');
  assert.deepEqual(r.events[0].flags.map((f) => f.kind), ['no-evidence']);
  assert.deepEqual(types(r), ['record-result', 'record-success', 'integrate', 'launch']);
});

test('rule 2: a lost gate is restarted once, then needs judgment; concurrency limits starts', () => {
  const lost = { a: { running: false, result: null } };
  assert.deepEqual(types(go([launched('a'), ended('a'), gateStarted('a')], { gates: lost })), ['gate-start']);
  const twice = go([launched('a'), ended('a'), gateStarted('a'), gateStarted('a')], { gates: lost });
  assert.deepEqual(evTypes(twice), ['needs-judgment:a']);
  assert.equal(twice.events[0].reason, 'gate could not complete');
  assert.deepEqual(twice.report.judgment, [{ unit: 'a', reason: 'gate could not complete' }]);
  const two = go([...doneA, launched('b'), ended('b'), launched('c'), ended('c')]);
  assert.deepEqual(r2(two), ['gate-start:b']);
  const busy = go([...doneA, launched('b'), ended('b'), gateStarted('b'), launched('c'), ended('c')], {
    gates: { b: { running: true, result: null } },
  });
  assert.deepEqual(r2(busy), []);
  assert.deepEqual(r2(go([...doneA, launched('b'), ended('b'), launched('c'), ended('c')], { config: { gateConcurrency: 2 } })), ['gate-start:b', 'gate-start:c']);
});
function r2(r) { return r.actions.filter((a) => a.type === 'gate-start').map((a) => `${a.type}:${a.unit}`); }

test('fix units go first: a fix unit takes the free gate slot and the free launch slot before earlier units', () => {
  const fixLast = { goal: 'g', units: [unit('a'), unit('b'), unit('f2', { job: 'fix' }), unit('c'), unit('f', { job: 'fix' })] };
  const waiting = [launched('b'), ended('b'), launched('f'), ended('f'), launched('f2'), ended('f2')];
  assert.deepEqual(r2(go(waiting, { plan: fixLast })), ['gate-start:f2']);
  // the plan's own order still holds among fix units and among the others
  assert.deepEqual(r2(go(waiting, { plan: fixLast, config: { gateConcurrency: 3 } })), ['gate-start:f2', 'gate-start:f', 'gate-start:b']);
  const one = go(doneA, { plan: fixLast, cap: 1 });
  assert.deepEqual(launches(one).map((x) => x.unit), ['f2']);
  assert.deepEqual(one.report.slotWaiting, ['f', 'b', 'c']);
  // feedback: a fix unit's failed gate gets the one free slot before an earlier unit's
  const failedBoth = [...doneA, launched('b'), ended('b'), gateStarted('b'), gatedEv('b', 'fail'),
    launched('f'), ended('f'), gateStarted('f'), gatedEv('f', 'fail')];
  const fb = go(failedBoth, { plan: fixLast, cap: 1 }).actions.filter((x) => x.type === 'send-feedback').map((x) => x.unit);
  assert.deepEqual(fb, ['f']);
});

test('rule 3: provider failure removes the lease, records failure, and relaunches on another key (the failed one cools down)', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a', { status: 'failed' }) } });
  assert.deepEqual(evTypes(r), ['thread-ended:a']);
  assert.deepEqual(r.actions.slice(0, 2), [
    { type: 'lease-remove', unit: 'a', threadId: 't-a' },
    { type: 'record-failure', unit: 'a', key: 'a::m2', job: 'implement', kind: 'unknown' },
  ]);
  const [l] = launches(r);
  assert.equal(l.unit, 'a');
  assert.notEqual(l.key, 'a::m2');
  assert.equal(l.attempt, 1);
  const missing = go([launched('a')]);
  assert.equal(missing.events[0].status, 'missing');
});

test('rule 3: three provider failures need judgment', () => {
  const fail = (n) => [launched('a', { key: `k${n}` }), ended('a', 'cancelled')];
  const r = go([...fail(1), ...fail(2), launched('a')], { threads: { 't-a': thread('t-a', { status: 'interrupted' }) } });
  assert.deepEqual(evTypes(r), ['thread-ended:a', 'needs-judgment:a']);
  assert.equal(r.events[1].reason, '3 provider failures');
  assert.deepEqual(launches(r).map((a) => a.unit), ['c']);
});

test('rule 4: the full quality ladder across three attempts', () => {
  const failGate = (attempt) => ({ a: { running: false, result: { verdict: 'fail', failures: [`f${attempt}`], flags: [], headSha: B } } });
  const one = go([launched('a'), ended('a'), gateStarted('a')], { gates: failGate(1) });
  assert.deepEqual(evTypes(one), ['gated:a']);
  assert.deepEqual(one.actions, [
    { type: 'record-result', unit: 'a', key: 'a::m2', job: 'implement', pass: false },
    { type: 'send-feedback', unit: 'a', attempt: 2, threadId: 't-a', failures: ['f1'], key: 'a::m2', instance: 'a', model: 'm2' },
  ]);
  const at2 = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, ended('a'), gateStarted('a', 2)];
  const two = go(at2, { gates: failGate(2) });
  assert.deepEqual(evTypes(two), ['gated:a']);
  assert.ok(!types(two).includes('record-failure'));
  const [l] = launches(two);
  assert.equal(l.attempt, 3);
  assert.equal(l.key, 'a::m3');
  assert.deepEqual(l.failures, ['f2']);
  const at3 = [...at2, gatedEv('a', 'fail', 2), launched('a', { attempt: 3, key: 'a::m3', model: 'm3', tier: 3 }), ended('a'), gateStarted('a', 3)];
  const three = go(at3, { gates: failGate(3) });
  assert.deepEqual(evTypes(three), ['gated:a', 'needs-judgment:a']);
  assert.equal(three.events[1].reason, 'gate failed 3 times: f3');
});

test('rule 4: feedback waits for a free slot and is retried on later polls until sent', () => {
  const r = go([launched('a'), ended('a'), gateStarted('a')], {
    cap: 1, leases: [lease('other')],
    gates: { a: { running: false, result: { verdict: 'fail', failures: ['x'], flags: [], headSha: B } } },
  });
  assert.deepEqual(evTypes(r), ['gated:a']);
  assert.deepEqual(types(r), ['record-result']); // no slot: no feedback yet
  const awaiting = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail')];
  const retry = go(awaiting);
  assert.deepEqual(retry.events, []);
  assert.deepEqual(retry.actions.map((a) => `${a.type}:${a.unit}`), ['send-feedback:a']);
  assert.deepEqual(retry.actions[0].failures, ['bad']);
  assert.deepEqual(go(awaiting, { cap: 1, leases: [lease('other')] }).actions, []);
});

test('item 2: a feedback run that never starts is reported, then treated as a provider failure', () => {
  const sentAt = (ago) => [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: NOW - ago, attempt: 2, threadId: 't-a' }];
  const th = { threads: { 't-a': thread('t-a', { status: 'completed', updatedAt: NOW - 30 * MIN }) } };
  assert.deepEqual(go(sentAt(MIN), th).report.stalled, []);
  const visible = go(sentAt(3 * MIN), th);
  assert.deepEqual(visible.events, []);
  assert.deepEqual(visible.report.stalled, [{ unit: 'a', threadId: 't-a', minutes: 3 }]);
  const lost = go(sentAt(21 * MIN), th);
  assert.deepEqual(evTypes(lost).slice(0, 1), ['thread-ended:a']);
  assert.equal(lost.events[0].status, 'feedback-lost');
  assert.deepEqual(types(lost).slice(0, 2), ['lease-remove', 'record-failure']);
});

test('rule 5: start one unit first, then fill the slots', () => {
  const first = go([]);
  assert.deepEqual(launches(first).map((a) => a.unit), ['a']);
  assert.equal(launches(first)[0].attempt, 1);
  const inFlight = go([launched('a')], { threads: { 't-a': thread('t-a') } });
  assert.deepEqual(launches(inFlight), []);
  const after = go(doneA);
  assert.deepEqual(launches(after).map((a) => a.unit), ['b', 'c']);
});

test('rule 5: a project that archived a plan before is proven: no start-one-first wait', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a') }, config: { proven: true } });
  assert.deepEqual(launches(r).map((x) => x.unit), ['c']); // b waits on its dep a, not on the rule
  assert.deepEqual(launches(go([launched('a')], { threads: { 't-a': thread('t-a') } })), []);
});

test('rule 5: cap counts leases from other projects', () => {
  assert.deepEqual(launches(go(doneA, { cap: 1, leases: [lease('x1')] })), []);
  assert.deepEqual(launches(go(doneA, { cap: 2, leases: [lease('x1')] })).map((a) => a.unit), ['b']);
  assert.equal(go(doneA, { cap: 1, leases: [lease('x1')] }).report.noSlots, true);
});

test('rule 5: a blocked lease frees its slot', () => {
  const r = go(doneA, { cap: 1, leases: [lease('x1', { blocked: true })] });
  assert.deepEqual(launches(r).map((a) => a.unit), ['b']);
});

test('rule 5: a dependant launches only after its dependency is integrated', () => {
  const passed = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'pass')];
  assert.ok(!launches(go(passed)).some((a) => a.unit === 'b'));
  assert.ok(launches(go(doneA)).some((a) => a.unit === 'b'));
});

test('rule 5: no candidate is reported, not launched', () => {
  const empty = { version: 1, instances: {}, models: {} };
  const r = go([], { registry: empty });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.report.unroutable[0], { unit: 'a', blocked: 'empty', reason: 'no usable model in registry; run sync', retryAt: null });
  assert.deepEqual(r.report.unroutable.map((x) => x.unit), ['a', 'c']);
});

test('rule 5: instance limits count launches made in the same tick', () => {
  const one = { ...registry, instances: { a: { ...inst, limit: 1 } }, models: Object.fromEntries([model('a', 'm2', 2)]) };
  const r = go(doneA, { registry: one });
  assert.deepEqual(launches(r).map((a) => a.unit), ['b']);
  assert.deepEqual(r.report.slotWaiting, ['c']); // held back by the instance limit only: it waits, it is not unroutable
  assert.deepEqual(r.report.unroutable, []);
});

test('rule 6: final gate when everything is integrated or dropped, then done', () => {
  const all = [...doneA, launched('b'), { type: 'dropped', unit: 'b', at: 7 }, { type: 'dropped', unit: 'c', at: 8 }];
  const r = go(all);
  assert.deepEqual(r.actions, [{ type: 'final-gate' }]);
  assert.equal(r.report.done, false);
  const withResult = go([...all, { type: 'gate-started', unit: FINAL, at: 9, attempt: 1, headSha: C, pid: 1 }], {
    gates: { [FINAL]: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: C } } },
  });
  assert.deepEqual(evTypes(withResult), ['final-gated:null']);
  assert.equal(withResult.report.done, true);
  const nothing = go(['a', 'b', 'c'].map((u, i) => ({ type: 'dropped', unit: u, at: 10 + i })));
  assert.deepEqual(nothing.actions, []);
  assert.equal(nothing.report.done, true);
});

test('rule 7: a stalled thread is reported, never acted on', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a', { updatedAt: NOW - 25 * MIN }) } });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.report.stalled, [{ unit: 'a', threadId: 't-a', minutes: 25 }]);
  assert.deepEqual(go([launched('a')], { threads: { 't-a': thread('t-a', { updatedAt: NOW - 25 * MIN }) }, config: { stallMinutes: 30 } }).report.stalled, []);
});

test('report counts in-flight and queued units', () => {
  const r = go(doneA);
  assert.equal(r.report.inFlight, 2);
  assert.equal(r.report.queued, 0);
  assert.equal(go([]).report.queued, 2);
});

test('deterministic and does not mutate inputs', () => {
  const events = [...doneA, launched('c')];
  const opts = { threads: { 't-c': thread('t-c', { pending: 2 }) } };
  assert.deepEqual(go(events, opts), go(events, opts));
});

test('plan growth: a final gate for an older head does not count; appended units fan out at once', () => {
  const finalAt = (head) => ({ type: 'final-gated', unit: null, at: 9, verdict: 'pass', failures: [], head });
  const grown = { goal: 'g', units: [unit('a'), unit('d'), unit('e')] };
  const old = go([...doneA, finalAt(A)], { plan: { goal: 'g', units: [unit('a')] } });
  assert.deepEqual(old.actions, [{ type: 'final-gate' }]);
  assert.equal(old.report.done, false);
  const current = go([...doneA, finalAt(C)], { plan: { goal: 'g', units: [unit('a')] } });
  assert.equal(current.report.done, true);
  assert.deepEqual(current.actions, []);
  const fan = go([...doneA, finalAt(C)], { plan: grown });
  assert.deepEqual(launches(fan).map((x) => x.unit), ['d', 'e']);
  assert.equal(fan.report.done, false);
});

test('a final gate result for another head is ignored and the gate restarts', () => {
  const r = go([...doneA, { type: 'gate-started', unit: FINAL, at: 9, attempt: 1, headSha: C, pid: 1 }], {
    plan: { goal: 'g', units: [unit('a')] },
    gates: { [FINAL]: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: A } } },
  });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.actions, [{ type: 'final-gate' }]);
});

test('rule 5: a lease whose heartbeat is older than the TTL stops counting', () => {
  const stale = lease('x1', { heartbeatAt: NOW - 31 * MIN });
  assert.deepEqual(launches(go(doneA, { cap: 1, leases: [stale] })).map((a) => a.unit), ['b']);
  assert.deepEqual(launches(go(doneA, { cap: 1, leases: [stale], config: { leaseTtlMinutes: 60 } })), []);
});

test('review and fix units route on the authors of integrated work', () => {
  const fixOnly = go([], { plan: { goal: 'g', units: [unit('f', { job: 'fix' })] } });
  assert.equal(launches(fixOnly)[0].tier, 2);
  const byTier3 = [launched('a', { key: 'a::m3', model: 'm3', tier: 3, family: 'g' }), ended('a'), gateStarted('a'), gatedEv('a', 'pass'), integratedEv('a')];
  const r = go(byTier3, { plan: { goal: 'g', units: [unit('a'), unit('r', { job: 'review', deps: ['a'] })] } });
  assert.deepEqual(launches(r).map((x) => [x.unit, x.key]), [['r', 'a::m3']]);
});

test('item 1: every passed unit gets an integrate action on every poll', () => {
  const passed = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'pass')];
  const r = go(passed);
  assert.deepEqual(r.actions.filter((a) => a.type !== 'launch'), [{ type: 'integrate', unit: 'a' }]);
});

test('item 3: attempt 3 excludes the model that failed twice, even with no higher tier', () => {
  const flat = { ...registry, models: Object.fromEntries([model('a', 'm2', 2), model('b', 'm2', 2)]) };
  const at2 = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, ended('a'), gateStarted('a', 2), gatedEv('a', 'fail', 2)];
  const [l] = launches(go(at2, { registry: flat }));
  assert.equal(l.attempt, 3);
  assert.equal(l.key, 'b::m2');
});

test('item 4: routing blocked by the quality ladder\'s exclusion needs judgment instead of idling forever', () => {
  const one = { ...registry, models: Object.fromEntries([model('a', 'm2', 2)]) };
  const solo = { registry: one, plan: { goal: 'g', units: [unit('a')] } };
  const twice = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, { ...ended('a'), at: 7 }, gateStarted('a', 2), gatedEv('a', 'fail', 2)];
  const r = go(twice, solo);
  assert.deepEqual(evTypes(r), ['needs-judgment:a']);
  assert.equal(r.events[0].reason, 'no model available: all excluded');
  assert.deepEqual(r.report.judgment, [{ unit: 'a', reason: 'no model available: all excluded' }]);
  // a provider failure on the only model is not an exclusion: it cools down and is retried after the backoff
  const provider = go([launched('a')], { ...solo, threads: { 't-a': thread('t-a', { status: 'failed' }) } });
  assert.deepEqual(evTypes(provider), ['thread-ended:a']);
  assert.deepEqual(provider.report.unroutable.map((u) => [u.unit, u.blocked]), [['a', 'cooling']]);
  assert.ok(provider.report.unroutable[0].retryAt > NOW);
});

test('item 8: a gate result for a commit other than the one gated is ignored', () => {
  const r = go([launched('a'), ended('a'), gateStarted('a')], {
    gates: { a: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: C } } },
  });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.actions, [{ type: 'gate-start', unit: 'a', attempt: 1 }]);
});

test('second review item 2: feedback deferred for a slot keeps the unit in flight and the poll slot-limited', () => {
  const awaiting = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail')];
  const r = go(awaiting, { cap: 1, leases: [lease('other')] });
  assert.equal(r.report.noSlots, true);
  assert.equal(r.report.inFlight, 1);
});

test('a provider failure steers the relaunch to another instance, even at a higher tier', () => {
  const spread = { ...registry, models: Object.fromEntries([model('a', 'm2', 2), model('a', 'm2x', 2), model('b', 'm3', 3)]) };
  const r = go([launched('a')], { registry: spread, threads: { 't-a': thread('t-a', { status: 'failed' }) } });
  const [l] = launches(r);
  assert.equal(l.unit, 'a');
  assert.equal(l.key, 'b::m3');
  const onlyA = { ...registry, instances: { a: inst }, models: Object.fromEntries([model('a', 'm2', 2), model('a', 'm3', 3)]) };
  const fallback = launches(go([launched('a')], { registry: onlyA, threads: { 't-a': thread('t-a', { status: 'failed' }) } }));
  assert.equal(fallback[0].key, 'a::m3');
});

const solo = {
  version: 1,
  instances: { a: inst },
  models: Object.fromEntries([model('a', 'm2', 2), model('a', 'm2x', 2), model('a', 'm3', 3)]),
};
const onA = (u, key) => launched(u, { key: `a::${key}`, model: key, threadId: `t-${u}` });
const failedThread = (...ids) => ({ threads: Object.fromEntries(ids.map((id) => [id, thread(id, { status: 'failed' })])) });

test('same-poll strike: one instance, 1st failure relaunches there flagged avoided, 2nd waits for the cooldown', () => {
  const plan1 = { goal: 'g', units: [unit('a')] };
  const first = go([onA('a', 'm2')], { registry: solo, plan: plan1, ...failedThread('t-a') });
  const [l] = launches(first);
  assert.deepEqual([l.key, l.avoided], ['a::m2x', true]);
  const persisted = recordFailure(solo, 'a::m2', { now: NOW, jobClass: 'implement', kind: 'unknown' });
  const second = go([onA('a', 'm2'), ended('a', 'failed'), onA('a', 'm2x')], { registry: persisted, plan: plan1, ...failedThread('t-a') });
  assert.deepEqual(launches(second), []);
  assert.deepEqual(evTypes(second), ['thread-ended:a']);
  assert.equal(second.report.unroutable[0].retryAt, NOW + 10 * MIN);
  assert.match(second.report.unroutable[0].reason, /cooling down/);
});

test('same-poll strike: two units failing on one instance are not relaunched on it in that poll', () => {
  const two = { ...solo, instances: { a: { ...inst }, b: { ...inst } }, models: { ...solo.models, ...Object.fromEntries([model('b', 'm4', 4)]) } };
  const four = { goal: 'g', units: [unit('a'), unit('c'), unit('d'), unit('e')] };
  const r = go([...doneA, onA('c', 'm2'), onA('e', 'm2x')], { registry: two, plan: four, ...failedThread('t-c', 't-e') });
  assert.deepEqual(launches(r).map((x) => [x.unit, x.instance]), [['c', 'b'], ['d', 'b'], ['e', 'b']]);
});

test('a completed thread marks its instance alive', () => {
  const r = go([launched('a')], { threads: { 't-a': thread('t-a', { status: 'completed' }) } });
  assert.deepEqual(r.actions.filter((a) => a.type === 'mark-alive'), [{ type: 'mark-alive', unit: 'a', key: 'a::m2' }]);
});

const replied = (status, detail, over = {}) => ({ 't-a': thread('t-a', { status: 'completed', report: { status, detail }, ...over }) });

// A stop report is answered once per launch from the same nudge budget as an empty turn; the second one is judged.
test('worker status: a first NEEDS_CONTEXT is answered in the same thread with its reason, no judgment and no gate', () => {
  const r = go([launched('a')], { threads: replied('NEEDS_CONTEXT', 'which answer is right?') });
  assert.deepEqual(evTypes(r), ['thread-ended:a', 'unfinished:a']);
  assert.deepEqual([r.events[1].stop, r.events[1].failures], ['NEEDS_CONTEXT', ['worker reported NEEDS_CONTEXT: which answer is right?']]);
  assert.deepEqual(r.actions.filter((x) => x.type !== 'lease-remove' && x.type !== 'mark-alive'), [{
    type: 'send-feedback', unit: 'a', attempt: 1, threadId: 't-a', failures: ['worker reported NEEDS_CONTEXT: which answer is right?'], key: 'a::m2', instance: 'a', model: 'm2',
  }]);
  assert.deepEqual(r.report.judgment, []);
});

test('worker status: a second stop report on the same launch goes to judgment with the second reason', () => {
  const r = go([launched('a'), ended('a'),
    { type: 'unfinished', unit: 'a', at: 4, failures: ['worker reported BLOCKED: not done yet'], headSha: null, stop: 'BLOCKED' },
    { type: 'feedback-sent', unit: 'a', at: NOW - MIN, attempt: 1, threadId: 't-a' }], { threads: replied('BLOCKED', 'need the API key in .env', { updatedAt: NOW }) });
  assert.deepEqual(evTypes(r), ['thread-ended:a', 'needs-judgment:a']);
  assert.equal(r.events[1].reason, 'worker reported BLOCKED: need the API key in .env');
  assert.deepEqual(r.report.judgment, [{ unit: 'a', reason: 'worker reported BLOCKED: need the API key in .env' }]);
});

test('worker status: a launch already nudged for an empty turn that then reports BLOCKED is judged at once', () => {
  const r = go([launched('a'), ended('a'), { ...gateStarted('a'), headSha: A },
    { type: 'unfinished', unit: 'a', at: 5, failures: ['no commits on top of aaaaaaaaaaaa'], headSha: A },
    { type: 'feedback-sent', unit: 'a', at: NOW - MIN, attempt: 1, threadId: 't-a' }], { threads: replied('BLOCKED', 'x', { updatedAt: NOW }) });
  assert.deepEqual(evTypes(r), ['thread-ended:a', 'needs-judgment:a']);
  assert.equal(r.events[1].reason, 'worker reported BLOCKED: x');
});

test('worker status: BLOCKED after gate feedback is nudged once (a new turn); DONE and unknown replies are gated', () => {
  const afterFeedback = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: NOW - MIN, attempt: 2, threadId: 't-a' }];
  const r = go(afterFeedback, { threads: replied('BLOCKED', '', { updatedAt: NOW }) });
  assert.deepEqual(evTypes(r), ['thread-ended:a', 'unfinished:a']);
  assert.equal(r.events[1].headSha, B); // the gated commit stays recorded
  assert.deepEqual(r.actions.find((x) => x.type === 'send-feedback').attempt, 2);
  for (const report of [{ status: 'DONE', detail: '' }, { status: 'I FINISHED', detail: '' }, null]) {
    const ok = go([launched('a')], { threads: { 't-a': thread('t-a', { status: 'completed', report }) } });
    assert.ok(types(ok).includes('gate-start'), JSON.stringify(report));
  }
});

test('rule 2: a gate that could not complete reports why when the gate process left an error', () => {
  const lost = { a: { running: false, result: null, error: 'orq: globs must be an array' } };
  const twice = go([launched('a'), ended('a'), gateStarted('a'), gateStarted('a')], { gates: lost });
  assert.equal(twice.events[0].reason, 'gate could not complete: orq: globs must be an array');
});

test('rule 6: a final gate that could not complete reports why when the gate process left an error', () => {
  const started = { type: 'gate-started', unit: FINAL, at: 9, attempt: 1, headSha: C, pid: 1 };
  const lost = { [FINAL]: { running: false, result: null, error: 'orq: boom' } };
  const r = go([...doneA, started, started], { plan: { goal: 'g', units: [unit('a')] }, gates: lost });
  assert.deepEqual(r.report.judgment, [{ unit: FINAL, reason: 'final gate could not complete: orq: boom' }]);
  const silent = go([...doneA, started, started], { plan: { goal: 'g', units: [unit('a')] }, gates: { [FINAL]: { running: false, result: null } } });
  assert.deepEqual(silent.report.judgment, [{ unit: FINAL, reason: 'final gate could not complete' }]);
});

test('a queued unit whose dependency was dropped goes to judgment instead of idling', () => {
  const r = go([{ type: 'dropped', unit: 'a', at: 7 }]);
  assert.deepEqual(r.events.filter((e) => e.type === 'needs-judgment').map((e) => [e.unit, e.reason]), [['b', 'depends on dropped unit a']]);
  assert.ok(!launches(r).some((a) => a.unit === 'b'));
  assert.deepEqual(r.report.judgment, [{ unit: 'b', reason: 'depends on dropped unit a' }]);
});

test('a setup failure goes to judgment without feedback, relaunch or a quality rung; a retry gates again', () => {
  const setupFail = { verdict: 'fail', failures: ['setup failed (exit 1): npm ERR! ETIMEDOUT'], flags: [], headSha: B, setupFailed: true };
  const fb = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, { ...ended('a'), at: 7 }, gateStarted('a', 2)];
  const r = go(fb, { gates: { a: { running: false, result: setupFail } } });
  assert.deepEqual(evTypes(r), ['needs-judgment:a']);
  assert.equal(r.events[0].reason, 'setup failed (exit 1): npm ERR! ETIMEDOUT');
  assert.deepEqual(types(r).filter((x) => x !== 'launch'), []);
  assert.ok(!launches(r).some((a) => a.unit === 'a'));
  const failed = reduce([started, ...fb, ...r.events]).units.a;
  assert.deepEqual([failed.state, failed.attempt, failed.minTier], ['failed', 2, null]);
  const retried = reduce([started, ...fb, ...r.events, { type: 'retried', unit: 'a', at: 9 }]);
  const again = go([...fb, ...r.events, { type: 'retried', unit: 'a', at: 9 }]);
  assert.deepEqual([retried.units.a.state, retried.units.a.attempt, retried.units.a.since], ['gating', 2, null]);
  assert.deepEqual(r2(again), ['gate-start:a']);
});

test('a final gate whose setup failed asks for judgment with the setup reason, not done', () => {
  const all = [...doneA, launched('b'), { type: 'dropped', unit: 'b', at: 7 }, { type: 'dropped', unit: 'c', at: 8 },
    { type: 'gate-started', unit: FINAL, at: 9, attempt: 1, headSha: C, pid: 1 }];
  const r = go(all, {
    gates: { [FINAL]: { running: false, result: { verdict: 'fail', failures: ['setup failed (exit 2): boom'], flags: [], headSha: C, setupFailed: true } } },
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.report.done, false);
  assert.deepEqual(r.report.judgment, [{ unit: FINAL, reason: 'setup failed (exit 2): boom' }]);
});

test('a fix unit that cannot get the author\'s tier launches on the best available, carrying the wanted tier', () => {
  const noTop = { ...registry, models: Object.fromEntries([model('a', 'm2', 2), model('a', 'm3', 3)]) };
  const fixPlan = { goal: 'g', units: [unit('a'), unit('f', { job: 'fix', deps: ['a'] })] };
  const r = go([launched('a', { tier: 4, key: 'b::m4', instance: 'b', model: 'm4' }), ended('a'), gateStarted('a'), gatedEv('a', 'pass'), integratedEv('a')],
    { registry: noTop, plan: fixPlan });
  const [l] = launches(r);
  assert.deepEqual([l.unit, l.key, l.tier, l.wantedTier], ['f', 'a::m3', 3, 4]);
  assert.equal(launches(go([], { plan: { goal: 'g', units: [unit('a')] } }))[0].wantedTier, undefined);
});

test('a full machine cap does not hide a unit that cannot be routed', () => {
  const full = { cap: 1, leases: [lease('x')] };
  const empty = go([], { ...full, registry: { version: 1, instances: {}, models: {} } });
  assert.deepEqual(empty.report.unroutable.map((u) => u.unit), ['a', 'c']);
  assert.equal(empty.report.noSlots, false);
  const routable = go([], full);
  assert.deepEqual([routable.report.unroutable, routable.report.noSlots], [[], true]);
  const one = { ...registry, models: Object.fromEntries([model('a', 'm2', 2)]) };
  const twice = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, { ...ended('a'), at: 7 }, gateStarted('a', 2), gatedEv('a', 'fail', 2)];
  const judged = go(twice, { ...full, registry: one, plan: { goal: 'g', units: [unit('a')] } });
  assert.deepEqual(evTypes(judged), ['needs-judgment:a']);
});

test('a unit blocked only by a provider instance limit waits for a slot instead of idling as unroutable', () => {
  const one = { ...registry, instances: { a: { ...inst, limit: 1 } }, models: Object.fromEntries([model('a', 'm2', 2)]) };
  const r = go([], { registry: one, plan: { goal: 'g', units: [unit('a')] }, leases: [lease('other', { instance: 'a' })] });
  assert.deepEqual(launches(r), []);
  assert.deepEqual(r.report.slotWaiting, ['a']);
  assert.equal(r.report.noSlots, true);
  assert.deepEqual(r.report.unroutable, []);
});

test('K7: a quiet running thread is reported at stallMinutes and given up at twice that; blocked is never given up', () => {
  const quiet = (min, over = {}) => go([launched('a')], {
    threads: { 't-a': thread('t-a', { updatedAt: NOW - min * MIN, ...over.thread }) }, leases: [lease('t-a', { project: '/p', unit: 'a', instance: 'a' })], cap: 1, ...over.tick,
  });
  const calm = quiet(19);
  assert.deepEqual([calm.events, calm.report.stalled, calm.report.notes], [[], [], []]);
  const reported = quiet(39);
  assert.deepEqual([reported.events, reported.report.stalled.map((s) => s.minutes)], [[], [39]]);
  const given = quiet(40); // default stallMinutes 20: twice is 40
  assert.deepEqual(evTypes(given), ['thread-ended:a']);
  assert.equal(given.events[0].status, 'stalled');
  assert.deepEqual(given.report.notes, ['note: unit a gave up on thread t-a (quiet for 40 min); it still holds a slot until it ends: interrupt it (t3_thread_interrupt)']);
  assert.deepEqual(given.report.stalled, []);
  // the thread still runs in T3: its lease is kept (abandoned) and still counts, so with cap 1 nothing launches
  assert.deepEqual(types(given), ['lease-abandon', 'record-failure']);
  assert.deepEqual(given.actions[0], { type: 'lease-abandon', unit: 'a', threadId: 't-a' });
  assert.equal(given.report.noSlots, true);
  const roomy = quiet(40, { tick: { cap: 2 } }); // a free slot: the continuation launches in the same tick
  const [relaunch] = launches(roomy);
  assert.equal(relaunch.unit, 'a');
  assert.notEqual(relaunch.key, 'a::m2');
  // once the abandoned lease is gone (thread ended, or its TTL ran out) the next tick launches with cap 1
  const freed = go([launched('a'), { type: 'thread-ended', unit: 'a', at: 3, status: 'stalled' }], { cap: 1 });
  assert.equal(launches(freed)[0].unit, 'a');
  const expired = go([launched('a'), { type: 'thread-ended', unit: 'a', at: 3, status: 'stalled' }], {
    cap: 1, leases: [lease('t-a', { project: '/p', unit: 'a', abandoned: true, heartbeatAt: NOW - 31 * MIN })],
  });
  assert.equal(launches(expired)[0].unit, 'a');
  const held = go([launched('a'), { type: 'thread-ended', unit: 'a', at: 3, status: 'stalled' }], {
    cap: 1, leases: [lease('t-a', { project: '/p', unit: 'a', abandoned: true, heartbeatAt: NOW - 5 * MIN })],
  });
  assert.deepEqual(launches(held), []);
  const custom = quiet(40, { tick: { config: { stallMinutes: 30 } } });
  assert.deepEqual([custom.events, custom.report.stalled.map((s) => s.minutes)], [[], [40]]);
  const blocked = go([launched('a'), { type: 'blocked', unit: 'a', at: 3 }], { threads: { 't-a': thread('t-a', { pending: 1, updatedAt: NOW - 600 * MIN }) } });
  assert.deepEqual([blocked.events, blocked.report.notes], [[], []]);
});

test('F4: judgments for provider reasons are marked as such; others are not', () => {
  const fail = (n) => [launched('a', { key: `k${n}` }), ended('a', 'cancelled')];
  const three = go([...fail(1), ...fail(2), launched('a')], { threads: { 't-a': thread('t-a', { status: 'interrupted' }) } });
  assert.equal(three.events.find((e) => e.type === 'needs-judgment').provider, true);
  const dropped = go([{ type: 'dropped', unit: 'a', at: 7 }]);
  assert.equal(dropped.events.find((e) => e.type === 'needs-judgment').provider, undefined);
});

test('R1: the first gate verdict of each launch is recorded for its model, once; feedback, continuations and setup failures are not', () => {
  const verdict = (v, attempt = 1) => ({ a: { running: false, result: { verdict: v, failures: v === 'fail' ? ['x'] : [], flags: [], headSha: B } } });
  const results = (r) => r.actions.filter((x) => x.type === 'record-result').map(({ key, job, pass }) => [key, job, pass]);
  assert.deepEqual(results(go([launched('a'), ended('a'), gateStarted('a')], { gates: verdict('pass') })), [['a::m2', 'implement', true]]);
  assert.deepEqual(results(go([launched('a'), ended('a'), gateStarted('a')], { gates: verdict('fail') })), [['a::m2', 'implement', false]]);
  // attempt 2 (feedback on the same thread): already counted at attempt 1
  const fb = [launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail'),
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 2, threadId: 't-a' }, { ...ended('a'), at: 7 }, gateStarted('a', 2)];
  assert.deepEqual(results(go(fb, { gates: verdict('pass') })), []);
  // attempt 3 is a new launch on another model: its first verdict counts for that model
  const a3 = [...fb, gatedEv('a', 'fail', 2), launched('a', { attempt: 3, threadId: 't-a3', key: 'b::m4', instance: 'b', model: 'm4', tier: 4 }),
    { ...ended('a'), at: 9 }, gateStarted('a', 3)];
  assert.deepEqual(results(go(a3, { gates: verdict('pass') })), [['b::m4', 'implement', true]]);
  // a continued launch passed on work another model began; a setup failure is not the model's
  const cont = [launched('a'), ended('a', 'failed'), launched('a', { threadId: 't-a2', key: 'b::m4', instance: 'b', continues: B }), ended('a'), gateStarted('a')];
  assert.deepEqual(results(go(cont, { gates: verdict('pass') })), []);
  const setup = { a: { running: false, result: { verdict: 'fail', failures: ['setup failed (exit 1)'], flags: [], headSha: B, setupFailed: true } } };
  assert.deepEqual(results(go([launched('a'), ended('a'), gateStarted('a')], { gates: setup })), []);
});

// A turn that ends with nothing committed is unfinished work, not a verdict: the same thread is told to go on.
const startedAtBase = (u, attempt = 1) => ({ ...gateStarted(u, attempt), headSha: A }); // nothing committed: the head is the base
const noCommit = { a: { running: false, result: { verdict: 'fail', failures: ['no commits on top of aaaaaaaaaaaa'], flags: [], headSha: A } } };

test('unfinished: a thread that ended without a commit is nudged once, with no verdict and no rung used', () => {
  const r = go([launched('a'), ended('a'), startedAtBase('a')], { gates: noCommit });
  assert.deepEqual(evTypes(r), ['unfinished:a']);
  assert.deepEqual(r.actions, [
    { type: 'send-feedback', unit: 'a', attempt: 1, threadId: 't-a', failures: ['no commits on top of aaaaaaaaaaaa'], key: 'a::m2', instance: 'a', model: 'm2' },
  ]);
  assert.equal(r.report.inFlight, 1); // still in flight: wait keeps polling
  // the nudge waits for a slot like feedback does
  const full = go([launched('a'), ended('a'), startedAtBase('a')], { gates: noCommit, cap: 1, leases: [lease('other')] });
  assert.deepEqual(evTypes(full), ['unfinished:a']);
  assert.deepEqual(full.actions, []);
});

test('unfinished: a second empty turn is a recorded gate failure and skips to a new thread; that thread gets its own nudge; then judgment', () => {
  const unfinishedEv = { type: 'unfinished', unit: 'a', at: 5, failures: ['no commits on top of aaaaaaaaaaaa'], headSha: A };
  const nudged = [launched('a'), ended('a'), startedAtBase('a'), unfinishedEv,
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 1, threadId: 't-a' }, ended('a'), startedAtBase('a')];
  const again = go(nudged, { gates: noCommit });
  assert.deepEqual(evTypes(again), ['gated:a']);
  assert.deepEqual([again.events[0].attempt, again.events[0].unanswered], [1, true]);
  // the model's record is written, and the next rung is a new thread one tier up: not the same message a third time
  assert.deepEqual(again.actions.map((x) => `${x.type}:${x.attempt ?? x.pass}`), ['record-result:false', 'launch:3']);
  assert.equal(launches(again)[0].key, 'a::m3');
  const third = [...nudged, { ...gatedEv('a', 'fail'), unanswered: true, headSha: A },
    launched('a', { attempt: 3, threadId: 't-a3', key: 'a::m3', model: 'm3', tier: 3 }), ended('a'), startedAtBase('a', 3)];
  const fresh = go(third, { gates: noCommit });
  assert.deepEqual(evTypes(fresh), ['unfinished:a']); // not yet "gate failed 3 times"
  assert.deepEqual([fresh.actions[0].type, fresh.actions[0].attempt, fresh.actions[0].threadId], ['send-feedback', 3, 't-a3']);
  const last = go([...third, unfinishedEv, { type: 'feedback-sent', unit: 'a', at: 8, attempt: 3, threadId: 't-a3' }, ended('a'), startedAtBase('a', 3)], { gates: noCommit });
  assert.deepEqual(evTypes(last), ['gated:a', 'needs-judgment:a']); // it ends: never an attempt 4
  assert.equal(last.events[1].reason, 'gate failed 3 times: no commits on top of aaaaaaaaaaaa');
  assert.deepEqual(launches(last).filter((x) => x.unit === 'a'), []);
});

test('unfinished: work that passes after a nudge is not a first pass in the model record', () => {
  const pass = { a: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: B } } };
  const r = go([launched('a'), ended('a'), startedAtBase('a'),
    { type: 'unfinished', unit: 'a', at: 5, failures: ['no commits on top of aaaaaaaaaaaa'], headSha: A },
    { type: 'feedback-sent', unit: 'a', at: 6, attempt: 1, threadId: 't-a' }, ended('a'), gateStarted('a')], { gates: pass });
  assert.equal(r.actions.find((x) => x.type === 'record-success').firstPass, false);
});

test('unfinished: only a result that is nothing but "no commits" counts', () => {
  const mixed = { a: { running: false, result: { verdict: 'fail', failures: ['no new commit after feedback', 'no commits on top of aaaaaaaaaaaa'], flags: [], headSha: A } } };
  assert.deepEqual(evTypes(go([launched('a'), ended('a'), startedAtBase('a')], { gates: mixed })), ['gated:a']);
});

test('gate could not complete is marked for a re-gate', () => {
  const r = go([launched('a'), ended('a'), gateStarted('a'), gateStarted('a')], { gates: { a: { running: false, result: null, error: 'boom' } } });
  assert.deepEqual(r.events.map((e) => [e.type, e.reason, e.regate]), [['needs-judgment', 'gate could not complete: boom', true]]);
});

// Limits: a thread stopped by its provider's quota, sign-out or capacity (the reply classified by limits.mjs)
const LIMIT = { kind: 'limit', reason: 'Usage Limit Reached', until: NOW + 100 * 60 * MIN };
const mixed = {
  version: 1,
  instances: { a: { ...inst }, b: { ...inst }, c: { ...inst } },
  models: Object.fromEntries([
    model('a', 'm2', 2), ['b::g2', { ...model('b', 'g2', 2)[1], family: 'f' }], ['c::o2', { ...model('c', 'o2', 2)[1], family: 'other' }],
  ]),
};
const plan1 = { goal: 'g', units: [unit('a')] };

test('limit: the unit relaunches at once on another instance and family; no failure strike, no attempt, no count', () => {
  const r = go([launched('a')], { registry: mixed, plan: plan1, threads: { 't-a': thread('t-a', { status: 'failed', limit: LIMIT }) } });
  assert.deepEqual(r.events.map((e) => [e.type, e.status, e.limit]), [['thread-ended', 'failed', LIMIT]]);
  assert.deepEqual(r.actions.slice(0, 2), [
    { type: 'lease-remove', unit: 'a', threadId: 't-a' },
    { type: 'record-limit', unit: 'a', key: 'a::m2', limit: LIMIT },
  ]);
  const [l] = launches(r);
  assert.deepEqual([l.key, l.attempt], ['c::o2', 1]); // b::g2 is another instance but the same family
  // the limit cooled a::m2 in this tick's registry: the failed model is not even a fallback now
  const solo = { ...mixed, instances: { a: inst }, models: { 'a::m2': mixed.models['a::m2'] } };
  const waits = go([launched('a')], { registry: solo, plan: plan1, threads: { 't-a': thread('t-a', { status: 'failed', limit: LIMIT }) } });
  assert.deepEqual(launches(waits), []);
  assert.deepEqual(waits.report.unroutable, [{ unit: 'a', blocked: 'cooling', reason: 'all cooling down', retryAt: LIMIT.until }]);
});

test('limit: a turn that completed with a limit reply is not gated; it is a limit failure like a failed one', () => {
  const r = go([launched('a')], { registry: mixed, plan: plan1, threads: { 't-a': thread('t-a', { status: 'completed', updatedAt: NOW, limit: LIMIT }) } });
  assert.deepEqual(r.events.map((e) => [e.type, e.status]), [['thread-ended', 'failed']]);
  assert.ok(!types(r).includes('gate-start'));
  assert.equal(launches(r)[0].key, 'c::o2');
});

test('limit: every candidate limited waits for the earliest reset, never judged however many limits it hit', () => {
  const hits = (n) => Array.from({ length: n }, (_, i) => [launched('a', { threadId: `t${i}` }), { ...ended('a', 'failed'), limit: LIMIT }]).flat();
  const cooled = {
    ...mixed,
    models: Object.fromEntries(Object.entries(mixed.models).map(([k, m], i) => [k, { ...m, cooldownUntil: NOW + (i + 1) * 60 * MIN }])),
  };
  const r = go(hits(5), { registry: cooled, plan: plan1 });
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.report.judgment, []);
  assert.deepEqual(r.report.unroutable, [{ unit: 'a', blocked: 'cooling', reason: 'all cooling down', retryAt: NOW + 60 * MIN }]);
  // plain provider failures still go to judgment at three
  const plain = go([...hits(0), launched('a', { threadId: 'x1' }), ended('a', 'failed'), launched('a', { threadId: 'x2' }), ended('a', 'failed'), launched('a')],
    { registry: mixed, plan: plan1, threads: { 't-a': thread('t-a', { status: 'failed' }) } });
  assert.equal(plain.events.at(-1).reason, '3 provider failures');
});

test('limit: a quiet running thread whose account is used up is given up after 5 min, its lease kept, the unit moved', () => {
  const full = {
    ...mixed,
    instances: { ...mixed.instances, a: { ...inst, usage: { checkedAt: NOW, down: false, stale: false, windows: [{ id: 'weekly', used: 100, resetAt: NOW + 9 * 60 * MIN }] } } },
  };
  const quiet = (min, registry = full) => go([launched('a')], {
    registry, plan: plan1, cap: 2, threads: { 't-a': thread('t-a', { updatedAt: NOW - min * MIN }) }, leases: [lease('t-a', { project: '/p', unit: 'a', instance: 'a' })],
  });
  assert.deepEqual(quiet(4).events, []); // still working, or about to end on its own
  const given = quiet(5);
  assert.deepEqual(given.events.map((e) => [e.type, e.status, e.limit?.kind]), [['thread-ended', 'stalled', 'limit']]);
  assert.deepEqual(given.events[0].limit.until, NOW + 9 * 60 * MIN);
  assert.deepEqual(types(given).slice(0, 2), ['lease-abandon', 'launch']); // the usage cooldown is computed, never stored
  assert.deepEqual(given.report.notes, ['note: unit a gave up on thread t-a (its provider stopped it: usage window weekly at 100%; quiet for 5 min); it still holds a slot until it ends: interrupt it (t3_thread_interrupt)']);
  assert.equal(launches(given)[0].key, 'c::o2');
  assert.deepEqual(quiet(5, mixed).events, []); // room left: a quiet thread waits for the stall rules
  // signed out (T3 reports the instance unauthenticated or in error): the same, and the instance cools
  const out = { ...mixed, instances: { ...mixed.instances, a: { ...inst, usage: { checkedAt: NOW, down: true, signedOut: true, stale: false, windows: [] } } } };
  const signedOut = quiet(6, out);
  assert.deepEqual(signedOut.events.map((e) => [e.status, e.limit?.kind]), [['stalled', 'auth']]);
  assert.match(signedOut.report.notes[0], /its provider stopped it: instance a is signed out; quiet for 6 min/);
});

test('review fix 1/3: ten limit failures, or a second sign-out, go to judgment naming why', () => {
  const hit = (i, limit) => [launched('a', { threadId: `t${i}` }), { ...ended('a', 'failed'), limit }];
  const ten = Array.from({ length: 10 }, (_, i) => hit(i, LIMIT)).flat();
  const r = go(ten, { registry: mixed, plan: plan1 });
  assert.deepEqual(r.events.map((e) => [e.type, e.reason, e.provider]), [['needs-judgment', '10 limit failures', true]]);
  assert.deepEqual(go(ten.slice(0, 18), { registry: mixed, plan: plan1 }).report.judgment, []);
  const AUTH = { kind: 'auth', reason: 'Not logged in · Please run /login', until: NOW + 30 * MIN };
  const out = go([...hit(1, AUTH), ...hit(2, AUTH)], { registry: mixed, plan: plan1 });
  assert.deepEqual(out.events.map((e) => [e.type, e.reason]), [['needs-judgment', 'instance a is signed out: sign in to it in T3, then "orq unit retry a"']]);
  assert.deepEqual(go(hit(1, AUTH), { registry: mixed, plan: plan1 }).report.judgment, []);
});

test('review fix 7: a give-up on account usage is not written to the registry; only windows binding the model count', () => {
  const ag = { ...inst, driverKind: 'antigravity', usage: { checkedAt: NOW, down: false, stale: false, windows: [{ id: 'gemini-weekly', used: 100, resetAt: NOW + 60 * MIN }] } };
  const reg = {
    version: 1, instances: { ag, c: { ...inst } },
    models: Object.fromEntries([['ag::gemini-x', { ...model('ag', 'gemini-x', 2)[1] }], ['ag::claude-x', { ...model('ag', 'claude-x', 2)[1], family: 'other' }], model('c', 'o2', 2)]),
  };
  const on = (key) => go([launched('a', { key, instance: 'ag', model: key.split('::')[1] })], {
    registry: reg, plan: plan1, cap: 2, threads: { 't-a': thread('t-a', { updatedAt: NOW - 6 * MIN }) }, leases: [lease('t-a', { project: '/p', unit: 'a', instance: 'ag' })],
  });
  const given = on('ag::gemini-x');
  assert.deepEqual(given.events.map((e) => [e.status, e.limit?.kind]), [['stalled', 'limit']]);
  assert.ok(!types(given).includes('record-limit') && !types(given).includes('record-failure'), types(given).join());
  assert.deepEqual(on('ag::claude-x').events, []); // the full gemini window does not bind a claude model
});

test('a long gate queue holds new launches: over 2x gateConcurrency waiting, new units wait and a note says why', () => {
  const p = { goal: 'g', units: ['a', 'b', 'c', 'd', 'e'].map((id) => unit(id)) };
  const done = ['a', 'b', 'c', 'd'].flatMap((id) => [launched(id), ended(id)]);
  const held = go(done, { plan: p, config: { gateConcurrency: 1, proven: true }, cap: 8 });
  assert.equal(types(held).filter((x) => x === 'gate-start').length, 1);
  assert.deepEqual(launches(held), []);
  assert.ok(held.report.notes.some((n) => /3 units wait for checks/.test(n)));
  const open = go(done, { plan: p, config: { gateConcurrency: 2, proven: true }, cap: 8 });
  assert.deepEqual(launches(open).map((a) => a.unit), ['e']); // 2 waiting after 2 starts: not over 2x2
});

// v0.17.0: a machine under pressure, or with a failing protected service, starts nothing new
const HOLD = { reasons: ['io pressure 72% (limit 40%)'] };

test('hold: no launch while the machine is held; the report says what waits and why', () => {
  const r = go(doneA, { hold: HOLD });
  assert.deepEqual(launches(r), []);
  assert.deepEqual([r.report.held, r.report.hold, r.report.heldBack], [true, 'io pressure 72% (limit 40%)', 2]);
  assert.deepEqual(r.report.slotWaiting, []);
  const free = go(doneA, { hold: null });
  assert.deepEqual([launches(free).length, free.report.held], [2, false]);
});

test('hold: only new launches and feedback wait; unit gates, the final gate and integration keep draining', () => {
  const gating = go([launched('a'), ended('a')], { hold: HOLD });
  assert.deepEqual(types(gating).filter((x) => x === 'gate-start'), ['gate-start']);
  const passed = go([launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'pass')], { hold: HOLD });
  assert.deepEqual(types(passed).filter((x) => x === 'integrate'), ['integrate']);
  const failedOnce = go([launched('a'), ended('a'), gateStarted('a'), gatedEv('a', 'fail')], { hold: HOLD, threads: { 't-a': thread('t-a', { status: 'completed' }) } });
  assert.deepEqual(types(failedOnce).filter((x) => x === 'send-feedback'), []);
  assert.equal(failedOnce.report.held, true);
  const one = { goal: 'g', units: [unit('a')] };
  const final = go(doneA, { plan: one, hold: HOLD });
  assert.deepEqual([types(final).includes('final-gate'), final.report.done], [true, false]);
});

test('hold: a running gate result is still read, and a held machine with nothing to start is not held back', () => {
  const g = { a: { running: false, result: { verdict: 'pass', failures: [], flags: [], headSha: B } } };
  const r = go([launched('a'), ended('a'), gateStarted('a')], { hold: HOLD, gates: g, plan: { goal: 'g', units: [unit('a')] } });
  assert.ok(evTypes(r).includes('gated:a'));
  const idle = go([launched('a')], { hold: HOLD, plan: { goal: 'g', units: [unit('a')] }, threads: { 't-a': thread('t-a') }, leases: [lease('t-a', { project: '/p' })] });
  assert.equal(idle.report.held, false);
});
