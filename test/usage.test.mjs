import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { instanceUsage, withUsage } from '../lib/usage.mjs';
import { readUsage } from '../lib/usage-source.mjs';
import { usageLine } from '../lib/providers.mjs';
import { route } from '../lib/route.mjs';

// Real T3 provider status caches ($T3CODE_HOME/caches/<instance>.json), redacted to status, auth status and usageLimits.
const cache = (id) => JSON.parse(readFileSync(new URL(`./fixtures/t3-caches/${id}.json`, import.meta.url), 'utf8'));
const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-16T20:10:00Z');
const H = 3600_000;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

test('instanceUsage reads the windows of a T3 provider snapshot', () => {
  assert.deepEqual(instanceUsage(cache('codex'), NOW), {
    checkedAt: Date.parse('2026-11-16T20:02:19.101Z'), down: false, stale: false,
    windows: [{ id: 'primary', used: 100, resetAt: Date.parse('2026-11-19T19:38:58.000Z') }],
  });
  assert.equal(instanceUsage(cache('antigravity'), NOW).windows.length, 5);
  assert.deepEqual(instanceUsage(cache('kimi'), NOW).windows, []); // no usage reported: unknown
  assert.deepEqual(instanceUsage(cache('durindoor-api'), NOW).windows, []); // probe failed: unknown
  assert.equal(instanceUsage(null, NOW), null);
});

test('instanceUsage: an errored or signed-out instance is down, only while its snapshot is fresh', () => {
  assert.equal(instanceUsage(cache('codex-2'), NOW).down, true);
  assert.equal(instanceUsage({ ...cache('codex'), status: 'error' }, NOW).down, true);
  assert.equal(instanceUsage({ ...cache('codex'), auth: { status: 'unauthenticated' } }, NOW).down, true);
  assert.equal(instanceUsage(cache('codex-2'), Date.parse('2026-11-16T20:02:18.481Z') + H + 1).down, false);
  const { checkedAt: _c, ...undated } = cache('codex-2');
  assert.equal(instanceUsage(undated, NOW).down, false);
});

test('instanceUsage: no checkedAt, or one over an hour ahead, is stale; a little ahead is fresh', () => {
  const c = cache('codex');
  const { checkedAt: _c, ...limits } = c.usageLimits;
  assert.deepEqual([instanceUsage({ ...c, usageLimits: limits }, NOW).stale, instanceUsage({ ...c, usageLimits: limits }, NOW).windows], [true, []]);
  const at = (t) => instanceUsage({ ...c, usageLimits: { ...c.usageLimits, checkedAt: new Date(t).toISOString() } }, NOW);
  assert.equal(at(NOW + 60_000).stale, false);
  assert.equal(at(NOW + H + 1).stale, true);
});

test('instanceUsage: a resetsAt without a zone is UTC; malformed usageLimits are unreadable; none is nothing', () => {
  const c = cache('codex');
  const local = { ...c, usageLimits: { ...c.usageLimits, windows: [{ id: 'p', usedPercent: 50, resetsAt: '2026-11-19T19:38:58' }] } };
  assert.equal(instanceUsage(local, NOW).windows[0].resetAt, Date.parse('2026-11-19T19:38:58Z'));
  assert.equal(instanceUsage({ ...c, usageLimits: { checkedAt: c.usageLimits.checkedAt, windows: 'x' } }, NOW).unreadable, true);
  assert.equal(instanceUsage({ ...c, usageLimits: 7 }, NOW).unreadable, true);
  assert.equal(instanceUsage(cache('kimi'), NOW).unreadable, undefined);
});

test('instanceUsage: a window past its reset is dropped; a reading over an hour old is stale', () => {
  assert.deepEqual(instanceUsage(cache('codex'), Date.parse('2026-11-19T19:39:00Z')).windows, []);
  const old = instanceUsage(cache('codex'), Date.parse('2026-11-16T20:02:19.101Z') + H + 1);
  assert.deepEqual([old.stale, old.windows], [true, []]);
});

const inst = (driverKind, over = {}) => ({ driverKind, enabled: true, constraints: [], limit: 2, failures: 0, cooldownUntil: null, ...over });
const mod = (instance, model, tier = 2) => [`${instance}::${model}`, {
  instance, model, family: 'f', tier, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null,
}];
const REG = deepFreeze({
  version: 1,
  instances: { codex: inst('codex'), cx: inst('codex'), ag: inst('antigravity') },
  models: Object.fromEntries([mod('codex', 'gpt-x'), mod('cx', 'gpt-x'), mod('ag', 'gemini-3-pro'), mod('ag', 'gemini-3-flash'), mod('ag', 'gemini-argon-1'), mod('ag', 'claude-sonnet'), mod('ag', 'gpt-oss')]),
});
const usage = (windows, over = {}) => ({ checkedAt: NOW, down: false, stale: false, windows, ...over });
const w = (id, used, resetAt = NOW + H) => ({ id, used, resetAt });

test('withUsage: no usage, the registry as it is', () => {
  assert.equal(withUsage(REG, {}, { now: NOW }), REG);
  assert.equal(withUsage(REG, { ghost: usage([w('p', 99)]) }, { now: NOW }), REG);
});

test('withUsage: at the threshold a model cools until the reset; two full windows wait for the later reset', () => {
  const v = withUsage(REG, { codex: usage([w('session', 95, NOW + H), w('weekly', 100, NOW + 50 * H)]), cx: usage([w('p', 40)]) }, { now: NOW });
  assert.equal(v.models['codex::gpt-x'].cooldownUntil, NOW + 50 * H);
  assert.equal(v.models['cx::gpt-x'].cooldownUntil, null);
  assert.equal(v.models['cx::gpt-x'].headroom, 0.6);
  assert.equal(REG.models['codex::gpt-x'].cooldownUntil, null); // input untouched (frozen)
  assert.equal(withUsage(REG, { cx: usage([w('p', 89)]) }, { now: NOW }).models['cx::gpt-x'].cooldownUntil, null);
  assert.equal(withUsage(REG, { cx: usage([w('p', 50)]) }, { now: NOW, threshold: 50 }).models['cx::gpt-x'].cooldownUntil, NOW + H);
  // full with no reset time: wait for the next reading
  assert.ok(withUsage(REG, { cx: usage([w('p', 100, null)]) }, { now: NOW }).models['cx::gpt-x'].cooldownUntil > NOW);
  // a longer failure cooldown already on the model is kept
  const longer = { ...REG, models: { ...REG.models, 'cx::gpt-x': { ...REG.models['cx::gpt-x'], cooldownUntil: NOW + 99 * H } } };
  assert.equal(withUsage(longer, { cx: usage([w('p', 100)]) }, { now: NOW }).models['cx::gpt-x'].cooldownUntil, NOW + 99 * H);
});

test('withUsage: antigravity windows apply to their model family, 3p to claude and gpt', () => {
  const v = withUsage(REG, { ag: instanceUsage(cache('antigravity-2'), NOW) }, { now: NOW });
  assert.equal(v.models['ag::gemini-3-pro'].cooldownUntil, Date.parse('2026-11-20T23:44:18.000Z'));
  assert.equal(v.models['ag::claude-sonnet'].cooldownUntil, null);
  assert.equal(v.models['ag::gpt-oss'].headroom, 1);
  const all = withUsage(REG, { ag: instanceUsage(cache('antigravity'), NOW) }, { now: NOW });
  assert.equal(all.models['ag::claude-sonnet'].cooldownUntil, Date.parse('2026-11-21T19:06:39.000Z')); // 3p-weekly 99.6%
  assert.equal(all.models['ag::gemini-3-pro'].cooldownUntil, Date.parse('2026-11-20T23:44:13.000Z')); // latest full gemini window
  // gemini-<x>-… binds only the models whose slug has <x>: argon full alone leaves gemini-3-flash free
  const argon = withUsage(REG, { ag: usage([w('gemini-argon-wtu-weekly', 100), w('gemini-weekly', 20), w('gemini-5h', 0)]) }, { now: NOW });
  assert.equal(argon.models['ag::gemini-3-flash'].cooldownUntil, null);
  assert.equal(argon.models['ag::gemini-3-flash'].headroom, 0.8);
  assert.equal(argon.models['ag::gemini-argon-1'].cooldownUntil, NOW + H);
});

test('withUsage: a down instance cools until the next reading; a stale one is unknown', () => {
  const down = withUsage(REG, { cx: usage([], { down: true }) }, { now: NOW });
  assert.ok(down.instances.cx.cooldownUntil > NOW);
  assert.equal(down.instances.cx.usage.down, true);
  const stale = withUsage(REG, { cx: usage([], { stale: true }) }, { now: NOW });
  assert.equal(stale.models['cx::gpt-x'].headroom, null);
  assert.equal(stale.instances.cx.cooldownUntil, null);
});

test('route skips the exhausted model, retries at its reset, and prefers the most headroom', () => {
  const go = (u) => route({ registry: withUsage(REG, u, { now: NOW }), rules, job: 'implement', now: NOW });
  const r = go({ codex: usage([w('p', 30)]), cx: usage([w('p', 80)]), ag: usage([w('gemini-weekly', 100), w('3p-weekly', 90, NOW + 2 * H)]) });
  assert.deepEqual(r.candidates.map((c) => c.key), ['codex::gpt-x', 'cx::gpt-x']);
  assert.equal(r.candidates[0].headroom, 0.7);
  const none = go({ codex: usage([w('p', 100)]), cx: usage([], { down: true }), ag: usage([w('gemini-weekly', 100), w('3p-weekly', 100)]) });
  assert.equal(none.blocked, 'cooling');
  assert.ok(none.retryAt > NOW && none.retryAt <= NOW + H);
});

async function t3home(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-t3home-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'caches'));
  for (const [id, text] of Object.entries(files)) await fs.writeFile(path.join(dir, 'caches', `${id}.json`), text);
  return dir;
}

test('readUsage: T3CODE_HOME, else the machine t3Home, else ~/.t3; a damaged file is unreadable', async (t) => {
  const dir = await t3home(t, { codex: JSON.stringify(cache('codex')), cx: '{damaged', ag: JSON.stringify(cache('kimi')) });
  const ctx = (env, home = '/nonexistent') => ({ env, now: () => NOW, deps: { homedir: () => home } });
  const u = await readUsage(ctx({ T3CODE_HOME: dir }), REG, {});
  assert.equal(u.dir, path.join(dir, 'caches'));
  assert.deepEqual(Object.keys(u.instances).sort(), ['ag', 'codex', 'cx']);
  assert.equal(u.instances.codex.windows[0].used, 100);
  assert.deepEqual(u.instances.cx, { unreadable: true });
  assert.equal((await readUsage(ctx({}), REG, { t3Home: dir })).dir, path.join(dir, 'caches'));
  const fallback = await readUsage(ctx({}, '/h'), REG, {});
  assert.deepEqual([fallback.dir, fallback.instances], [path.join('/h', '.t3', 'caches'), {}]);
});

test('readUsage reads a file again once when it does not parse (T3 may be writing it)', async (t) => {
  const dir = await t3home(t, { codex: JSON.stringify(cache('codex')) });
  let reads = 0;
  const readFile = async (f, enc) => { reads += 1; return reads === 1 ? '{"half' : fs.readFile(f, enc); };
  const u = await readUsage({ env: { T3CODE_HOME: dir }, now: () => NOW, deps: { readFile } }, { instances: { codex: inst('codex') }, models: {} }, {});
  assert.equal(u.instances.codex.windows[0].used, 100);
  assert.equal(reads, 2);
});

test('usageLine: windows, down, stale, unreadable; nothing applies, nothing; no file at all names the directory', () => {
  const line = (instances) => usageLine({ dir: '/t3/caches', instances });
  assert.deepEqual(line({
    a: usage([w('p', 99.6, Date.parse('2026-11-17T00:00:00Z'))]), b: usage([], { down: true }), c: usage([], { stale: true }), d: { unreadable: true }, e: usage([]),
  }), ['usage: a 100% p resets 2026-11-17T00:00:00.000Z; b down; c stale; d unreadable']);
  assert.deepEqual(line({ e: usage([]) }), []);
  assert.deepEqual(line({}), ['usage: no T3 provider cache in /t3/caches']);
});
