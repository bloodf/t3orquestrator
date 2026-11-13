import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { route } from '../lib/route.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const inst = (over = {}) => ({ enabled: true, constraints: [], limit: 2, failures: 0, cooldownUntil: null, ...over });
const mod = (instance, model, tier, over = {}) => [`${instance}::${model}`, {
  instance, model, family: 'fam-a', tier, tierSource: 'user', available: true, confirmedAt: null,
  failures: 0, cooldownUntil: null, lastUsedAt: null, ...over,
}];
const reg = (instances, models) => ({ version: 1, instances, models: Object.fromEntries(models) });
const go = (registry, over = {}) => route({ registry: deepFreeze(registry), rules, job: 'implement', now: 1000, ...over });
const keys = (r) => r.candidates.map((c) => c.key);

test('routing.json lists the expected jobs', () => {
  assert.deepEqual(Object.keys(rules.jobs).sort(), [
    'architecture', 'debug-hard', 'decide', 'docs', 'explore', 'fix', 'implement', 'implement-complex',
    'mechanical', 'plan', 'review', 'summarize', 'test',
  ]);
});

test('unknown job throws listing valid jobs', () => {
  assert.throws(() => go(reg({ a: inst() }, [mod('a', 'm', 2)]), { job: 'nope' }), /unknown job "nope".*plan.*review/);
});

test('author minTier requires authorTier', () => {
  const r = reg({ a: inst() }, [mod('a', 'm', 2)]);
  assert.throws(() => go(r, { job: 'fix' }), /authorTier/);
  assert.throws(() => go(r, { job: 'fix', authorTier: 5 }), /authorTier/);
  assert.deepEqual(keys(go(r, { job: 'fix', authorTier: 2 })), ['a::m']);
});

test('eligibility: tier floor', () => {
  const r = reg({ a: inst() }, [mod('a', 'low', 1), mod('a', 'mid', 2), mod('a', 'top', 4)]);
  assert.deepEqual(keys(go(r, { job: 'implement-complex' })), ['a::top']);
});

test('eligibility: disabled instance, missing instance, unavailable model', () => {
  const r = reg({ a: inst({ enabled: false }), b: inst() }, [
    mod('a', 'm', 2), mod('ghost', 'm', 2), mod('b', 'gone', 2, { available: false }), mod('b', 'ok', 2),
  ]);
  assert.deepEqual(keys(go(r)), ['b::ok']);
});

test('eligibility: cooldowns honoured, expired ones ignored', () => {
  const r = reg({ a: inst({ cooldownUntil: 2000 }), b: inst(), c: inst({ cooldownUntil: 1000 }) }, [
    mod('a', 'm', 2), mod('b', 'hot', 2, { cooldownUntil: 1500 }), mod('b', 'cool', 2, { cooldownUntil: 999 }), mod('c', 'm', 2),
  ]);
  assert.deepEqual(keys(go(r)), ['b::cool', 'c::m']);
});

test('eligibility: concurrency limit and exclude', () => {
  const r = reg({ a: inst({ limit: 1 }), b: inst() }, [mod('a', 'm', 2), mod('b', 'x', 2), mod('b', 'y', 2)]);
  assert.deepEqual(keys(go(r, { running: { a: 1 }, exclude: ['b::x'] })), ['b::y']);
});

test('ordering: tier, then load, then lastUsedAt (never first), then key', () => {
  const r = reg({ a: inst({ limit: 5 }), b: inst({ limit: 5 }) }, [
    mod('a', 'hi', 3), mod('a', 'z', 2, { lastUsedAt: 5 }), mod('a', 'y', 2, { lastUsedAt: 1 }),
    mod('b', 'q', 2), mod('b', 'p', 2),
  ]);
  assert.deepEqual(keys(go(r, { running: { a: 2, b: 1 } })), ['b::p', 'b::q', 'a::y', 'a::z', 'a::hi']);
  assert.deepEqual(keys(go(r, { running: {} })), ['b::p', 'b::q', 'a::y', 'a::z', 'a::hi']);
});

test('candidate shape and confirmed flag', () => {
  const r = reg({ a: inst() }, [mod('a', 'm', 2, { confirmedAt: 7 }), mod('a', 'n', 2)]);
  const out = go(r);
  assert.deepEqual(out.candidates[0], { key: 'a::m', instance: 'a', model: 'm', tier: 2, family: 'fam-a', confirmed: true });
  assert.equal(out.candidates[1].confirmed, false);
  assert.equal(out.retryAt, null);
});

test('differentFamily: other families first, same and unknown flagged and kept', () => {
  const r = reg({ a: inst() }, [
    mod('a', 'same', 2, { family: 'fam-a' }), mod('a', 'unk', 2, { family: 'unknown' }),
    mod('a', 'other', 3, { family: 'fam-b' }),
  ]);
  const out = go(r, { job: 'review', authorTier: 2, authorFamily: 'fam-a' });
  assert.deepEqual(keys(out), ['a::other', 'a::same', 'a::unk']);
  assert.equal(out.candidates[0].sameFamily, undefined);
  assert.equal(out.candidates[1].sameFamily, true);
  assert.equal(out.candidates[2].sameFamily, true);
});

test('below tier: best available flagged when nothing reaches the floor', () => {
  const r = reg({ a: inst() }, [mod('a', 'low', 1), mod('a', 'mid', 2), mod('a', 'mid2', 2)]);
  const out = go(r, { job: 'plan' });
  assert.equal(out.reason, 'no model at tier 4; using best available');
  assert.deepEqual(keys(out), ['a::mid', 'a::mid2']);
  assert.ok(out.candidates.every((c) => c.belowTier === true));
});

test('below tier does not apply when a cooling model reaches the floor', () => {
  const r = reg({ a: inst() }, [mod('a', 'top', 4, { cooldownUntil: 5000 }), mod('a', 'mid', 2)]);
  const out = go(r, { job: 'plan' });
  assert.deepEqual(out.candidates, []);
  assert.equal(out.reason, 'all cooling down');
  assert.equal(out.retryAt, 5000);
});

test('blocked reasons: cooling (earliest retry), limit, excluded', () => {
  const cool = reg({ a: inst({ cooldownUntil: 3000 }), b: inst() }, [mod('a', 'm', 2), mod('b', 'm', 2, { cooldownUntil: 2500 })]);
  const c = go(cool);
  assert.deepEqual([c.reason, c.retryAt], ['all cooling down', 2500]);
  const lim = go(reg({ a: inst({ limit: 1 }) }, [mod('a', 'm', 2)]), { running: { a: 1 } });
  assert.deepEqual([lim.reason, lim.retryAt, lim.candidates], ['all at concurrency limit', null, []]);
  const ex = go(reg({ a: inst() }, [mod('a', 'm', 2)]), { exclude: ['a::m'] });
  assert.deepEqual([ex.reason, ex.retryAt], ['all excluded', null]);
});

test('retryAt waits for both model and instance cooldown', () => {
  const r = reg({ a: inst({ cooldownUntil: 3000 }) }, [mod('a', 'm', 2, { cooldownUntil: 2000 })]);
  assert.equal(go(r).retryAt, 3000);
});

test('no usable model in registry', () => {
  const out = go(reg({ a: inst({ enabled: false }) }, [mod('a', 'm', 2)]));
  assert.deepEqual(out, { candidates: [], blocked: 'empty', reason: 'no usable model in registry; run sync', retryAt: null });
  assert.equal(go(reg({}, [])).reason, 'no usable model in registry; run sync');
});

test('determinism and no mutation', () => {
  const r = deepFreeze(reg({ a: inst(), b: inst() }, [mod('a', 'm', 2), mod('b', 'm', 2), mod('b', 'n', 3)]));
  const args = { registry: r, rules: deepFreeze(structuredClone(rules)), job: 'implement', now: 1000, running: deepFreeze({ a: 1 }), exclude: deepFreeze([]) };
  const first = route(args);
  assert.deepEqual(route(args), first);
  assert.deepEqual(route(args), first);
});

test('blocked codes: null, cooling, limit, excluded, mixed, empty', () => {
  assert.equal(go(reg({ a: inst() }, [mod('a', 'm', 2)])).blocked, null);
  assert.equal(go(reg({ a: inst() }, [mod('a', 'm', 2, { cooldownUntil: 5000 })])).blocked, 'cooling');
  assert.equal(go(reg({ a: inst({ limit: 1 }) }, [mod('a', 'm', 2)]), { running: { a: 1 } }).blocked, 'limit');
  assert.equal(go(reg({ a: inst() }, [mod('a', 'm', 2)]), { exclude: ['a::m'] }).blocked, 'excluded');
  const mixed = go(reg({ a: inst() }, [mod('a', 'm', 2, { cooldownUntil: 5000 }), mod('a', 'n', 2)]), { exclude: ['a::n'] });
  assert.equal(mixed.blocked, 'mixed');
  assert.equal(go(reg({}, [])).blocked, 'empty');
});

test('ordering: load alone decides between same-tier models on different instances', () => {
  const r = reg({ a: inst({ limit: 9 }), b: inst({ limit: 9 }) }, [mod('a', 'm', 2), mod('b', 'm', 2)]);
  assert.deepEqual(keys(go(r, { running: { a: 3, b: 1 } })), ['b::m', 'a::m']);
  assert.deepEqual(keys(go(r, { running: { a: 1, b: 3 } })), ['a::m', 'b::m']);
});

test('ordering: lastUsedAt alone decides, never-used first', () => {
  const r = reg({ a: inst(), b: inst() }, [mod('a', 'm', 2, { lastUsedAt: 50 }), mod('b', 'm', 2, { lastUsedAt: 10 }), mod('c', 'm', 2)]);
  r.instances.c = inst();
  assert.deepEqual(keys(go(r)), ['c::m', 'b::m', 'a::m']);
});

test('differentFamily job without authorFamily throws', () => {
  const r = reg({ a: inst() }, [mod('a', 'm', 2)]);
  assert.throws(() => go(r, { job: 'review', authorTier: 2 }), /job "review" needs authorFamily \(use "unknown" if not known\)/);
});

test('a rejected (unavailable) model is not routable', () => {
  const r = reg({ a: inst() }, [mod('a', 'm', 2, { available: false, rejectedAt: 5 }), mod('a', 'n', 2)]);
  assert.deepEqual(keys(go(r)), ['a::n']);
});

test('instance limit null uses defaultLimit; a number is an explicit override', () => {
  const r = reg({ a: inst({ limit: null }), b: inst({ limit: 3 }) }, [mod('a', 'm', 2), mod('b', 'm', 2)]);
  assert.deepEqual(keys(go(r, { running: { a: 1, b: 2 }, defaultLimit: 1 })), ['b::m']);
  assert.deepEqual(keys(go(r, { running: { a: 1, b: 2 }, defaultLimit: 2 })), ['a::m', 'b::m']);
  assert.deepEqual(keys(go(r, { running: { a: 1 } })), ['b::m', 'a::m']);
  assert.deepEqual(keys(go(r, { running: { a: 2 } })), ['b::m']);
  assert.equal(go(r, { running: { a: 1, b: 3 }, defaultLimit: 1 }).blocked, 'limit');
});

test('atLeast raises the minimum tier and never lowers it', () => {
  const r = reg({ a: inst() }, [mod('a', 'm2', 2), mod('a', 'm3', 3), mod('a', 'm4', 4)]);
  assert.deepEqual(keys(go(r, { atLeast: 3 })), ['a::m3', 'a::m4']);
  assert.deepEqual(keys(go(r, { atLeast: 1 })), ['a::m2', 'a::m3', 'a::m4']);
  assert.equal(go(reg({ a: inst() }, [mod('a', 'm2', 2)]), { atLeast: 4 }).candidates[0].belowTier, true);
});

test('avoidInstances outranks tier; avoided-only candidates are still returned and flagged', () => {
  const r = reg({ a: inst(), b: inst() }, [mod('a', 'm2', 2), mod('a', 'm3', 3), mod('b', 'm4', 4), mod('b', 'm3', 3)]);
  assert.deepEqual(keys(go(r, { avoidInstances: ['a'] })), ['b::m3', 'b::m4', 'a::m2', 'a::m3']);
  assert.deepEqual(go(r, { avoidInstances: ['a'] }).candidates.map((c) => Boolean(c.avoided)), [false, false, true, true]);
  assert.deepEqual(keys(go(r)), ['a::m2', 'a::m3', 'b::m3', 'b::m4']);
  assert.deepEqual(keys(go(r, { avoidInstances: [] })), keys(go(r)));
  const only = go(r, { avoidInstances: ['a', 'b'] });
  assert.deepEqual(keys(only), keys(go(r)));
  assert.ok(only.candidates.every((c) => c.avoided === true));
  assert.deepEqual(go(r, { avoidInstances: ['a'] }), go(r, { avoidInstances: ['a'] }));
});

test('avoidKeys: a model that failed this unit goes last, behind one only on a failed instance; never excluded', () => {
  const r = reg({ a: inst(), b: inst() }, [mod('a', 'm2', 2), mod('a', 'm3', 3), mod('b', 'm4', 4)]);
  assert.deepEqual(keys(go(r, { avoidKeys: ['a::m2'], avoidInstances: ['a'] })), ['b::m4', 'a::m3', 'a::m2']);
  const one = reg({ a: inst() }, [mod('a', 'm2', 2)]);
  const only = go(one, { avoidKeys: ['a::m2'] });
  assert.deepEqual([keys(only), only.candidates[0].avoided], [['a::m2'], true]);
});

test('decide: routing.json asks for tier 4 and the strongest model', () => {
  assert.deepEqual(rules.jobs.decide, { minTier: 4, strongest: true });
});

test('strongest: highest tier first, then the usual order; best available below tier 4; health rules apply', () => {
  const strong = { jobs: { x: { minTier: 1, strongest: true }, decide: rules.jobs.decide } };
  const r = reg({ a: inst(), b: inst() }, [mod('a', 'm2', 2), mod('b', 'm4', 4), mod('a', 'm3', 3), mod('b', 'n4', 4, { lastUsedAt: 5 })]);
  assert.deepEqual(keys(go(r, { rules: strong, job: 'x' })), ['b::m4', 'b::n4', 'a::m3', 'a::m2']);
  const no4 = reg({ a: inst() }, [mod('a', 'm2', 2), mod('a', 'm3', 3)]);
  const below = go(no4, { rules: strong, job: 'decide' });
  assert.deepEqual([keys(below), below.candidates[0].belowTier], [['a::m3'], true]);
  const cooling = reg({ a: inst(), b: inst() }, [mod('a', 'm4', 4, { cooldownUntil: 5000 }), mod('b', 'm4', 4)]);
  assert.deepEqual(keys(go(cooling, { rules: strong, job: 'decide' })), ['b::m4']);
  const off = reg({ a: inst(), b: inst({ enabled: false }) }, [mod('a', 'm3', 3), mod('b', 'm4', 4)]);
  assert.deepEqual(keys(go(off, { rules: strong, job: 'decide' })), ['a::m3']);
});

test('strongest: when every top-tier model is cooling or at its limit, the strongest free model is used', () => {
  const strong = { jobs: { decide: rules.jobs.decide } };
  const r = reg({ a: inst(), b: inst({ limit: 1 }) }, [mod('a', 'm4', 4, { cooldownUntil: 5000 }), mod('b', 'n4', 4), mod('a', 'm2', 2), mod('b', 'm3', 3)]);
  const got = go(r, { rules: strong, job: 'decide', running: { b: 1 } });
  assert.deepEqual([keys(got), got.candidates[0].belowTier, got.candidates[0].wantedTier], [['a::m2'], true, 4]);
  const free3 = go(reg({ a: inst(), b: inst() }, [mod('a', 'm4', 4, { cooldownUntil: 5000 }), mod('b', 'm3', 3), mod('b', 'm2', 2)]), { rules: strong, job: 'decide' });
  assert.deepEqual(keys(free3), ['b::m3', 'b::m2']);
  const nothing = go(reg({ a: inst() }, [mod('a', 'm4', 4, { cooldownUntil: 5000 }), mod('a', 'm2', 2, { cooldownUntil: 6000 })]), { rules: strong, job: 'decide' });
  assert.deepEqual([nothing.candidates, nothing.blocked, nothing.retryAt], [[], 'cooling', 5000]);
  // other jobs keep waiting for their tier
  assert.equal(go(r, { job: 'plan', running: { b: 1 } }).candidates.length, 0);
});
