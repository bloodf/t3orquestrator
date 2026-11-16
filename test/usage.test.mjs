import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  accountUsage, usageByInstance, usageSettingsError, withUsage,
} from '../lib/usage.mjs';
import { loadUsage } from '../lib/usage-source.mjs';
import { loadMachineConfig } from '../lib/config.mjs';
import { route } from '../lib/route.mjs';

// The real GET /v0/management/auth-files response of CLIProxyAPI 8.0.63, redacted: names, emails and tokens replaced.
const FILES = JSON.parse(readFileSync(new URL('./fixtures/cliproxy-auth-files.json', import.meta.url), 'utf8')).files;
const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-16T15:00:00Z');
const RESET_C = 1795277460 * 1000; // codex-c's weekly window (X-Codex-Primary-Reset-At)
const entry = (name) => FILES.find((f) => f.name === name);
const cooldown = (over) => ({
  scope: 'credential', reason: 'quota', retry_at: '2026-11-16T18:00:00Z', remaining_seconds: 10800, ...over,
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

test('accountUsage reads the used percent and reset of the fullest live window', () => {
  assert.deepEqual(accountUsage(entry('codex-c.json'), NOW), {
    usedPercent: 95, resetAt: RESET_C, exhaustedUntil: null, observedAt: Date.parse('2026-11-16T11:13:58.403929-03:00'),
  });
  assert.equal(accountUsage(entry('codex-b.json'), NOW).usedPercent, 6);
  // no signals (antigravity, kimi in this version): unknown, not zero
  assert.deepEqual(accountUsage(entry('antigravity-a.json'), NOW), {
    usedPercent: null, resetAt: null, exhaustedUntil: null, observedAt: null,
  });
});

test('accountUsage drops a window that has reset since it was observed', () => {
  assert.equal(accountUsage(entry('codex-c.json'), RESET_C + 1).usedPercent, 0); // the secondary window (0%, no reset) is left
});

test('accountUsage: a credential quota cooldown is exhaustion; model or non-quota cooldowns are not', () => {
  const e = (cooldowns) => ({ ...entry('kimi-a.json'), cooldowns });
  assert.equal(accountUsage(e([cooldown()]), NOW).exhaustedUntil, Date.parse('2026-11-16T18:00:00Z'));
  assert.equal(accountUsage(e([cooldown({ reason: 'credential_quota' })]), NOW).exhaustedUntil, Date.parse('2026-11-16T18:00:00Z'));
  assert.equal(accountUsage(e([cooldown({ scope: 'model', model_key: 'k2' })]), NOW).exhaustedUntil, null);
  assert.equal(accountUsage(e([cooldown({ reason: 'server_error' })]), NOW).exhaustedUntil, null);
  assert.equal(accountUsage(e([cooldown({ retry_at: '2026-11-16T14:00:00Z' })]), NOW).exhaustedUntil, null); // past
  assert.equal(accountUsage({ ...e(null) }, NOW).exhaustedUntil, null);
});

test('usageByInstance maps accounts by name, email, label or auth_index; a pool takes its best open account', () => {
  const r = usageByInstance(FILES, {
    codex: 'codex-c.json',
    'antigravity-2': 'antigravity-b@example.invalid',
    kimi: 'idx-kimi-a',
    pool: ['codex-a.json', 'codex-b.json'],
    ghost: 'nope@example.invalid',
  }, NOW);
  assert.equal(r.instances.codex.usedPercent, 95);
  assert.equal(r.instances['antigravity-2'].usedPercent, null);
  assert.ok(r.instances.kimi);
  assert.equal(r.instances.pool.usedPercent, 6);
  assert.equal(r.instances.ghost, undefined);
  assert.deepEqual(r.missing, ['ghost: nope@example.invalid']);
  const allOut = FILES.map((f) => ({ ...f, cooldowns: [cooldown({ retry_at: f.name === 'codex-a.json' ? '2026-11-16T16:00:00Z' : '2026-11-16T18:00:00Z' })] }));
  assert.equal(usageByInstance(allOut, { pool: ['codex-a.json', 'codex-b.json'] }, NOW).instances.pool.exhaustedUntil, Date.parse('2026-11-16T16:00:00Z'));
  assert.deepEqual(usageByInstance(FILES, undefined, NOW), { instances: {}, missing: [] });
});

const inst = (over = {}) => ({ enabled: true, constraints: [], limit: 2, failures: 0, cooldownUntil: null, ...over });
const mod = (instance, model, tier) => [`${instance}::${model}`, {
  instance, model, family: 'fam-a', tier, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null,
}];
const REG = deepFreeze({ version: 1, instances: { pa: inst(), pb: inst(), pc: inst() }, models: Object.fromEntries([mod('pa', 'm', 2), mod('pb', 'm', 2), mod('pc', 'm', 2)]) });
const u = (usedPercent, resetAt = NOW + 3600_000, exhaustedUntil = null) => ({ usedPercent, resetAt, exhaustedUntil, observedAt: NOW });

test('withUsage: at the threshold an instance cools until its reset; under it, it carries its headroom', () => {
  assert.equal(withUsage(REG, undefined, { now: NOW }), REG);
  assert.equal(withUsage(REG, {}, { now: NOW }), REG);
  const v = withUsage(REG, {
    pa: u(90), pb: u(40), pc: u(null, null, NOW + 60_000), ghost: u(99),
  }, { now: NOW });
  assert.equal(v.instances.pa.cooldownUntil, NOW + 3600_000);
  assert.equal(v.instances.pb.cooldownUntil, null);
  assert.equal(v.instances.pb.headroom, 0.6);
  assert.equal(v.instances.pc.cooldownUntil, NOW + 60_000);
  assert.equal(v.instances.pc.headroom, null);
  assert.equal(v.instances.ghost, undefined);
  assert.equal(REG.instances.pa.cooldownUntil, null); // input untouched (frozen)
  assert.equal(withUsage(REG, { pa: u(89) }, { now: NOW }).instances.pa.cooldownUntil, null);
  assert.equal(withUsage(REG, { pa: u(50) }, { now: NOW, threshold: 50 }).instances.pa.cooldownUntil, NOW + 3600_000);
  // the window reset since the fetch: its percent says nothing any more
  const reset = withUsage(REG, { pa: u(100, NOW - 1) }, { now: NOW }).instances.pa;
  assert.deepEqual([reset.cooldownUntil, reset.headroom, reset.usage.usedPercent], [null, null, null]);
  // a longer failure cooldown already on the instance is kept
  const longer = { ...REG, instances: { ...REG.instances, pa: inst({ cooldownUntil: NOW + 7200_000 }) } };
  assert.equal(withUsage(longer, { pa: u(95) }, { now: NOW }).instances.pa.cooldownUntil, NOW + 7200_000);
});

test('route skips an exhausted instance, retries at its reset, and prefers the most headroom', () => {
  const go = (usage) => route({ registry: withUsage(REG, usage, { now: NOW }), rules, job: 'implement', now: NOW });
  assert.deepEqual(go({}).candidates.map((c) => c.instance), ['pa', 'pb', 'pc']);
  const r = go({ pa: u(95), pb: u(70), pc: u(10) });
  assert.deepEqual(r.candidates.map((c) => c.instance), ['pc', 'pb']);
  assert.equal(r.candidates[0].headroom, 0.9);
  // unknown headroom ranks as half full: after 75%+ headroom, before under 50%
  assert.deepEqual(go({ pa: u(60), pc: u(10) }).candidates.map((c) => c.instance), ['pc', 'pb', 'pa']);
  const none = go({ pa: u(95), pb: u(100, NOW + 60_000), pc: u(null, null, NOW + 120_000) });
  assert.deepEqual([none.blocked, none.retryAt], ['cooling', NOW + 60_000]);
});

test('usageSettingsError validates the machine config usage block', () => {
  const ok = { url: 'http://127.0.0.1:8317', keyEnv: 'ORQ_CLIPROXY_KEY', accounts: { codex: 'a.json', pool: ['b', 'c'] } };
  assert.equal(usageSettingsError(ok), null);
  assert.equal(usageSettingsError({ ...ok, keyEnv: undefined, keyFile: '/k' }), null);
  assert.equal(usageSettingsError({ ...ok, threshold: 80, ttlSeconds: 60 }), null);
  assert.match(usageSettingsError([]), /usage must be an object/);
  assert.match(usageSettingsError({ ...ok, url: 'ftp://x' }), /usage.url/);
  assert.match(usageSettingsError({ ...ok, keyEnv: undefined }), /usage.keyEnv or usage.keyFile/);
  assert.match(usageSettingsError({ ...ok, keyFile: 'rel/k' }), /usage.keyFile/);
  assert.match(usageSettingsError({ ...ok, accounts: { codex: 3 } }), /usage.accounts/);
  assert.match(usageSettingsError({ ...ok, accounts: { codex: [] } }), /usage.accounts/);
  assert.match(usageSettingsError({ ...ok, threshold: 101 }), /usage.threshold/);
  assert.match(usageSettingsError({ ...ok, ttlSeconds: 0 }), /usage.ttlSeconds/);
});

async function home(t, config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-usage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

test('machine config: a usage block is validated on load', async (t) => {
  const dir = await home(t, { usage: { url: 'http://127.0.0.1:8317', accounts: {} } });
  await assert.rejects(loadMachineConfig(path.join(dir, 'config.json')), /usage.keyEnv or usage.keyFile/);
});

test('loadUsage: none configured, fetch with the key, cache for the TTL, keep the last known on failure', async (t) => {
  const settings = { url: 'http://127.0.0.1:8317/', keyEnv: 'ORQ_TEST_KEY', accounts: { codex: 'codex-c.json' } };
  const dir = await home(t, {});
  let now = NOW;
  const calls = [];
  let fail = null;
  const ctx = {
    env: { T3ORQ_HOME: dir, ORQ_TEST_KEY: 'sekret-value\n' },
    now: () => now,
    deps: {
      fetch: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        if (fail) throw fail;
        return { ok: true, status: 200, json: async () => ({ files: FILES }) };
      },
    },
  };
  assert.equal(await loadUsage(ctx, {}), null);
  const first = await loadUsage(ctx, { usage: settings });
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:8317/v0/management/auth-files', auth: 'Bearer sekret-value' }]);
  assert.equal(first.instances.codex.usedPercent, 95);
  assert.equal(first.fetchedAt, NOW);
  now += 60_000;
  assert.equal((await loadUsage(ctx, { usage: settings })).fetchedAt, NOW); // inside the 300 s TTL: cached
  assert.equal(calls.length, 1);
  await loadUsage(ctx, { usage: settings }, { fresh: true });
  assert.equal(calls.length, 2);
  now += 301_000;
  fail = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const down = await loadUsage(ctx, { usage: settings });
  assert.equal(calls.length, 3);
  assert.equal(down.instances.codex.usedPercent, 95);
  assert.equal(down.error, 'fetch failed (ECONNREFUSED)');
  assert.equal(down.fetchedAt, now); // the failure waits out the TTL too
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'), /sekret/);
  fail = null;
  const rejected = { ...ctx, deps: { fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) } };
  assert.equal((await loadUsage(rejected, { usage: settings }, { fresh: true })).error, 'HTTP 401');
});

test('loadUsage reads the key from a file, and reports a missing key', async (t) => {
  const dir = await home(t, {});
  const keyFile = path.join(dir, 'key');
  await fs.writeFile(keyFile, 'from-file\n');
  let auth;
  const ctx = {
    env: { T3ORQ_HOME: dir },
    now: () => NOW,
    deps: { fetch: async (_url, init) => { auth = init.headers.Authorization; return { ok: true, json: async () => ({ files: [] }) }; } },
  };
  await loadUsage(ctx, { usage: { url: 'http://h:1', keyFile, accounts: {} } });
  assert.equal(auth, 'Bearer from-file');
  const missing = await loadUsage(ctx, { usage: { url: 'http://h:1', keyEnv: 'NOPE', accounts: {} } }, { fresh: true });
  assert.match(missing.error, /no management key: set NOPE/);
});
