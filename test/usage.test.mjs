import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { instanceUsage, withUsage } from '../lib/usage.mjs';
import { readUsage } from '../lib/usage-source.mjs';
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
  assert.equal(instanceUsage({ usageLimits: { windows: 'x' } }, NOW).windows.length, 0); // malformed: nothing
});

test('instanceUsage: an errored or signed-out instance is down', () => {
  assert.equal(instanceUsage(cache('codex-2'), NOW).down, true);
  assert.equal(instanceUsage({ ...cache('codex'), status: 'error' }, NOW).down, true);
  assert.equal(instanceUsage({ ...cache('codex'), auth: { status: 'unauthenticated' } }, NOW).down, true);
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
  models: Object.fromEntries([mod('codex', 'gpt-x'), mod('cx', 'gpt-x'), mod('ag', 'gemini-3-pro'), mod('ag', 'claude-sonnet'), mod('ag', 'gpt-oss')]),
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

test('readUsage reads each instance cache under T3CODE_HOME, else ~/.t3; a missing or damaged file is skipped', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-t3home-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'caches'));
  await fs.writeFile(path.join(dir, 'caches', 'codex.json'), JSON.stringify(cache('codex')));
  await fs.writeFile(path.join(dir, 'caches', 'cx.json'), '{damaged');
  const ctx = { env: { T3CODE_HOME: dir }, now: () => NOW, deps: { homedir: () => '/nonexistent' } };
  const u = await readUsage(ctx, REG);
  assert.deepEqual(Object.keys(u), ['codex']);
  assert.equal(u.codex.windows[0].used, 100);
  const viaHome = await readUsage({ env: {}, now: () => NOW, deps: { homedir: () => path.dirname(dir) } }, REG);
  assert.deepEqual(viaHome, {}); // <home>/.t3/caches does not exist
});
