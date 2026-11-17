// A limit, sign-out or capacity failure: what it cools (health), how routing steers away (route), what the ledger
// counts (ledger), and when a running thread is known to be stuck at its limit (usage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordLimit } from '../lib/health.mjs';
import { exhausted } from '../lib/usage.mjs';
import { route } from '../lib/route.mjs';
import { reduce, apply, unitOf } from '../lib/ledger.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-16T14:30:00Z');
const H = 3600_000;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const inst = (driverKind = 'x', over = {}) => ({ driverKind, enabled: true, constraints: [], limit: 2, failures: 0, cooldownUntil: null, ...over });
const mod = (instance, model, family, tier = 2) => [`${instance}::${model}`, {
  instance, model, family, tier, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null,
}];
const REG = deepFreeze({
  version: 1,
  instances: { ag: inst('antigravity'), ag2: inst('antigravity'), codex: inst('codex'), odd: inst() },
  models: Object.fromEntries([
    mod('ag', 'gemini-4-argon', 'google'), mod('ag', 'gemini-3.8-flash', 'google'), mod('ag', 'claude-sonnet-5-5', 'anthropic'),
    mod('ag2', 'gemini-3.8-flash', 'google'), mod('codex', 'gpt-6.1-terra', 'openai'), mod('odd', 'a', 'unknown'), mod('odd', 'b', 'unknown'),
  ]),
});
const until = (r, key) => r.models[key].cooldownUntil;

test('recordLimit: a quota limit cools the models of that family on that instance until the reset, nothing else', () => {
  const r = recordLimit(REG, 'ag::gemini-4-argon', { kind: 'limit', until: NOW + 100 * H });
  assert.equal(until(r, 'ag::gemini-4-argon'), NOW + 100 * H);
  assert.equal(until(r, 'ag::gemini-3.8-flash'), NOW + 100 * H); // same account, same family pool
  assert.equal(until(r, 'ag::claude-sonnet-5-5'), null); // another pool on the same instance
  assert.equal(until(r, 'ag2::gemini-3.8-flash'), null); // another instance
  assert.equal(r.instances.ag.cooldownUntil, null); // the instance still serves its other family
  assert.equal(r.models['ag::gemini-4-argon'].failures, 0); // not a failure strike
  // a family it cannot tell apart: the whole instance; every model cooled, so the instance shows as cooling too
  const odd = recordLimit(REG, 'odd::a', { kind: 'limit', until: NOW + H });
  assert.deepEqual([until(odd, 'odd::a'), until(odd, 'odd::b'), odd.instances.odd.cooldownUntil], [NOW + H, NOW + H, NOW + H]);
  const single = recordLimit(REG, 'codex::gpt-6.1-terra', { kind: 'limit', until: NOW + 2 * H });
  assert.equal(single.instances.codex.cooldownUntil, NOW + 2 * H);
});

test('recordLimit: sign-out cools the instance; capacity cools the model; a longer cooldown is kept', () => {
  const auth = recordLimit(REG, 'ag::gemini-4-argon', { kind: 'auth', until: NOW + H });
  assert.deepEqual([auth.instances.ag.cooldownUntil, until(auth, 'ag::gemini-4-argon')], [NOW + H, null]);
  const cap = recordLimit(REG, 'ag::gemini-3.8-flash', { kind: 'capacity', until: NOW + H });
  assert.deepEqual([until(cap, 'ag::gemini-3.8-flash'), until(cap, 'ag::gemini-4-argon'), cap.instances.ag.cooldownUntil], [NOW + H, null, null]);
  const longer = recordLimit(recordLimit(REG, 'ag::gemini-4-argon', { kind: 'limit', until: NOW + 9 * H }), 'ag::gemini-4-argon', { kind: 'capacity', until: NOW + H });
  assert.equal(until(longer, 'ag::gemini-4-argon'), NOW + 9 * H);
  assert.throws(() => recordLimit(REG, 'ag::gemini-4-argon', { kind: 'nope', until: NOW }), /unknown limit kind/);
});

const withUsageOn = (id, usage) => ({ ...REG, instances: { ...REG.instances, [id]: { ...REG.instances[id], usage } } });
const reading = (windows, over = {}) => ({ checkedAt: NOW, down: false, stale: false, windows, ...over });

test('exhausted: a window that binds the model at 100%, or a signed-out instance, from the usage T3 reported', () => {
  assert.equal(exhausted(REG, 'ag::gemini-4-argon', NOW), null); // no usage known
  const full = withUsageOn('ag', reading([{ id: 'gemini-weekly', used: 100, resetAt: NOW + 50 * H }, { id: '3p-weekly', used: 10, resetAt: NOW + H }]));
  assert.deepEqual(exhausted(full, 'ag::gemini-4-argon', NOW), { kind: 'limit', reason: 'usage window gemini-weekly at 100%', until: NOW + 50 * H, source: 'usage' });
  assert.equal(exhausted(full, 'ag::claude-sonnet-5-5', NOW), null); // its own pool has room
  const near = withUsageOn('codex', reading([{ id: 'primary', used: 95, resetAt: NOW + H }]));
  assert.equal(exhausted(near, 'codex::gpt-6.1-terra', NOW), null); // near the limit still runs
  const out = withUsageOn('codex', reading([], { down: true, signedOut: true }));
  assert.equal(exhausted(out, 'codex::gpt-6.1-terra', NOW).kind, 'auth');
  // T3's probe failed (status error) but the account is signed in: a quiet thread is left to the stall rules
  assert.equal(exhausted(withUsageOn('codex', reading([], { down: true })), 'codex::gpt-6.1-terra', NOW), null);
  assert.equal(exhausted(REG, 'ghost::m', NOW), null);
});

const go = (over = {}) => route({ registry: deepFreeze(REG), rules, job: 'implement', now: NOW, ...over });
const keys = (r) => r.candidates.map((c) => c.key);

test('route: after a provider failure, another instance first, and among those another model family first', () => {
  // gemini failed on ag: codex (other instance, other family) before ag2 gemini (other instance, same family),
  // which comes before ag's claude (same instance, other family); the failed model is last
  const r = go({ avoidKeys: ['ag::gemini-4-argon'], avoidInstances: ['ag'], avoidFamilies: ['google'] });
  assert.deepEqual(keys(r), [
    'codex::gpt-6.1-terra', 'odd::a', 'odd::b', 'ag2::gemini-3.8-flash', 'ag::claude-sonnet-5-5', 'ag::gemini-3.8-flash', 'ag::gemini-4-argon',
  ]);
  // without family to avoid, the order is as before: the same family on another instance is as good as any
  assert.equal(keys(go({ avoidKeys: ['ag::gemini-4-argon'], avoidInstances: ['ag'] }))[0], 'ag2::gemini-3.8-flash');
  // unknown is no family: it is never avoided for being "the same"
  const odd = go({ avoidFamilies: ['unknown'] });
  assert.equal(odd.candidates.find((c) => c.key === 'odd::a').avoided, undefined);
});

const A = 'a'.repeat(40);
let clock = 0;
const ev = (type, unit, extra = {}) => ({ type, unit, at: (clock += 1), ...extra });
const launched = (unit, over = {}) => ev('launched', unit, {
  attempt: 1, threadId: 't1', key: 'ag::gemini-4-argon', instance: 'ag', model: 'gemini-4-argon', branch: `orq/p/${unit}-a1`, baseSha: A, tier: 2, ...over,
});
const run = (...events) => reduce([ev('plan-started', null, { planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' }), ...events]);
const LIMIT = { kind: 'limit', reason: 'Usage Limit Reached', until: NOW + H };

test('ledger: a limit failure does not count toward the provider-failure judgment; the relaunch records the reroute', () => {
  const limited = run(launched('u'), ev('thread-ended', 'u', { status: 'failed', limit: LIMIT }));
  const u = unitOf(limited, 'u');
  assert.deepEqual([u.state, u.attempt, u.providerFailures, u.failedLaunch.limit], ['queued', 1, 0, LIMIT]);
  assert.deepEqual(u.failedKeys, ['ag::gemini-4-argon']);
  const plain = unitOf(run(launched('u'), ev('thread-ended', 'u', { status: 'failed' })), 'u');
  assert.deepEqual([plain.providerFailures, plain.failedLaunch.limit], [1, null]); // an old ledger's failure counts as before
  const moved = apply(apply(limited, launched('u', { threadId: 't2', key: 'codex::gpt-6.1-terra', instance: 'codex' })),
    ev('rerouted', 'u', { from: 'ag::gemini-4-argon', to: 'codex::gpt-6.1-terra', reason: 'limit', detail: 'Usage Limit Reached' }));
  assert.deepEqual(unitOf(moved, 'u').rerouted, { from: 'ag::gemini-4-argon', to: 'codex::gpt-6.1-terra', reason: 'limit' });
  // the next launch is a new start: its reroute (if any) is its own
  const next = apply(apply(apply(moved, ev('thread-ended', 'u', { status: 'completed' })), ev('gate-started', 'u', { attempt: 1, headSha: A })),
    ev('gated', 'u', { attempt: 1, verdict: 'fail', failures: ['x'], flags: [], headSha: A }));
  assert.equal(unitOf(apply(next, ev('feedback-sent', 'u', { attempt: 2, threadId: 't2' })), 'u').rerouted.to, 'codex::gpt-6.1-terra');
  assert.throws(() => apply(limited, ev('rerouted', 'u', { from: 'a', to: 'b', reason: 'limit' })), /illegal transition/);
  assert.equal(unitOf(run(launched('u')), 'u').rerouted, null);
});

test('review fix 1/3: the ledger counts limit and sign-out failures apart; a retry clears them', () => {
  const AUTH = { kind: 'auth', reason: 'Not logged in', until: NOW + H };
  const s = run(launched('u'), ev('thread-ended', 'u', { status: 'failed', limit: LIMIT }), launched('u', { threadId: 't2' }),
    ev('thread-ended', 'u', { status: 'failed', limit: AUTH }));
  const u = unitOf(s, 'u');
  assert.deepEqual([u.providerFailures, u.limitFailures, u.authFailures], [0, 2, 1]);
  const judged = apply(s, ev('needs-judgment', 'u', { reason: 'x', provider: true }));
  const back = unitOf(apply(judged, ev('retried', 'u')), 'u');
  assert.deepEqual([back.limitFailures, back.authFailures], [0, 0]);
  assert.deepEqual([unitOf(run(launched('u')), 'u').limitFailures, unitOf(run(launched('u')), 'u').authFailures], [0, 0]); // old ledgers
});

test('review fix 8: a gate pass or a completed thread does not lift a limit or sign-out cooldown', async () => {
  const { recordSuccess, markAlive } = await import('../lib/health.mjs');
  const limited = recordLimit(REG, 'codex::gpt-6.1-terra', { kind: 'limit', until: NOW + 9 * H });
  const passed = recordSuccess(limited, 'codex::gpt-6.1-terra', { now: NOW });
  assert.deepEqual([until(passed, 'codex::gpt-6.1-terra'), passed.instances.codex.cooldownUntil], [NOW + 9 * H, NOW + 9 * H]);
  const signedOut = recordLimit(REG, 'ag::gemini-4-argon', { kind: 'auth', until: NOW + H });
  assert.equal(markAlive(signedOut, 'ag::claude-sonnet-5-5', NOW).instances.ag.cooldownUntil, NOW + H);
  // a plain failure cooldown is still lifted as before; a lapsed limit no longer holds
  const plain = { ...REG, models: { ...REG.models, 'codex::gpt-6.1-terra': { ...REG.models['codex::gpt-6.1-terra'], cooldownUntil: NOW + H } } };
  assert.equal(until(recordSuccess(plain, 'codex::gpt-6.1-terra', { now: NOW }), 'codex::gpt-6.1-terra'), null);
  assert.equal(until(recordSuccess(limited, 'codex::gpt-6.1-terra', { now: NOW + 10 * H }), 'codex::gpt-6.1-terra'), null);
});
