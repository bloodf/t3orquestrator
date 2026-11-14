import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { Readable } from 'node:stream';
import { run } from '../lib/cli.mjs';
import { readStdin } from '../lib/commands/common.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const GIB = 1024 ** 3;
const capsFixture = await fs.readFile(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8');
const threadList = (rows) => JSON.stringify(rows.map((r, i) => ({
  threadId: `t${i}`, projectId: 'p', status: 'completed', providerInstanceId: r[0], model: r[1], itemCount: 1,
  updatedAt: '2026-11-12T10:00:00.000Z', title: 'x',
})));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-cmd-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  return { root, home, cwd };
}

async function orq(args, s, { env = {}, deps = {}, stdin = '' } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) },
    stderr: { write: (x) => err.push(x) },
    env: { T3ORQ_HOME: s.home, ...env },
    cwd: s.cwd,
    now: () => NOW,
    stdin: async () => stdin,
    deps: {
      exec: (_bin, a) => (a[1] === 'list' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: 't3 v1\n', stderr: '' }),
      which: () => null,
      readMachine: () => ({ cores: 10, availableMemBytes: 12 * GIB, load1: 1 }),
      homedir: () => path.join(s.root, 'nohome'),
      ...deps,
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const prov = (id, models, constraints = []) => ({ providerInstanceId: id, driverKind: 'k', displayName: id, models, constraints });
const caps = (...p) => JSON.stringify({ providers: p });
const regFile = (s) => path.join(s.home, 'registry.json');

test('sync: fixture, then a provider removed, then a truncated payload', async () => {
  const s = await setup();
  await orq(['init'], s);
  const listRows = threadList([['provider-e', 'model-small']]);
  const exec = (_b, a) => (a[1] === 'list' ? { code: 0, stdout: listRows, stderr: '' } : { code: 0, stdout: 'v1\n', stderr: '' });
  const r = await orq(['sync'], s, { stdin: capsFixture, deps: { exec } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\+instances: provider-e, provider-f, provider-g$/m);
  assert.match(r.out, /^\+models: \d+$/m);
  assert.match(r.out, /^synced: 3 instances \(2 enabled\), \d+ models \(1 confirmed\)$/m);
  assert.match(r.out, /^providers: 2 usable \(provider-e, provider-f\); 1 disabled in T3 \(provider-g\); 0 disabled by you; 0 cooling$/m);
  const reg = await read(regFile(s));
  assert.equal(reg.syncedAt, NOW);
  assert.ok(reg.models['provider-e::model-small'].confirmedAt > 0);

  const fixture = JSON.parse(capsFixture);
  const fewer = JSON.stringify({ ...fixture, providers: fixture.providers.filter((p) => p.providerInstanceId !== 'provider-f') });
  const r2 = await orq(['sync'], s, { stdin: fewer, deps: { exec } });
  assert.match(r2.out, /^-instances: provider-f$/m);
  assert.match(r2.out, /^synced: 3 instances \(1 enabled\)/m);

  const bad = await orq(['sync'], s, { stdin: '{"providers":[]}' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^orq: capabilities look truncated or compressed; read them again\n$/);
  const junk = await orq(['sync'], s, { stdin: 'not json' });
  assert.equal(junk.code, 1);
  assert.match(junk.err, /stdin is not valid JSON/);
  assert.equal((await read(regFile(s))).instances['provider-f'].enabled, false);
});

test('sync: history failure is a note, not an error; no t3 skips harvest', async () => {
  const s = await setup();
  await orq(['init'], s);
  const r = await orq(['sync'], s, {
    stdin: caps(prov('a', ['m-pro'])),
    deps: { exec: (_b, a) => (a[1] === 'list' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: 'v', stderr: '' }) },
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /^note: history not harvested \(.*boom.*\)$/m);
  const t = await setup();
  const none = await orq(['sync'], t, { stdin: caps(prov('a', ['m-pro'])) });
  assert.equal(none.code, 0);
  assert.doesNotMatch(none.out, /note:/);
});

test('sync: wrapped payload with tool names updates slots; inferred models are listed', async () => {
  const s = await setup();
  await orq(['init'], s);
  const models = Array.from({ length: 10 }, (_, i) => `weird${i}x`);
  const r = await orq(['sync'], s, {
    stdin: JSON.stringify({ capabilities: JSON.parse(caps(prov('a', models))), tools: ['mcp__x__jev_classify'] }),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^inferred: a::weird0x, .*, a::weird7x \+2 more — set with: orq tier set <key> <1-4>$/m);
  const cfg = await read(path.join(s.cwd, '.orq/config.json'));
  assert.equal(cfg.slots.judge[0].name, 'jev');
});

test('route: ordered candidates, json, usage errors', async () => {
  const s = await setup();
  await orq(['sync'], s, { stdin: caps(prov('a', ['x-pro', 'y-mini', 'z-opus'])) });
  const r = await orq(['route', '--job', 'implement'], s);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n'), [
    '1 a x-pro tier=3 family=unknown unconfirmed',
    '2 a z-opus tier=4 family=unknown unconfirmed',
  ]);
  const j = JSON.parse((await orq(['route', '--job', 'plan', '--json'], s)).out);
  assert.equal(j.candidates[0].model, 'z-opus');
  const rev = await orq(['route', '--job', 'review', '--author-tier', '3', '--author-family', 'unknown'], s);
  assert.match(rev.out, /same-family/);
  assert.equal((await orq(['route', '--job', 'x', '--bogus'], s)).code, 2);
  assert.equal((await orq(['route'], s)).code, 2);
  const bad = await orq(['route', '--job', 'nope'], s);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown job "nope"/);
});

test('route: below-tier flag, machine perInstanceLimit and leases', async () => {
  const s = await setup();
  await orq(['sync'], s, { stdin: caps(prov('a', ['x-mini'])) });
  const below = await orq(['route', '--job', 'plan'], s);
  assert.match(below.out, /^1 a x-mini tier=1 family=unknown unconfirmed below-tier\n$/);
  await fs.mkdir(path.join(s.home, 'leases'), { recursive: true });
  await fs.writeFile(path.join(s.home, 'leases/t1.json'), JSON.stringify({ threadId: 't1', project: 'p', unit: 'u', instance: 'a', model: 'm', startedAt: NOW }));
  assert.equal((await orq(['route', '--job', 'docs'], s)).code, 0);
  await fs.writeFile(path.join(s.home, 'config.json'), '{"perInstanceLimit":1}');
  const full = await orq(['route', '--job', 'docs'], s);
  assert.equal(full.code, 4);
  assert.match(full.out, /^none blocked=limit retry_at=- reason="all at concurrency limit"\n$/);
});

test('route: every instance cooling exits 4 with retry time', async () => {
  const s = await setup();
  await orq(['sync'], s, { stdin: caps(prov('a', ['x-pro']), prov('b', ['y-pro'])) });
  const reg = await read(regFile(s));
  reg.instances.a.cooldownUntil = NOW + 60_000;
  reg.models['b::y-pro'].cooldownUntil = NOW + 30_000;
  await fs.writeFile(regFile(s), JSON.stringify(reg));
  const r = await orq(['route', '--job', 'implement'], s);
  assert.equal(r.code, 4);
  assert.equal(r.out, `none blocked=cooling retry_at=${new Date(NOW + 30_000).toISOString()} reason="all cooling down"\n`);
});

test('model add and tier set honour source precedence', async () => {
  const s = await setup();
  await orq(['sync'], s, { stdin: caps(prov('a', ['x-pro'])) });
  const add = await orq(['model', 'add', 'a', 'mine', '--tier', '4'], s);
  assert.equal(add.code, 0, add.err);
  assert.equal((await read(regFile(s))).models['a::mine'].source, 'user');
  const blocked = await orq(['tier', 'set', 'a::mine', '2'], s);
  assert.equal(blocked.code, 4);
  assert.equal(blocked.out, 'unchanged: a::mine is set by user\n');
  const ok = await orq(['tier', 'set', 'a::mine', '2', '--by', 'user'], s);
  assert.equal(ok.out, 'tier a::mine = 2 (user)\n');
  const orch = await orq(['tier', 'set', 'a::x-pro', '4'], s);
  assert.equal(orch.out, 'tier a::x-pro = 4 (orchestrator)\n');
  assert.equal((await orq(['model', 'add', 'ghost', 'm'], s)).code, 1);
  assert.equal((await orq(['tier', 'set', 'a::x-pro', '9'], s)).code, 1);
  assert.equal((await orq(['tier', 'set', 'a::x-pro', '2', '--by', 'robot'], s)).code, 2);
  assert.equal((await orq(['model', 'rm'], s)).code, 2);
});

test('config get/set for project and machine', async () => {
  const s = await setup();
  const get = await orq(['config', 'get'], s);
  assert.equal(JSON.parse(get.out).base, 'main');
  assert.equal((await orq(['config', 'set', 'autonomy', 'review-fix'], s)).code, 0);
  assert.equal((await read(path.join(s.cwd, '.orq/config.json'))).autonomy, 'review-fix');
  assert.equal((await orq(['config', 'set', '--machine', 'cap', '3'], s)).code, 0);
  assert.deepEqual(JSON.parse((await orq(['config', 'get', '--machine'], s)).out), { cap: 3, perInstanceLimit: 2 });
  const bad = await orq(['config', 'set', 'nope', '1'], s);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /valid keys: autonomy, base/);
  assert.equal((await orq(['config', 'set', '--machine', 'autonomy', 'draft'], s)).code, 1);
  assert.equal((await orq(['config', 'set', 'base'], s)).code, 2);
  assert.equal((await orq(['config', 'frob'], s)).code, 2);
});

test('plan check: ok and errors', async () => {
  const s = await setup();
  const units = path.join(s.cwd, '.orq/units');
  await fs.mkdir(path.join(units, 'a'), { recursive: true });
  await fs.mkdir(path.join(units, 'b'), { recursive: true });
  await fs.writeFile(path.join(units, 'a/order.md'), 'do a\n');
  await fs.writeFile(path.join(units, 'b/order.md'), 'do b\n');
  const u = (id, over = {}) => ({ id, title: id, job: 'implement', paths: [`${id}/**`], evidence: 'e', order: `.orq/units/${id}/order.md`, ...over });
  const planFile = path.join(s.cwd, '.orq/plan.json');
  await fs.writeFile(planFile, JSON.stringify({ goal: 'g', units: [u('b', { deps: ['a'] }), u('a')] }));
  const ok = await orq(['plan', 'check'], s);
  assert.equal(ok.out, 'plan ok: 2 units, order: a b\n');
  assert.equal(JSON.parse((await orq(['plan', 'check', '--json'], s)).out).ok, true);
  await fs.writeFile(planFile, JSON.stringify({ goal: '', units: [u('a', { job: 'zzz' })] }));
  const bad = await orq(['plan', 'check'], s);
  assert.equal(bad.code, 4);
  assert.ok(bad.out.trim().split('\n').every((l) => l.startsWith('error: ')));
  assert.ok(bad.out.split('\n').length >= 3);
  await fs.rm(planFile);
  const missing = await orq(['plan', 'check'], s);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no plan/);
});

test('help lists the new commands', async () => {
  const s = await setup();
  const r = await orq(['help'], s);
  for (const c of ['init', 'sync', 'route', 'model', 'tier', 'config', 'plan', 'probe']) assert.match(r.out, new RegExp(`^${c} `, 'm'));
});

test('route: explicit instance limit beats the machine default', async () => {
  const s = await setup();
  await orq(['sync'], s, { stdin: caps(prov('a', ['x-mini'])) });
  const reg = await read(regFile(s));
  assert.equal(reg.instances.a.limit, null);
  reg.instances.a.limit = 3;
  await fs.writeFile(regFile(s), JSON.stringify(reg));
  await fs.mkdir(path.join(s.home, 'leases'), { recursive: true });
  await fs.writeFile(path.join(s.home, 'config.json'), '{"perInstanceLimit":1}');
  await fs.writeFile(path.join(s.home, 'leases/t1.json'), JSON.stringify({ threadId: 't1', project: 'p', unit: 'u', instance: 'a', model: 'm', startedAt: 1 }));
  assert.equal((await orq(['route', '--job', 'docs'], s)).code, 0);
});

test('sync: threads are listed before the machine lock is taken', async () => {
  const s = await setup();
  await orq(['init'], s);
  const seen = [];
  const exec = (_b, a) => {
    if (a[1] === 'list') seen.push(fsSync.existsSync(path.join(s.home, 'lock')));
    return { code: 0, stdout: a[1] === 'list' ? '[]' : 'v\n', stderr: '' };
  };
  const r = await orq(['sync'], s, { stdin: caps(prov('a', ['m-pro'])), deps: { exec } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(seen, [false]);
});

test('sync: stdin must be present and bounded', async () => {
  const s = await setup();
  const empty = await orq(['sync'], s, { stdin: '  \n' });
  assert.equal(empty.code, 2);
  assert.equal(empty.err, 'orq: sync: expects JSON on stdin\n');
  const big = await orq(['sync'], s, { stdin: ' '.repeat(8 * 1024 * 1024 + 1) });
  assert.equal(big.code, 2);
  assert.equal(big.err, 'orq: sync: input too large\n');
});

test('readStdin refuses a terminal and oversized streams', async () => {
  await assert.rejects(readStdin({ isTTY: true }), (e) => e.exitCode === 2 && /expects JSON on stdin/.test(e.message));
  const big = Readable.from([Buffer.alloc(5 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)]);
  await assert.rejects(readStdin(big), (e) => e.exitCode === 2 && /input too large/.test(e.message));
  assert.equal(await readStdin(Readable.from(['{"a":', '1}'])), '{"a":1}');
});

test('plan check: malformed plans are reported, not thrown', async () => {
  const s = await setup();
  const planFile = path.join(s.cwd, '.orq/plan.json');
  await fs.mkdir(path.dirname(planFile), { recursive: true });
  for (const bad of ['[]', '3', '{"goal":"g","units":"x"}', '{"goal":"g","units":[null]}',
    '{"goal":"g","units":[{"id":"a","title":"t","job":"implement","evidence":"e","order":".orq/o","paths":[1],"deps":"b"}]}']) {
    await fs.writeFile(planFile, bad);
    const r = await orq(['plan', 'check'], s);
    assert.equal(r.code, 4, `${bad}: ${r.err}`);
    assert.match(r.out, /^error: /m);
  }
});

test('plan check: order must stay under .orq/', async () => {
  const s = await setup();
  await fs.mkdir(path.join(s.cwd, '.orq/units'), { recursive: true });
  const planFile = path.join(s.cwd, '.orq/plan.json');
  for (const order of ['../../../etc/hosts', '/etc/hosts', '.orq/../README.md', 'README.md', '.orq']) {
    const u = { id: 'a', title: 't', job: 'implement', evidence: 'e', order, paths: ['a/**'] };
    await fs.writeFile(planFile, JSON.stringify({ goal: 'g', units: [u] }));
    const r = await orq(['plan', 'check'], s);
    assert.equal(r.code, 4, order);
    assert.match(r.out, /^error: unit a: order must be a file under \.orq\/$/m, order);
  }
});

test('config set creates .orq under the exclude step', async () => {
  const s = await setup();
  const common = path.join(s.root, 'repo/.git');
  await fs.mkdir(path.join(common, 'info'), { recursive: true });
  const exec = (b) => (b === 'git' ? { code: 0, stdout: `${common}\n`, stderr: '' } : { code: 0, stdout: 'v', stderr: '' });
  await orq(['config', 'set', 'base', 'trunk'], s, { deps: { exec } });
  assert.match(await fs.readFile(path.join(common, 'info/exclude'), 'utf8'), /^\.orq\/$/m);
});

test('sync records the orchestrator\'s own model in the project config; absent fields leave it unset', async () => {
  const s = await setup();
  await orq(['init'], s);
  assert.equal((await orq(['sync'], s, { stdin: capsFixture })).code, 0);
  assert.deepEqual((await read(path.join(s.cwd, '.orq/config.json'))).orchestrator, { instance: 'provider-a', model: 'model-small', threadId: 'mcp:thread-0003' });
  const { inheritedProviderInstanceId, inheritedModel, ...rest } = JSON.parse(capsFixture);
  assert.equal((await orq(['sync'], s, { stdin: JSON.stringify(rest) })).code, 0); // a later sync without them clears the stale record
  const cfg = await read(path.join(s.cwd, '.orq/config.json'));
  assert.equal(Object.hasOwn(cfg, 'orchestrator'), false);
  assert.equal(cfg.questions, 'auto');
});

test('plan check prints a warning per unit whose evidence runs a file outside the repository; still ok', async () => {
  const s = await setup();
  await fs.mkdir(path.join(s.cwd, '.orq/units/a'), { recursive: true });
  await fs.writeFile(path.join(s.cwd, '.orq/units/a/order.md'), 'x\n');
  await fs.writeFile(path.join(s.cwd, '.orq/plan.json'), JSON.stringify({
    goal: 'g', units: [{ id: 'a', title: 'a', job: 'implement', paths: ['a/**'], evidence: 'node .orq/verify.mjs a', order: '.orq/units/a/order.md' }],
  }));
  const r = await orq(['plan', 'check'], s);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'warning: a: evidence runs a file outside the repository (.orq/verify.mjs); a check belongs in the repository, written by a unit\nplan ok: 1 units, order: a\n');
});

test('plan check: no warning for a finished unit; the shape of what is left is printed', async () => {
  const s = await setup();
  const A = 'a'.repeat(40);
  const unit = (id, deps = []) => ({ id, title: id, job: 'implement', deps, paths: [`${id}/**`], evidence: `node .orq/verify.mjs ${id}`, order: `.orq/units/${id}/order.md` });
  for (const id of ['a', 'b', 'c', 'd']) {
    await fs.mkdir(path.join(s.cwd, `.orq/units/${id}`), { recursive: true });
    await fs.writeFile(path.join(s.cwd, `.orq/units/${id}/order.md`), 'x\n');
  }
  await fs.writeFile(path.join(s.cwd, '.orq/plan.json'), JSON.stringify({ goal: 'g', units: [unit('a'), unit('b', ['a']), unit('c', ['b']), unit('d', ['c'])] }));
  const events = [
    { type: 'plan-started', unit: null, at: 1, planId: 'p', baseSha: A, integrationBranch: 'orq/p/integration', goal: 'g' },
    { type: 'launched', unit: 'a', at: 2, attempt: 1, threadId: 't', key: 'i::m', instance: 'i', model: 'm', branch: 'orq/p/a-a1', baseSha: A, tier: 2 },
    { type: 'thread-ended', unit: 'a', at: 3, status: 'completed' },
    { type: 'gate-started', unit: 'a', at: 4, attempt: 1, headSha: A, pid: 1 },
    { type: 'gated', unit: 'a', at: 5, attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: A },
    { type: 'integrated', unit: 'a', at: 6, sha: A, head: A },
  ];
  await fs.writeFile(path.join(s.cwd, '.orq/ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const r = await orq(['plan', 'check'], s);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['warning', 'warning', 'warning', 'warning', 'plan ok']);
  assert.ok(!r.out.includes('warning: a: '));
  assert.match(lines[3], /^warning: the 3 units still to run form one chain, so they run one at a time/);
});

test('route explains the outcome record: score and attempts, and demoted', async () => {
  const s = await setup();
  const results = (n, pass) => Array.from({ length: n }, (_, i) => ({ at: NOW, pass: i < pass }));
  const m = (instance, model, implement) => ({
    instance, model, family: 'f', tier: 2, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null, outcomes: {}, results: { implement },
  });
  const inst = { enabled: true, constraints: [], limit: null, failures: 0, cooldownUntil: null };
  await fs.writeFile(regFile(s), JSON.stringify({
    version: 1, syncedAt: NOW, instances: { a: inst, b: inst },
    models: { 'a::x': m('a', 'x', results(6, 5)), 'b::y': m('b', 'y', results(6, 1)) },
  }));
  const r = await orq(['route', '--job', 'implement'], s);
  assert.equal(r.out, '1 a x tier=2 family=f unconfirmed score=0.83 n=6\n2 b y tier=2 family=f unconfirmed score=0.17 n=6 demoted\n');
});

test('U1: sync re-records the playbook its session read', async () => {
  const s = await setup();
  await orq(['init'], s);
  const cfgFile = path.join(s.cwd, '.orq/config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...(await read(cfgFile)), playbook: { hash: 'stale' } }));
  assert.equal((await orq(['sync'], s, { stdin: capsFixture })).code, 0);
  assert.match((await read(cfgFile)).playbooks._.hash, /^[0-9a-f]{16}$/); // a session without a thread id: the shared record
});
