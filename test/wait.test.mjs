import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import fsSync from 'node:fs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import { listLeases, countActive, writeLease } from '../lib/leases.mjs';
import {
  makeProject, unitSpec, commitOn, sh, REGISTRY,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const GIB = 1024 ** 3;
const quiet = { write: () => {} };
const row = (t) => ({
  threadId: t.id, projectId: 'p', status: t.status, itemCount: 1, updatedAt: new Date(t.updatedAt).toISOString(),
  title: t.title, providerInstanceId: t.instance, model: t.model,
});

// A scripted t3: each thread of a unit follows the next script; every sleep advances live threads one step.
function simulator(p, scripts) {
  const sim = { now: NOW, threads: new Map(), byUnit: {}, polls: [], n: 0, scripts };
  const ok = (v) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
  const opt = (args, name) => args[args.indexOf(name) + 1];
  sim.exec = (_bin, args, { input } = {}) => {
    if (args[0] !== 'thread') return { code: 0, stdout: 't3 v1\n', stderr: '' };
    if (args[1] === 'list') return ok([...sim.threads.values()].map(row));
    if (args[1] === 'show') {
      const t = sim.threads.get(args[2]);
      const messages = t.reply === undefined ? [] : [{ role: 'assistant', runId: 'r', text: t.reply }];
      return ok({ thread: { ...row(t), pendingRequestCount: t.pending, branch: t.branch }, messages });
    }
    if (args[1] === 'send') {
      const t = sim.threads.get(args[2]);
      sim.sends = [...(sim.sends ?? []), t.id];
      Object.assign(t, { status: 'running', updatedAt: sim.now + 1, step: 0, script: ['commit-complete'] });
      return ok({ threadId: t.id, runId: 'r', status: 'queued', delivery: 'queued' });
    }
    const unit = /^orq (\S+):/.exec(opt(args, '--title'))[1];
    sh(p.repo, 'branch', opt(args, '--branch'), opt(args, '--worktree'));
    sim.onStart?.(unit);
    sim.n += 1;
    const nth = (sim.byUnit[unit] ?? []).length;
    const t = {
      id: `th${sim.n}`, unit, title: opt(args, '--title'), status: 'running', pending: 0, updatedAt: sim.now, message: input,
      instance: opt(args, '--provider'), model: opt(args, '--model'), branch: opt(args, '--branch'),
      base: opt(args, '--worktree'), script: sim.dead?.has(opt(args, '--provider')) ? ['fail'] : sim.scripts[unit]?.[nth] ?? ['idle'], step: 0,
    };
    sim.threads.set(t.id, t);
    sim.byUnit[unit] = [...(sim.byUnit[unit] ?? []), t];
    return ok({ threadId: t.id, projectId: 'p', runId: 'r' });
  };
  sim.sleep = async (ms) => {
    sim.polls.push(countActive(await listLeases(path.join(p.home, 'leases'))));
    sim.now += ms;
    for (const t of sim.threads.values()) {
      if (t.status !== 'running') continue;
      const step = t.script[Math.min(t.step, t.script.length - 1)];
      t.step += 1;
      if (step === 'idle') continue;
      t.updatedAt = sim.now;
      if (step === 'block') t.pending = 1;
      if (step === 'unblock') t.pending = 0;
      if (step === 'fail') t.status = 'failed';
      if (step === 'needs-context') Object.assign(t, { status: 'completed', reply: 'NEEDS_CONTEXT\nThe work order says 41 but the test wants 42.' });
      if (step === 'commit-complete') {
        await commitOn(p.repo, t.branch, { [`${t.unit}.txt`]: `${t.unit}\n` }, t.unit);
        t.status = 'completed';
      }
    }
  };
  return sim;
}

async function orq(args, p, sim, extra = {}) {
  const out = [];
  const err = [];
  const ctx = {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo,
    now: () => sim.now, sleep: sim.sleep,
    deps: {
      exec: sim.exec,
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
      isAlive: () => false,
      // run the gate in-process; the detached path is covered in effects.test.mjs
      spawnGate: async ({ cwd, env, args: a }) => {
        await run(['gate-run', ...a], { stdout: quiet, stderr: quiet, env, cwd });
        return 999999;
      },
      ...extra,
    },
  };
  const code = await run(args, ctx);
  return { code, out: out.join(''), err: err.join('') };
}

test('wait: end-to-end with completing, blocking and provider-failing threads', async (t) => {
  const units = [unitSpec('a'), unitSpec('b', { deps: ['a'] }), unitSpec('c')];
  const p = await makeProject(t, units, { cap: 2, checks: { full: 'test -f a.txt && test -f b.txt && test -f c.txt' } });
  const sim = simulator(p, {
    a: [['commit-complete']],
    b: [['block', 'unblock', 'commit-complete']],
    c: [['fail'], ['commit-complete']],
  });
  const first = await orq(['wait'], p, sim);
  assert.equal(first.code, 0, first.err);
  const bThread = sim.byUnit.b[0].id;
  assert.equal(first.out, `blocked: b waiting on a request in thread ${bThread}\n`);

  const second = await orq(['wait'], p, sim);
  assert.equal(second.code, 0, second.err);
  const st = await readState(p.repo);
  const head = st.plan.integrationHead;
  assert.equal(second.out, `done: 3 units integrated at ${head.slice(0, 12)}; final checks pass\n`);
  assert.deepEqual(units.map((u) => unitOf(st, u.id).state), ['integrated', 'integrated', 'integrated']);

  const c = unitOf(st, 'c');
  assert.equal(c.providerFailures, 1);
  assert.equal(sim.byUnit.c.length, 2);
  assert.notEqual(sim.byUnit.c[0].instance + sim.byUnit.c[0].model, sim.byUnit.c[1].instance + sim.byUnit.c[1].model);
  assert.equal(sim.byUnit.a[0].base, p.baseSha);
  const aSha = sh(p.repo, 'rev-parse', sim.byUnit.a[0].branch);
  sh(p.repo, 'merge-base', '--is-ancestor', aSha, sim.byUnit.b[0].base);
  assert.ok(sim.polls.length > 5);
  assert.ok(sim.polls.every((n) => n <= 2), `cap exceeded: ${sim.polls}`);
  assert.equal(sim.byUnit.a.length + sim.byUnit.b.length, 2);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  for (const f of ['a.txt', 'b.txt', 'c.txt']) await fs.stat(path.join(p.repo, '.orq', 'integration', f));

  // the plan grows after done: the next wait launches, integrates, re-runs the final gate on the new head
  await fs.writeFile(path.join(p.repo, '.orq', 'orders', 'd.md'), 'Work order for d.\n');
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'test goal', units: [...units, unitSpec('d')] }));
  sim.scripts.d = [['commit-complete']];
  const third = await orq(['wait'], p, sim);
  assert.equal(third.code, 0, third.err);
  const grown = await readState(p.repo);
  assert.notEqual(grown.plan.integrationHead, head);
  assert.equal(sim.byUnit.d[0].base, head);
  assert.equal(grown.plan.final.head, grown.plan.integrationHead);
  assert.equal(third.out, `done: 4 units integrated at ${grown.plan.integrationHead.slice(0, 12)}; final checks pass\n`);
});

test('wait: three provider failures return for judgment', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['fail'], ['fail'], ['fail']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'judgment: a: 3 provider failures\n');
  assert.equal(new Set(sim.byUnit.a.map((x) => `${x.instance}::${x.model}`)).size, 3);
});

test('wait: nothing routable returns idle', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { registry: { version: 1, syncedAt: null, instances: {}, models: {} } });
  const sim = simulator(p, {});
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'idle: no model for a: no usable model in registry; run sync\n');
});

test('wait: returns on timeout within its time budget', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['idle']] });
  const started = Date.now();
  const r = await orq(['wait', '--max-seconds', '40'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'timeout: 1 running, 0 blocked, 0 gating, 0 queued, 0 passed\n');
  assert.ok(sim.now - NOW <= 40_000, `fake time used ${sim.now - NOW}`);
  assert.ok(Date.now() - started < 10_000);
  assert.equal((await orq(['wait', '--max-seconds', '0'], p, sim)).code, 2);
});

test('wait: a second wait in the same project fails at once', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, {});
  await fs.writeFile(path.join(p.repo, '.orq', 'runner.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 5);
  assert.equal(r.err, `orq: another orq wait is running (pid ${process.pid})\n`);
});

test('wait: refuses without a valid plan or a usable t3', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, {});
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'g', units: [] }));
  const noPlan = await orq(['wait'], p, sim);
  assert.equal(noPlan.code, 4);
  assert.equal(noPlan.err, 'orq: no valid plan; run "orq plan check"\n');
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'g', units: [unitSpec('a')] }));
  await fs.writeFile(path.join(p.repo, '.orq', 'config.json'), JSON.stringify({ t3: null }));
  const noT3 = await orq(['wait'], p, sim);
  assert.equal(noT3.code, 1);
  assert.equal(noT3.err, 'orq: no usable t3; run "orq init"\n');
});

test('wait: a launch interrupted before its ledger append is adopted, not repeated', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, {});
  await commit(p.repo, () => [{ type: 'plan-started', unit: null, at: NOW, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' }]);
  const branch = 'orq/p1/a-a1';
  sh(p.repo, 'branch', branch, p.baseSha);
  sim.threads.set('th9', {
    id: 'th9', unit: 'a', title: 'orq a: do a', status: 'running', pending: 0, updatedAt: NOW, instance: 'pa', model: 'm2',
    branch, base: p.baseSha, script: ['commit-complete'], step: 0,
  });
  const dir = path.join(p.home, 'leases');
  await writeLease(dir, {
    threadId: 'th9', project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false,
    attempt: 1, launch: 1, key: 'pa::m2', branch, baseSha: p.baseSha, tier: 2, family: 'f',
  });
  await writeLease(dir, {
    threadId: 'reserve-1-a-a1', project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: NOW - 3 * 60_000, blocked: false, reservation: true,
  });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 1 units integrated at /);
  assert.equal(sim.n, 0, 'no second thread was started');
  assert.equal(unitOf(await readState(p.repo), 'a').launches, 1);
  assert.deepEqual(await listLeases(dir), []);
});

test('wait: a unit dropped while its launch is in flight leaves a note, not a crash', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['idle']] });
  sim.onStart = (unit) => fsSync.appendFileSync(path.join(p.repo, '.orq', 'ledger.jsonl'), `${JSON.stringify({ type: 'dropped', unit, at: NOW })}\n`);
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `done: 0 units integrated at ${p.baseSha.slice(0, 12)}; final checks none\n`
    + 'note: unit a was dropped while launching; thread th1 left running — interrupt it\n');
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
});

test('wait: feedback deferred by a full machine times out instead of idling, then is sent when a slot frees', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { cap: 1 });
  const sim = simulator(p, {});
  const branch = 'orq/p1/a-a1';
  sh(p.repo, 'branch', branch, p.baseSha);
  await commit(p.repo, () => [
    { type: 'plan-started', unit: null, at: NOW, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' },
    { type: 'launched', unit: 'a', at: NOW, attempt: 1, threadId: 'th1', key: 'pa::m2', instance: 'pa', model: 'm2', branch, baseSha: p.baseSha, tier: 2, family: 'f' },
    { type: 'thread-ended', unit: 'a', at: NOW, status: 'completed' },
    { type: 'gate-started', unit: 'a', at: NOW, attempt: 1, headSha: p.baseSha, pid: 1 },
    { type: 'gated', unit: 'a', at: NOW, attempt: 1, verdict: 'fail', failures: ['evidence failed (exit 1)'], flags: [], headSha: p.baseSha },
  ]);
  sim.threads.set('th1', {
    id: 'th1', unit: 'a', title: 'orq a: do a', status: 'completed', pending: 0, updatedAt: NOW - 1, instance: 'pa', model: 'm2', branch, script: ['idle'], step: 0,
  });
  const dir = path.join(p.home, 'leases');
  await writeLease(dir, { threadId: 'busy', project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false });
  const full = await orq(['wait', '--max-seconds', '30'], p, sim);
  assert.equal(full.code, 0, full.err);
  assert.equal(full.out, 'timeout: 0 running, 0 blocked, 0 gating, 1 queued, 0 passed\n');
  assert.equal(sim.sends, undefined);
  await fs.rm(path.join(dir, 'busy.json'));
  const freed = await orq(['wait'], p, sim);
  assert.equal(freed.code, 0, freed.err);
  assert.deepEqual(sim.sends, ['th1']);
  assert.match(freed.out, /^done: 1 units integrated at /);
});

test('wait: a dead instance is avoided and cooled down; every unit still integrates', async (t) => {
  const registry = { ...REGISTRY, instances: { ...REGISTRY.instances, pb: { ...REGISTRY.instances.pb, limit: 1 } } };
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')], { cap: 3, registry });
  const ok = [['commit-complete']];
  const sim = simulator(p, { a: [...ok, ...ok, ...ok], b: [...ok, ...ok, ...ok], c: [...ok, ...ok, ...ok] });
  sim.dead = new Set(['pa']);
  const all = () => Object.values(sim.byUnit).flat();
  let r = await orq(['wait'], p, sim);
  for (let i = 0; i < 3 && !r.out.startsWith('done:'); i += 1) r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 3 units integrated at /);
  const st = await readState(p.repo);
  assert.deepEqual(['a', 'b', 'c'].map((u) => unitOf(st, u).state), ['integrated', 'integrated', 'integrated']);
  assert.ok(all().filter((x) => x.instance === 'pa').length <= 2, 'launches on the dead instance');
  const reg = JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));
  assert.ok(reg.instances.pa.cooldownUntil > sim.now, 'dead instance cooled down');
});

test('wait: one dying instance cools down and waits instead of burning all three attempts', async (t) => {
  const model = (name, tier) => [`pa::${name}`, { ...REGISTRY.models['pa::m2'], model: name, tier }];
  const registry = { ...REGISTRY, instances: { pa: REGISTRY.instances.pa }, models: Object.fromEntries([model('m2', 2), model('m2x', 2), model('m3', 3)]) };
  const p = await makeProject(t, [unitSpec('a')], { registry });
  const sim = simulator(p, {});
  sim.dead = new Set(['pa']);
  const first = await orq(['wait'], p, sim);
  assert.equal(first.code, 0, first.err);
  const reg = JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));
  const until = reg.instances.pa.cooldownUntil;
  assert.equal(first.out, `idle: no model for a: none eligible: excluded, cooling down; retry at ${new Date(until).toISOString()}\n`);
  assert.equal(reg.instances.pa.failures, 2);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.providerFailures], ['queued', 2]);
  assert.equal(sim.n, 2);
  sim.now = until + 1;
  const later = await orq(['wait'], p, sim);
  assert.equal(later.code, 0, later.err);
  assert.equal(sim.n, 3);
  assert.equal(later.out, 'judgment: a: 3 provider failures\n');
});

test('wait: a worker asking for context returns for judgment without a gate', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const gates = [];
  const sim = simulator(p, { a: [['needs-context']] });
  const r = await orq(['wait'], p, sim, { spawnGate: async () => { gates.push(1); return 1; } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'judgment: a: worker reported NEEDS_CONTEXT: The work order says 41 but the test wants 42.\n');
  assert.equal(gates.length, 0);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.providerFailures], ['failed', 0]);
});
