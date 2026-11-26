import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  accountFor, currentQuota, localQuota, mapAccounts, overlayQuota, quotaPath, quotaSourceError, quotaTable, refreshQuota, REFRESH_MS, MAX_AGE_MS,
} from '../lib/quota.mjs';
import { applyUsage, readUsage } from '../lib/usage-source.mjs';
import { cleanStatus, readPeers, selfPath } from '../lib/peers.mjs';
import { admission } from '../lib/admission.mjs';
import { setConfigValue } from '../lib/config.mjs';
import { run } from '../lib/cli.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/easycli/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-16T20:10:00Z');
const H = 3600_000;
const MIN = 60_000;

// This machine's instances as T3 names them: the display name is the account's local part.
const inst = (driverKind, displayName, over = {}) => ({ driverKind, displayName, enabled: true, cooldownUntil: null, ...over });
const model = (instance, m, family, over = {}) => ({
  instance, model: m, family, tier: 2, available: true, cooldownUntil: null, failures: 0, ...over,
});
const registry = (over = {}) => ({
  version: 1,
  instances: {
    codex: inst('codex', 'alice.dev'), 'codex-2': inst('codex', 'bob.ops'), claudeAgent: inst('claudeAgent', 'alice.dev'), 'claudeAgent-2': inst('claudeAgent', 'alice.dev01'),
    'antigravity-2': inst('antigravity', 'shopsite'), grok: inst('grok', 'Grok'), ...over.instances,
  },
  models: {
    'codex::gpt-6.1': model('codex', 'gpt-6.1', 'openai'),
    'codex-2::gpt-6.1': model('codex-2', 'gpt-6.1', 'openai'),
    'claudeAgent-2::claude-opus-5-5': model('claudeAgent-2', 'claude-opus-5-5', 'anthropic'),
    'antigravity-2::gemini-4-neon': model('antigravity-2', 'gemini-4-neon', 'google'),
    'antigravity-2::gemini-4-argon': model('antigravity-2', 'gemini-4-argon', 'google'),
    'antigravity-2::claude-sonnet-5-5': model('antigravity-2', 'claude-sonnet-5-5', 'anthropic'),
    ...over.models,
  },
});
const account = (provider, acc, windows, credits = null) => ({ provider, account: acc, windows, credits });
const w = (name, remainingPct, resetsAt = NOW + 2 * H) => ({ name, remainingPct, resetsAt });
const QUOTA = {
  at: NOW - MIN,
  accounts: [
    account('codex', 'alice.dev@example.test', [w('5h', 72), w('weekly', 40, NOW + 50 * H)], 12.5),
    account('codex', 'bob.ops@example.test', [w('5h', 0, NOW + 3 * H), w('weekly', 60)], 0),
    account('claude', 'alice.dev01@example.test', [w('5h', 76), w('weekly-fable', 4, NOW + 60 * H)]),
    account('antigravity', 'shopsite@example.test', [w('gemini-weekly', 0, NOW + 70 * H), w('3p-weekly', 84), w('gemini-argon-weekly', 50)]),
  ],
};

test('accountFor: a display name matches the e-mail\'s local part on a driver of the provider; the machine map wins', () => {
  const r = registry();
  const m = mapAccounts(r, QUOTA, {});
  assert.deepEqual(Object.fromEntries(Object.entries(m).map(([id, a]) => [id, a.account])), {
    codex: 'alice.dev@example.test', 'codex-2': 'bob.ops@example.test', 'claudeAgent-2': 'alice.dev01@example.test', 'antigravity-2': 'shopsite@example.test',
  }, 'claudeAgent "alice.dev" has no claude account of that name: unmapped, not the codex one');
  assert.equal(accountFor('grok', r.instances.grok, QUOTA.accounts, { grok: 'alice.dev' }).provider, 'codex', 'an explicit map is taken as given');
  assert.equal(accountFor('grok', r.instances.grok, [...QUOTA.accounts, account('xai', 'alice.dev@example.test', [])], { grok: 'alice.dev' }).provider, 'xai', 'the instance\'s own provider first');
  assert.equal(accountFor('codex', r.instances.codex, QUOTA.accounts, { codex: 'nobody' }), null);
  const twice = [...QUOTA.accounts, account('codex', 'alice.dev@other.example', [])];
  assert.equal(accountFor('codex', r.instances.codex, twice, {}), null, 'two accounts of one local part: not guessed');
  assert.equal(accountFor('codex', r.instances.codex, twice, { codex: 'alice.dev@other.example' }).account, 'alice.dev@other.example');
  assert.equal(accountFor('codex', r.instances.codex, twice, { codex: 'alice.dev' }), null, 'an ambiguous override is not guessed either');
});

test('real quota routes: a used-up window cools until its reset, headroom is what is left, a pool binds only its models', () => {
  const r = registry();
  const instances = overlayQuota({}, r, QUOTA, {}, NOW);
  const view = applyUsage(r, { instances }, { usageThreshold: 95 }, NOW);
  assert.equal(view.models['codex::gpt-6.1'].headroom, 0.4);
  assert.equal(view.models['codex::gpt-6.1'].cooldownUntil, null);
  assert.equal(view.models['codex-2::gpt-6.1'].cooldownUntil, NOW + 3 * H, 'a window at 0% holds until its reset');
  assert.equal(view.models['claudeAgent-2::claude-opus-5-5'].cooldownUntil, NOW + 60 * H, '4% left is under the 95% threshold');
  assert.equal(view.models['antigravity-2::gemini-4-neon'].cooldownUntil, NOW + 70 * H, 'the gemini pool is out');
  assert.equal(view.models['antigravity-2::claude-sonnet-5-5'].cooldownUntil ?? null, null, 'the shared claude and gpt pool has room');
  assert.equal(view.models['antigravity-2::gemini-4-argon'].cooldownUntil, NOW + 70 * H, 'argon draws on the gemini pool too');
  assert.equal(instances['antigravity-2'].windows[0].group, 'gemini');
});

test('scoped windows bind only their work: Codex code review binds nothing, a Claude model week only that model', () => {
  const r = registry({ models: { 'claudeAgent-2::claude-sonnet-5-5': model('claudeAgent-2', 'claude-sonnet-5-5', 'anthropic'), 'claudeAgent-2::claude-fable-5': model('claudeAgent-2', 'claude-fable-5', 'anthropic') } });
  const q = {
    at: NOW - MIN,
    accounts: [
      account('codex', 'alice.dev@example.test', [w('5h', 60), w('code-review-weekly', 0, NOW + 100 * H)].map((x, i) => (i ? { ...x, scope: 'feature' } : x))),
      account('claude', 'alice.dev01@example.test', [w('5h', 76), { ...w('weekly-opus', 0, NOW + 60 * H), scope: 'model:opus' }, { ...w('weekly-fable', 50), scope: 'model:fable' }]),
    ],
  };
  const view = applyUsage(r, { instances: overlayQuota({}, r, q, {}, NOW) }, {}, NOW);
  assert.equal(view.models['codex::gpt-6.1'].cooldownUntil, null, 'the code-review week does not hold normal work');
  assert.equal(view.models['codex::gpt-6.1'].headroom, 0.6);
  assert.equal(view.models['claudeAgent-2::claude-opus-5-5'].cooldownUntil, NOW + 60 * H);
  assert.equal(view.models['claudeAgent-2::claude-sonnet-5-5'].cooldownUntil, null, 'the opus week binds opus only');
  assert.equal(view.models['claudeAgent-2::claude-fable-5'].headroom, 0.5);
});

test('an antigravity model\'s own pool keeps the members T3 ties to it', () => {
  const r = registry({ models: { 'antigravity-2::gemini-pro-orchestrator-g1-pro': model('antigravity-2', 'gemini-pro-orchestrator-g1-pro', 'google') } });
  const models = { 'antigravity-2': [{ slug: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { slug: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' }, { slug: 'gemini-4-neon', name: 'Gemini 4 Neon' }] };
  const q = { at: NOW - MIN, accounts: [account('antigravity', 'shopsite@example.test', [w('gemini-weekly', 80), w('gemini-argon-weekly', 0, NOW + 30 * H)])] };
  const instances = overlayQuota({}, r, q, {}, NOW, models);
  assert.deepEqual(instances['antigravity-2'].windows[1].members, ['gemini-4-argon', 'gemini-pro-orchestrator-g1-pro']);
  const view = applyUsage(r, { instances }, {}, NOW);
  assert.equal(view.models['antigravity-2::gemini-pro-orchestrator-g1-pro'].cooldownUntil, NOW + 30 * H);
  assert.equal(view.models['antigravity-2::gemini-4-argon'].cooldownUntil, NOW + 30 * H);
  assert.equal(view.models['antigravity-2::gemini-4-neon'].cooldownUntil ?? null, null);
});

test('real quota replaces T3\'s windows, keeps its sign-in flags, drops windows already reset', () => {
  const r = registry();
  const t3 = { codex: { checkedAt: NOW - H, down: false, stale: false, signedOut: true, windows: [{ id: 'primary', used: 100, resetAt: NOW + H }] } };
  const q = { ...QUOTA, accounts: [account('codex', 'alice.dev@example.test', [w('5h', 50), w('weekly', 0, NOW - MIN)])] };
  const out = overlayQuota(t3, r, q, {}, NOW);
  assert.deepEqual(out.codex.windows, [{ id: '5h', used: 50, resetAt: NOW + 2 * H }]);
  assert.equal(out.codex.signedOut, true);
  assert.equal(out.codex.source, 'easycli');
  assert.deepEqual(overlayQuota(t3, r, null, {}, NOW), t3, 'no snapshot: T3\'s readings as they were');
});

test('creditInstances: a credit balance keeps the instance routable past its windows; a zero balance does not', () => {
  const r = registry();
  const instances = overlayQuota({}, r, QUOTA, {}, NOW);
  const machine = { creditInstances: ['^codex(-2)?$'] };
  const view = applyUsage(r, { instances }, machine, NOW);
  assert.equal(view.models['codex::gpt-6.1'].cooldownUntil, null);
  assert.equal(view.models['codex-2::gpt-6.1'].cooldownUntil, NOW + 3 * H, 'EasyCLI read 0 credits: its windows count');
});

test('a limit hold on any driver ends when a real reading taken after the settle time shows room', () => {
  const held = { limitUntil: NOW + 40 * H, cooldownUntil: NOW + 40 * H, limitAt: NOW - H, limitStrikes: 1 };
  const r = registry({ instances: { codex: inst('codex', 'alice.dev', held) }, models: { 'codex::gpt-6.1': model('codex', 'gpt-6.1', 'openai', held) } });
  const view = applyUsage(r, { instances: overlayQuota({}, r, QUOTA, {}, NOW) }, {}, NOW);
  assert.equal(view.models['codex::gpt-6.1'].cooldownUntil, null);
  assert.equal(view.instances.codex.cooldownUntil, null);
  const early = { ...held, limitAt: NOW - 2 * MIN }; // the refusal came after the reading: it stands
  const r2 = registry({ instances: { codex: inst('codex', 'alice.dev', early) }, models: { 'codex::gpt-6.1': model('codex', 'gpt-6.1', 'openai', early) } });
  assert.equal(applyUsage(r2, { instances: overlayQuota({}, r2, QUOTA, {}, NOW) }, {}, NOW).models['codex::gpt-6.1'].cooldownUntil, NOW + 40 * H);
});

async function context(t, { answers = 0, fail = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-quota-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, 'config.toml');
  await fs.writeFile(cfg, fixture('config.toml'));
  const ctx = { env: { T3ORQ_HOME: path.join(dir, 'orq') }, clock: NOW, fetched: 0, asked: [] };
  ctx.now = () => ctx.clock;
  ctx.deps = {
    homedir: () => path.join(dir, 'nohome'),
    hostname: () => 'mac',
    fetch: async (url, init) => {
      ctx.fetched += 1;
      if (fail) throw new TypeError('fetch failed');
      const reply = (body) => ({ ok: true, status: 200, json: async () => body });
      if (url.endsWith('/auth-files')) return reply(JSON.parse(fixture('auth-files.json')));
      const target = JSON.parse(init.body).url;
      const body = target.includes('wham') ? fixture('codex-usage.json') : target.includes('oauth') ? fixture('claude-usage.json') : fixture('antigravity-quota.json');
      return reply({ status_code: 200, body });
    },
    ssh: async (target) => { ctx.asked.push(target); return answers ? { code: 0, stdout: JSON.stringify(answers), stderr: '' } : { code: 255, stdout: '', stderr: 'Connection refused' }; },
  };
  return { ctx, dir, cfg };
}

test('refreshQuota asks EasyCLI at most every 5 minutes, keeps the last good snapshot when it stops answering', async (t) => {
  const { ctx, cfg } = await context(t);
  const machine = { quotaSource: { configPath: cfg } };
  assert.deepEqual(await refreshQuota(ctx, machine), { fetched: true });
  const calls = ctx.fetched;
  assert.deepEqual(await refreshQuota(ctx, machine), { fetched: false });
  assert.equal(ctx.fetched, calls, 'not due: not asked');
  assert.equal((await localQuota(ctx.env, NOW)).accounts.length, 5);
  ctx.clock = NOW + REFRESH_MS;
  ctx.deps.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await refreshQuota(ctx, machine), { fetched: false, error: 'EasyCLI did not answer' });
  const kept = JSON.parse(await fs.readFile(quotaPath(ctx.env), 'utf8'));
  assert.equal(kept.snapshot.at, NOW, 'the last good snapshot stays');
  assert.equal(kept.triedAt, NOW + REFRESH_MS);
  ctx.clock = NOW + MAX_AGE_MS + MIN;
  assert.equal(await localQuota(ctx.env, ctx.clock), null, 'too old to route by');
  assert.deepEqual(await refreshQuota(ctx, { quotaSource: { kind: 'off' } }, { force: true }), { fetched: false });
});

test('refreshQuota: two processes at once ask EasyCLI once', async (t) => {
  const { ctx, cfg } = await context(t);
  const machine = { quotaSource: { configPath: cfg } };
  const results = await Promise.all([refreshQuota(ctx, machine), refreshQuota(ctx, machine), refreshQuota(ctx, machine)]);
  assert.equal(results.filter((x) => x.fetched).length, 1);
  assert.equal(ctx.fetched, 4, 'one account list and three accounts (antigravity not allowed), once');
});

test('refreshQuota: a forced refresh while another is in flight waits for it and asks nothing itself', async (t) => {
  const { ctx, cfg } = await context(t);
  const machine = { quotaSource: { configPath: cfg } };
  const real = ctx.deps.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  ctx.deps.fetch = async (...args) => { await gate; return real(...args); };
  const first = refreshQuota(ctx, machine, { force: true });
  await new Promise((r) => { setTimeout(r, 50); }); // the first holds the in-flight mark
  const second = refreshQuota(ctx, machine, { force: true });
  assert.deepEqual(await refreshQuota(ctx, machine), { fetched: false }, 'an unforced one does not wait');
  setTimeout(release, 150);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { fetched: true });
  assert.deepEqual(b, { fetched: false, waited: true });
  assert.equal(ctx.fetched, 4, 'asked once');
  assert.equal((await localQuota(ctx.env, NOW)).accounts.length, 5, 'the waiter reads the answer');
  const kept = JSON.parse(await fs.readFile(quotaPath(ctx.env), 'utf8'));
  assert.equal(kept.inflight, undefined, 'the mark is cleared');
  ctx.deps.fetch = real;
  assert.deepEqual(await refreshQuota(ctx, machine, { force: true }), { fetched: true }, 'with nothing in flight, force asks again');
});

test('refreshQuota: an in-flight mark left by a crashed process expires', async (t) => {
  const { ctx, cfg } = await context(t);
  await fs.mkdir(ctx.env.T3ORQ_HOME, { recursive: true });
  await fs.writeFile(quotaPath(ctx.env), JSON.stringify({ triedAt: NOW - H, inflight: { id: 'x', until: NOW - 1 } }));
  assert.deepEqual(await refreshQuota(ctx, { quotaSource: { configPath: cfg } }), { fetched: true });
});

test('refreshQuota passes allowTokenRefresh; kind off means no snapshot is used, local or peer', async (t) => {
  const { ctx, cfg } = await context(t);
  await refreshQuota(ctx, { quotaSource: { configPath: cfg, allowTokenRefresh: ['antigravity'] } });
  const q = await currentQuota(ctx, {});
  assert.equal(q.accounts.find((a) => a.provider === 'antigravity').windows.length, 4);
  assert.equal(await currentQuota(ctx, { quotaSource: { kind: 'off' } }), null);
  const facts = { cores: 8, load1: 0.5, availableMemBytes: 8 * 2 ** 30 };
  assert.equal((await admission(ctx, { machine: { quotaSource: { kind: 'off' } }, facts, cap: 4, active: 1 })).status.quota, undefined, 'nor published');
});

test('readUsage lays the real quota over T3\'s readings', async (t) => {
  const { ctx, cfg } = await context(t);
  await refreshQuota(ctx, { quotaSource: { configPath: cfg } });
  const r = registry();
  const u = await readUsage({ ...ctx, env: { ...ctx.env, T3CODE_HOME: path.join(ctx.env.T3ORQ_HOME, 'no-t3') } }, r, {});
  assert.deepEqual(u.instances.codex.windows.map((x) => [x.id, x.used]), [['5h', 28], ['weekly', 100], ['code-review-weekly', 0]]);
  assert.equal(u.quota.from, 'easycli');
});

test('peers: the Mac publishes its snapshot; a machine without EasyCLI routes by the freshest peer\'s', async (t) => {
  const mac = await context(t);
  await refreshQuota(mac.ctx, { quotaSource: { configPath: mac.cfg } });
  const facts = { cores: 8, load1: 0.5, availableMemBytes: 8 * 2 ** 30 };
  const self = await admission(mac.ctx, { machine: {}, facts, cap: 4, active: 1 });
  assert.equal(self.status.quota.accounts.length, 5);
  assert.equal(JSON.parse(await fs.readFile(selfPath(mac.ctx.env), 'utf8')).quota.at, NOW);
  assert.equal(cleanStatus(self.status).quota.accounts[0].provider, 'codex');

  const remote = await context(t, { answers: self.status });
  const machine = { peers: [{ host: 'mac', ssh: 'mac' }], quotaSource: { configPath: '/nowhere/config.toml' } };
  assert.equal(await currentQuota(remote.ctx, machine), null, 'nothing cached yet, and reading never asks');
  assert.deepEqual(remote.ctx.asked, []);
  assert.deepEqual(await refreshQuota(remote.ctx, machine), { fetched: false, error: 'no EasyCLI config on this machine' });
  assert.deepEqual(remote.ctx.asked, ['mac']);
  const q = await currentQuota(remote.ctx, machine);
  assert.equal(q.from, 'peer mac');
  assert.equal(q.accounts.length, 5);
  remote.ctx.clock = NOW + MAX_AGE_MS + MIN;
  assert.equal(await currentQuota(remote.ctx, machine), null, 'a peer snapshot too old: routing as before');
  assert.equal((await readPeers(remote.ctx, machine.peers, { cachedOnly: true })).length, 1);
});

test('orq usage prints each account, its windows and the instance it maps to', async (t) => {
  const { ctx, cfg } = await context(t);
  await fs.mkdir(ctx.env.T3ORQ_HOME, { recursive: true });
  await fs.writeFile(path.join(ctx.env.T3ORQ_HOME, 'config.json'), JSON.stringify({ perInstanceLimit: 2, quotaSource: { configPath: cfg, accounts: { grok: 'alice.dev@example.test' }, allowTokenRefresh: ['antigravity'] } }));
  await fs.writeFile(path.join(ctx.env.T3ORQ_HOME, 'registry.json'), JSON.stringify(registry()));
  const out = [];
  const io = { ...ctx, stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => out.push(x) } };
  assert.equal(await run(['usage'], io), 0, out.join(''));
  const lines = out.join('').trim().split('\n');
  assert.equal(lines[0], 'quota: from easycli, 0 min old');
  assert.ok(lines.includes('codex alice.dev@example.test -> codex plan=pro: 5h 72% left (resets in 1d14h), weekly 0% left (resets in 5d2h), code-review-weekly 100% left (resets in 5d2h) credits=12.5'), lines.join('\n'));
  assert.ok(lines.includes('xai alice.dev@example.test -> grok: no windows read'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('antigravity shopsite@example.test -> antigravity-2: gemini-5h 75% left')));
  out.length = 0;
  assert.equal(await run(['usage', '--json'], io), 0);
  assert.equal(JSON.parse(out.join('')).accounts.length, 5);
  out.length = 0;
  ctx.deps.fetch = async () => { throw new TypeError('fetch failed'); };
  await fs.rm(quotaPath(ctx.env));
  assert.equal(await run(['usage', '--refresh'], io), 0);
  assert.equal(out.join(''), 'quota: none read (EasyCLI did not answer); routing uses T3\'s usage readings and refusals\n');
});

test('quotaSource: checked when set', () => {
  assert.equal(quotaSourceError(undefined), null);
  assert.equal(quotaSourceError({ kind: 'easycli', url: 'http://127.0.0.1:8317', configPath: '/a/config.toml', accounts: { codex: 'alice.dev' } }), null);
  assert.equal(quotaSourceError({ allowTokenRefresh: ['antigravity'] }), null);
  for (const bad of [[], { kind: 'x' }, { url: 'file:///etc' }, { configPath: 'rel' }, { accounts: { codex: 1 } }, { secret: 'x' }, { allowTokenRefresh: ['codex'] }, { allowTokenRefresh: 'antigravity' }]) assert.ok(quotaSourceError(bad), JSON.stringify(bad));
  const c = setConfigValue({ perInstanceLimit: 2 }, 'quotaSource', '{"accounts":{"codex-3":"alice.dev01"}}', 'machine');
  assert.deepEqual(c.quotaSource, { accounts: { 'codex-3': 'alice.dev01' } });
  assert.throws(() => setConfigValue({}, 'quotaSource', '{"kind":"maybe"}', 'machine'), /quotaSource must be/);
  assert.deepEqual(quotaTable(null, registry(), {}, NOW), []);
});
