import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyRegistry, modelKey, validateCapabilities, mergeCapabilities, harvestThreads,
  setTier, addModel,
} from '../lib/registry.mjs';
import {
  recordSuccess, recordFailure, markUsed, backoff, markAlive,
} from '../lib/health.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const caps = read('./fixtures/capabilities.json');
const suggestions = read('../playbook/suggestions.json');
const MIN = 60_000;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}
const provider = (id, models, constraints = []) => ({ providerInstanceId: id, driverKind: 'k', displayName: id, models, constraints });
const merge = (reg, c, now = 1000) => mergeCapabilities(deepFreeze(structuredClone(reg)), deepFreeze(structuredClone(c)), { now, suggestions });
const synced = () => merge(emptyRegistry(), caps).registry;

test('emptyRegistry and modelKey', () => {
  assert.deepEqual(emptyRegistry(), { version: 1, syncedAt: null, instances: {}, models: {} });
  assert.equal(modelKey('a', 'b'), 'a::b');
});

test('validateCapabilities: shape errors', () => {
  assert.throws(() => validateCapabilities(null), /providers array/);
  assert.throws(() => validateCapabilities({}), /providers array/);
  assert.throws(() => validateCapabilities({ providers: [{ models: [] }] }), /providerInstanceId/);
  assert.throws(() => validateCapabilities({ providers: [{ providerInstanceId: 'a' }] }), /models/);
  assert.doesNotThrow(() => validateCapabilities(caps));
});

test('validateCapabilities: truncated or compressed', () => {
  const msg = /truncated or compressed; read them again/;
  assert.throws(() => validateCapabilities({ providers: [] }), msg);
  assert.throws(() => validateCapabilities({ providers: [provider('a', ['<<12 rows>>'])] }), msg);
  assert.throws(() => validateCapabilities({ providers: [provider('a', [])], note: { deep: ['x <<omitted>> y'] } }), msg);
});

test('merge fixture: instances, models, diff', () => {
  const { registry, diff } = merge(emptyRegistry(), caps, 5000);
  assert.equal(registry.syncedAt, 5000);
  assert.deepEqual(diff.instancesAdded, ['provider-e', 'provider-f', 'provider-g']);
  assert.deepEqual(diff.instancesDisabled, []);
  assert.equal(registry.instances['provider-e'].enabled, true);
  assert.equal(registry.instances['provider-g'].enabled, false);
  assert.deepEqual(registry.instances['provider-g'].constraints, ['Provider instance is disabled.']);
  assert.deepEqual(registry.instances['provider-e'], {
    driverKind: 'codex', displayName: 'Provider Display Name', enabled: true, constraints: [],
    limit: null, failures: 0, cooldownUntil: null, lastSeenAt: 5000,
  });
  const m = registry.models['provider-e::model-small'];
  assert.equal(m.source, 'capabilities');
  assert.equal(m.available, true);
  assert.equal(m.tier, 1);
  assert.equal(m.tierSource, 'suggested');
  assert.equal(Object.keys(registry.models).filter((k) => k.startsWith('provider-e::')).length, 1);
  assert.deepEqual(diff.modelsAdded, [...diff.modelsAdded].sort());
});

test('merge: existing limit, failures, cooldown preserved', () => {
  const reg = synced();
  reg.instances['provider-e'] = { ...reg.instances['provider-e'], limit: 5, failures: 2, cooldownUntil: 99 };
  const { registry } = merge(reg, caps, 2000);
  const i = registry.instances['provider-e'];
  assert.deepEqual([i.limit, i.failures, i.cooldownUntil, i.lastSeenAt], [5, 2, 99, 2000]);
});

test('merge: absent instance disabled, models kept; re-enable diff', () => {
  const reg = synced();
  const partial = { providers: [caps.providers[0], caps.providers[1]] };
  const a = merge(reg, partial);
  assert.deepEqual(a.diff.instancesDisabled, []);
  assert.deepEqual(a.registry.instances['provider-g'].constraints, ['not reported by T3']);
  assert.equal(a.registry.instances['provider-e'].enabled, true);
  const only = merge(reg, { providers: [caps.providers[0]] });
  assert.deepEqual(only.diff.instancesDisabled, ['provider-f']);
  assert.deepEqual(only.registry.instances['provider-f'].constraints, ['not reported by T3']);
  assert.ok(only.registry.models['provider-f::model-small']);
  const back = merge(only.registry, { providers: [caps.providers[0], caps.providers[1]] });
  assert.deepEqual(back.diff.instancesEnabled, ['provider-f']);
  assert.equal(back.registry.instances['provider-f'].enabled, true);
});

test('merge: tier source precedence', () => {
  const key = 'provider-e::model-small';
  let reg = setTier(synced(), key, 4, 'user').registry;
  assert.equal(merge(reg, caps).registry.models[key].tier, 4);
  reg = synced();
  reg.models[key] = { ...reg.models[key], tier: 2, tierSource: 'inferred' };
  const m = merge(reg, caps).registry.models[key];
  assert.deepEqual([m.tier, m.tierSource], [1, 'suggested']);
  reg.models[key] = { ...reg.models[key], tier: 3, tierSource: 'orchestrator' };
  assert.equal(merge(reg, caps).registry.models[key].tier, 3);
});

test('merge: unlisted models become unavailable except user/history', () => {
  const first = merge(emptyRegistry(), { providers: [provider('a', ['m-one', 'm-two', 'm-three', 'm-four'])] }).registry;
  first.models['a::m-three'].source = 'user';
  first.models['a::m-four'].source = 'history';
  const { registry, diff } = merge(first, { providers: [provider('a', ['m-one'])] });
  assert.equal(registry.models['a::m-one'].available, true);
  assert.equal(registry.models['a::m-two'].available, false);
  assert.equal(registry.models['a::m-three'].available, true);
  assert.equal(registry.models['a::m-four'].available, true);
  assert.deepEqual(diff.modelsUnavailable, ['a::m-two']);
  const again = merge(registry, { providers: [provider('a', ['m-one', 'm-two'])] }).registry;
  assert.equal(again.models['a::m-two'].available, true);
});

test('merge: empty model list leaves models untouched', () => {
  const first = merge(emptyRegistry(), { providers: [provider('a', ['m-one'])] }).registry;
  const { registry, diff } = merge(first, { providers: [provider('a', [])] });
  assert.equal(registry.models['a::m-one'].available, true);
  assert.deepEqual(diff.modelsUnavailable, []);
});

test('merge: string model ids accepted', () => {
  const { registry } = merge(emptyRegistry(), { providers: [provider('a', ['claude-opus-x'])] });
  assert.equal(registry.models['a::claude-opus-x'].family, 'anthropic');
});

test('harvestThreads', () => {
  const reg = synced();
  const threads = [
    { status: 'completed', instance: 'provider-e', model: 'model-small', updatedAt: 500 },
    { status: 'completed', instance: 'provider-e', model: 'model-small', updatedAt: 300 },
    { status: 'completed', instance: 'provider-e', model: 'hist-model', updatedAt: 400 },
    { status: 'failed', instance: 'provider-e', model: 'failed-model', updatedAt: 400 },
    { status: 'completed', instance: 'nope', model: 'x', updatedAt: 400 },
    { status: 'completed', instance: null, model: 'x', updatedAt: 400 },
  ];
  const out = harvestThreads(deepFreeze(structuredClone(reg)), deepFreeze(threads), { suggestions });
  assert.equal(out.models['provider-e::model-small'].confirmedAt, 500);
  assert.equal(out.models['provider-e::model-small'].source, 'capabilities');
  assert.equal(out.models['provider-e::hist-model'].source, 'history');
  assert.equal(out.models['provider-e::hist-model'].confirmedAt, 400);
  assert.equal(out.models['provider-e::failed-model'], undefined);
  assert.equal(out.models['nope::x'], undefined);
});

test('setTier: validation, precedence, unknown key', () => {
  const reg = synced();
  const key = 'provider-e::model-small';
  assert.throws(() => setTier(reg, key, 5, 'user'), /1-4/);
  assert.throws(() => setTier(reg, key, 2.5, 'user'), /1-4/);
  assert.throws(() => setTier(reg, 'nope', 2, 'user'), /unknown model key/);
  const o = setTier(reg, key, 3, 'orchestrator').registry;
  assert.deepEqual([o.models[key].tier, o.models[key].tierSource], [3, 'orchestrator']);
  assert.equal(setTier(o, key, 2, 'suggested').registry.models[key].tier, 3);
  assert.equal(setTier(o, key, 2, 'suggested').applied, false);
  assert.equal(setTier(o, key, 2, 'orchestrator').applied, true);
  assert.equal(setTier(o, key, 2, 'orchestrator').registry.models[key].tier, 2);
  assert.equal(setTier(o, key, 4, 'user').registry.models[key].tierSource, 'user');
});

test('backoff values and cap', () => {
  assert.equal(backoff(1), 10 * MIN);
  assert.equal(backoff(2), 20 * MIN);
  assert.equal(backoff(3), 40 * MIN);
  assert.equal(backoff(20), 300 * MIN);
});

test('recordFailure: model backoff, instance cooldown from the second consecutive failure', () => {
  const key = 'provider-e::model-small';
  let reg = deepFreeze(synced());
  reg = recordFailure(reg, key, { now: 1000, jobClass: 'implement', kind: 'provider' });
  assert.equal(reg.models[key].failures, 1);
  assert.equal(reg.models[key].cooldownUntil, 1000 + 10 * MIN);
  assert.equal(reg.instances['provider-e'].cooldownUntil, null);
  assert.deepEqual(reg.models[key].outcomes.implement, { attempts: 1, firstPass: 0 });
  reg = recordFailure(reg, key, { now: 2000, kind: 'provider' });
  assert.equal(reg.models[key].cooldownUntil, 2000 + 20 * MIN);
  assert.equal(reg.instances['provider-e'].cooldownUntil, 2000 + 10 * MIN);
  reg = recordFailure(reg, key, { now: 3000, kind: 'provider' });
  assert.equal(reg.instances['provider-e'].failures, 3);
  assert.equal(reg.instances['provider-e'].cooldownUntil, 3000 + 20 * MIN);
});

test('recordSuccess resets model and instance, counts outcomes', () => {
  const key = 'provider-e::model-small';
  let reg = synced();
  reg = recordFailure(reg, key, { now: 1, kind: 'provider' });
  reg = recordFailure(reg, key, { now: 2, kind: 'provider' });
  reg = recordFailure(reg, key, { now: 3, kind: 'provider' });
  reg = recordSuccess(deepFreeze(reg), key, { now: 9000, jobClass: 'test', firstPass: true });
  assert.deepEqual(
    [reg.models[key].failures, reg.models[key].cooldownUntil, reg.models[key].confirmedAt, reg.models[key].lastUsedAt],
    [0, null, 9000, 9000],
  );
  assert.deepEqual([reg.instances['provider-e'].failures, reg.instances['provider-e'].cooldownUntil], [0, null]);
  assert.deepEqual(reg.models[key].outcomes.test, { attempts: 1, firstPass: 1 });
  reg = recordSuccess(reg, key, { now: 9100, jobClass: 'test', firstPass: false });
  assert.deepEqual(reg.models[key].outcomes.test, { attempts: 2, firstPass: 1 });
});

test('markUsed and unknown keys', () => {
  const key = 'provider-e::model-small';
  const reg = deepFreeze(synced());
  assert.equal(markUsed(reg, key, 77).models[key].lastUsedAt, 77);
  assert.equal(reg.models[key].lastUsedAt, null);
  assert.throws(() => markUsed(reg, 'x::y', 1), /unknown model key/);
  assert.throws(() => recordFailure(reg, 'x::y', { now: 1 }), /unknown model key/);
  assert.throws(() => recordSuccess(reg, 'x::y', { now: 1 }), /unknown model key/);
});

test('merge refreshes suggested tier and family; user tier is protected', () => {
  const key = 'provider-e::model-small';
  const reg = synced();
  reg.models['provider-e::other'] = { ...reg.models[key], model: 'other', tier: 3, tierSource: 'user', family: 'mine' };
  const next = { ...suggestions, families: [{ match: 'model', family: 'newfam' }, ...suggestions.families], tiers: [{ match: 'small|other', tier: 4 }] };
  const c = { providers: [provider('provider-e', ['model-small', 'other'])] };
  const out = mergeCapabilities(reg, c, { now: 1, suggestions: next }).registry;
  assert.deepEqual([out.models[key].tier, out.models[key].family], [4, 'newfam']);
  assert.deepEqual([out.models['provider-e::other'].tier, out.models['provider-e::other'].family], [3, 'mine']);
  const h = harvestThreads(reg, [{ status: 'completed', instance: 'provider-e', model: 'model-small', updatedAt: 9 }], { suggestions: next });
  assert.equal(h.models[key].tier, 4);
});

test('merge never overwrites orchestrator tier but refreshes its family', () => {
  const key = 'provider-e::model-small';
  const reg = setTier(synced(), key, 3, 'orchestrator').registry;
  const next = { ...suggestions, families: [{ match: 'model', family: 'newfam' }] };
  const m = mergeCapabilities(reg, caps, { now: 1, suggestions: next }).registry.models[key];
  assert.deepEqual([m.tier, m.family], [3, 'newfam']);
});

test('recordFailure kinds', () => {
  const key = 'provider-e::model-small';
  const base = synced();
  assert.throws(() => recordFailure(base, key, { now: 1, kind: 'bogus' }), /failure kind/);
  const r = recordFailure(base, key, { now: 1, jobClass: 'x', kind: 'model-rejected' });
  assert.deepEqual([r.models[key].available, r.models[key].failures, r.models[key].cooldownUntil], [false, 1, null]);
  assert.equal(r.instances['provider-e'].failures, 0);
  assert.equal(r.models[key].outcomes.x.attempts, 1);
  const p = recordFailure(base, key, { now: 1, kind: 'provider' });
  assert.deepEqual([p.models[key].cooldownUntil, p.instances['provider-e'].failures], [1 + 10 * MIN, 1]);
  const u = recordFailure(base, key, { now: 1 });
  assert.deepEqual([u.models[key].cooldownUntil, u.instances['provider-e'].failures], [1 + 10 * MIN, 1]);
  const confirmed = harvestThreads(base, [{ status: 'completed', instance: 'provider-e', model: 'model-small', updatedAt: 5 }], { suggestions });
  assert.equal(recordFailure(confirmed, key, { now: 1 }).instances['provider-e'].failures, 1);
});

test('two consecutive failures on an instance cool it down, confirmed or not', () => {
  const c = { providers: [provider('a', ['m-1', 'm-2', 'm-3'])] };
  const reg = deepFreeze(merge(emptyRegistry(), c).registry);
  const one = recordFailure(reg, 'a::m-1', { now: 10 });
  assert.deepEqual([one.instances.a.failures, one.instances.a.cooldownUntil], [1, null]);
  const two = recordFailure(one, 'a::m-2', { now: 20, kind: 'provider' });
  assert.deepEqual([two.instances.a.failures, two.instances.a.cooldownUntil], [2, 20 + 10 * MIN]);
  const three = recordFailure(two, 'a::m-3', { now: 30 });
  assert.equal(three.instances.a.cooldownUntil, 30 + 20 * MIN);
  const healed = recordFailure(recordSuccess(one, 'a::m-3', { now: 15 }), 'a::m-2', { now: 20 });
  assert.deepEqual([healed.instances.a.failures, healed.instances.a.cooldownUntil], [1, null]);
  const rejected = recordFailure(recordFailure(reg, 'a::m-1', { now: 10, kind: 'model-rejected' }), 'a::m-2', { now: 20, kind: 'model-rejected' });
  assert.deepEqual([rejected.instances.a.failures, rejected.instances.a.cooldownUntil], [0, null]);
});

test('addModel: validation, creation, existing entries', () => {
  const reg = deepFreeze(synced());
  const arg = { instance: 'provider-e', model: 'mine', tier: 4, source: 'user' };
  assert.throws(() => addModel(reg, { ...arg, source: 'suggested' }, { suggestions }), /source/);
  assert.throws(() => addModel(reg, { ...arg, instance: 'nope' }, { suggestions }), /unknown instance/);
  assert.throws(() => addModel(reg, { ...arg, tier: 9 }, { suggestions }), /1-4/);
  const m = addModel(reg, arg, { suggestions }).models['provider-e::mine'];
  assert.deepEqual([m.source, m.tier, m.tierSource, m.available], ['user', 4, 'user', true]);
  const n = addModel(reg, { instance: 'provider-e', model: 'plain-pro', source: 'orchestrator' }, { suggestions }).models['provider-e::plain-pro'];
  assert.deepEqual([n.source, n.tier, n.tierSource], ['orchestrator', 3, 'suggested']);
  const gone = { ...reg, models: { ...reg.models, 'provider-e::model-small': { ...reg.models['provider-e::model-small'], available: false } } };
  const back = addModel(gone, { instance: 'provider-e', model: 'model-small', source: 'user' }, { suggestions }).models['provider-e::model-small'];
  assert.deepEqual([back.available, back.source, back.tier], [true, 'user', 1]);
});

test('rejected models stay unavailable across merges until cleared', () => {
  const key = 'provider-e::model-small';
  const rejected = recordFailure(synced(), key, { now: 42, kind: 'model-rejected' });
  assert.equal(rejected.models[key].rejectedAt, 42);
  assert.equal(synced().models[key].rejectedAt, null);
  const again = merge(rejected, caps, 50).registry;
  assert.equal(again.models[key].available, false);
  assert.equal(again.models[key].rejectedAt, 42);
  const cleared = addModel(rejected, { instance: 'provider-e', model: 'model-small', source: 'user' }, { suggestions });
  assert.deepEqual([cleared.models[key].available, cleared.models[key].rejectedAt], [true, null]);
  const ok = recordSuccess(rejected, key, { now: 60 });
  assert.deepEqual([ok.models[key].available, ok.models[key].rejectedAt], [true, null]);
  assert.equal(merge(ok, caps, 70).registry.models[key].available, true);
});

test('markAlive resets the instance only; failure, alive, failure is not two in a row', () => {
  const c = { providers: [provider('a', ['m-1', 'm-2'])] };
  const one = recordFailure(merge(emptyRegistry(), c).registry, 'a::m-1', { now: 10 });
  const alive = markAlive(deepFreeze(recordFailure(one, 'a::m-2', { now: 20 })), 'a::m-2', 30);
  assert.deepEqual([alive.instances.a.failures, alive.instances.a.cooldownUntil], [0, null]);
  assert.deepEqual([alive.models['a::m-2'].failures, alive.models['a::m-2'].cooldownUntil], [1, 20 + 10 * MIN]);
  const again = recordFailure(markAlive(one, 'a::m-1', 15), 'a::m-2', { now: 40 });
  assert.deepEqual([again.instances.a.failures, again.instances.a.cooldownUntil], [1, null]);
});
