import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../lib/cli.mjs';
import { defaultExec as gitExecReal } from '../lib/git.mjs';
import fsSync from 'node:fs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import { readLines } from '../lib/store.mjs';
import { listLeases, countActive, writeLease } from '../lib/leases.mjs';
import {
  makeProject, unitSpec, commitOn, sh, REGISTRY,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const GIB = 1024 ** 3;
const quiet = { write: () => {} };
const row = (t) => ({
  threadId: t.id, projectId: 'p', status: t.status, itemCount: 1, updatedAt: new Date(t.updatedAt).toISOString(),
  title: t.title, providerInstanceId: t.instance, model: t.model, ...(t.settled !== undefined ? { settled: t.settled } : {}),
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
      id: `th${sim.n}`, unit, settled: sim.settled, title: opt(args, '--title'), status: 'running', pending: 0, updatedAt: sim.now, message: input,
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
      if (step === 'commit-fail') { // committed its work, then its provider died
        await commitOn(p.repo, t.branch, { [`${t.unit}.txt`]: `${t.unit}\n` }, t.unit);
        t.status = 'failed';
      }
      if (step === 'complete') t.status = 'completed'; // finished without a new commit
      if (step === 'throttle') t.status = 'throttled'; // a status orq does not know; T3 never moves it again
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
  assert.equal(full.out, 'timeout: 0 running, 0 blocked, 0 gating, 1 queued, 0 passed\nwaiting: 1 ready units wait for a free slot (machine cap 1, or a provider instance limit)\n');
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
  assert.equal(first.out, `idle: no model for a: all cooling down; retry at ${new Date(until).toISOString()}\n`);
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

test('wait: after archiving, the next request runs a fresh plan cut from the base', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete']], b: [['commit-complete']] });
  const first = await orq(['wait'], p, sim);
  assert.match(first.out, /^done: 1 units integrated at /);
  const old = (await readState(p.repo)).plan;
  sim.now += 60_000;
  const archived = await orq(['plan', 'archive'], p, sim);
  assert.equal(archived.code, 0, archived.err);
  assert.match(archived.out, new RegExp(`^archived: plan ${old.planId} \\(1 integrated, 0 not\\)`));
  await fs.mkdir(path.join(p.repo, '.orq', 'orders'), { recursive: true });
  await fs.writeFile(path.join(p.repo, '.orq', 'orders', 'b.md'), 'Work order for b.\n');
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'second request', units: [unitSpec('b')] }));
  const second = await orq(['wait'], p, sim);
  assert.equal(second.code, 0, second.err);
  const now = (await readState(p.repo)).plan;
  assert.match(second.out, new RegExp(`^done: 1 units integrated at ${now.integrationHead.slice(0, 12)}`));
  assert.notEqual(now.planId, old.planId);
  assert.notEqual(now.integrationBranch, old.integrationBranch);
  assert.equal(now.baseSha, p.baseSha);
  assert.equal(sim.byUnit.b[0].base, p.baseSha);
  const contains = (ancestor, ref) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, ref], { cwd: p.repo }).status === 0;
  assert.equal(contains(old.integrationHead, now.integrationHead), false);
  assert.equal(contains(p.baseSha, now.integrationHead), true);
  sh(p.repo, 'rev-parse', '--verify', `refs/heads/${old.integrationBranch}`);
  await fs.stat(path.join(p.repo, '.orq', 'archive', old.planId, 'ledger.jsonl'));
});

test('wait: an unreadable worker report is gated as usual, never wedges the unit', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete']] });
  const exec = (bin, args, o) => (args[1] === 'show' && sim.threads.get(args[2])?.status === 'completed'
    ? { code: 1, stdout: '', stderr: 'spawnSync t3 ENOBUFS' }
    : sim.exec(bin, args, o));
  const r = await orq(['wait'], p, sim, { exec });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 1 units integrated at /);
  assert.equal(unitOf(await readState(p.repo), 'a').state, 'integrated');
});

test('wait: failed final checks never print "done:"; they print final-fail with the failures', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { checks: { full: 'echo broken; exit 3' } });
  const sim = simulator(p, { a: [['commit-complete']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  assert.equal(st.plan.final.verdict, 'fail');
  assert.equal(r.out, `final-fail: 1 units integrated at ${st.plan.integrationHead.slice(0, 12)}; ${st.plan.final.failures.join('; ')}\n`);
});

test('wait: with one routable model a provider failure waits out the backoff and retries it, up to 3 failures', async (t) => {
  const registry = { ...REGISTRY, instances: { pa: REGISTRY.instances.pa }, models: { 'pa::m2': REGISTRY.models['pa::m2'] } };
  const p = await makeProject(t, [unitSpec('a')], { registry });
  const sim = simulator(p, { a: [['fail'], ['fail'], ['fail']] });
  const outs = [];
  for (let i = 0; i < 5 && !outs.at(-1)?.startsWith('judgment:'); i += 1) {
    const r = await orq(['wait'], p, sim);
    assert.equal(r.code, 0, r.err);
    outs.push(r.out);
    const m = /retry at (\S+)\n$/.exec(r.out);
    if (m) sim.now = Date.parse(m[1]) + 1;
  }
  assert.match(outs[0], /^idle: no model for a: all cooling down; retry at /);
  assert.equal(outs.at(-1), 'judgment: a: 3 provider failures\n');
  assert.equal(sim.byUnit.a.length, 3);
  assert.ok(sim.byUnit.a.every((x) => x.model === 'm2'));
});

test('wait and status name a unit launched below its wanted tier, and the model used', async (t) => {
  const registry = { ...REGISTRY, instances: { pa: REGISTRY.instances.pa }, models: { 'pa::m2': REGISTRY.models['pa::m2'] } };
  const p = await makeProject(t, [unitSpec('a', { job: 'implement-complex' })], { registry });
  const sim = simulator(p, { a: [['commit-complete']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const [first, ...rest] = r.out.trim().split('\n');
  assert.match(first, /^done: 1 units integrated/);
  assert.deepEqual(rest, ['note: unit a wanted tier 3; launched on pa::m2 (tier 2), the best available']);
  const s = await orq(['status'], p, sim);
  assert.match(s.out, /^a integrated attempt=1 model=pa::m2 tier=2 wanted_tier=3 thread=/m);
});

const foreign = { threadId: 'other-th', project: '/other-project', unit: 'z', instance: 'pb', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false };

test('wait: when another project holds the whole machine cap it keeps polling and times out naming the wait for a slot', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')], { cap: 1 });
  await writeLease(path.join(p.home, 'leases'), foreign);
  const sim = simulator(p, {});
  const r = await orq(['wait', '--max-seconds', '60'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'timeout: 0 running, 0 blocked, 0 gating, 2 queued, 0 passed\nwaiting: 2 ready units wait for a free slot (machine cap 1, or a provider instance limit)\n');
  assert.ok(sim.polls.length >= 3, `polled ${sim.polls.length} times`);
  assert.equal(sim.n, 0);
});

test('wait: a launch refused at the machine lock (another project took the slot) is reported as the cap, not as dependencies', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')], { cap: 1 });
  const dir = path.join(p.home, 'leases');
  let raced = false;
  const gitExec = (cmd, args, o) => {
    // another project's launch lands between this tick and the reservation
    if (!raced) { raced = true; fsSync.mkdirSync(dir, { recursive: true }); fsSync.writeFileSync(path.join(dir, `${foreign.threadId}.json`), JSON.stringify(foreign)); }
    return gitExecReal(cmd, args, o);
  };
  const sim = simulator(p, {});
  const r = await orq(['wait', '--max-seconds', '30'], p, sim, { gitExec });
  assert.equal(r.code, 0, r.err);
  assert.equal(raced, true);
  assert.equal(r.out, 'timeout: 0 running, 0 blocked, 0 gating, 2 queued, 0 passed\nwaiting: 2 ready units wait for a free slot (machine cap 1, or a provider instance limit)\n');
});

test('wait: after final-fail, narrowing checks.full and "orq unit retry integration" runs the final gate again', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { checks: { full: 'echo broken; exit 3' } });
  const sim = simulator(p, { a: [['commit-complete']] });
  assert.match((await orq(['wait'], p, sim)).out, /^final-fail: 1 units integrated at /);
  assert.match((await orq(['wait'], p, sim)).out, /^final-fail: /); // nothing changed: same answer
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  const cfg = JSON.parse(await fs.readFile(cfgFile, 'utf8'));
  await fs.writeFile(cfgFile, JSON.stringify({ ...cfg, checks: { ...cfg.checks, full: 'test -f a.txt' } }));
  const retried = await orq(['unit', 'retry', 'integration'], p, sim);
  assert.equal(retried.code, 0, retried.err);
  assert.equal(retried.out, 'retried integration: the final gate will run again\n');
  const head = (await readState(p.repo)).plan.integrationHead;
  assert.equal((await orq(['wait'], p, sim)).out, `done: 1 units integrated at ${head.slice(0, 12)}; final checks pass\n`);
  assert.equal((await orq(['unit', 'retry', 'integration'], p, sim)).err, 'orq: the final gate is not stuck; nothing to retry\n');
});

test('wait: after final-fail, an appended fix unit integrates and the final gate runs on the new head', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { checks: { full: 'test -f f.txt' } });
  const sim = simulator(p, { a: [['commit-complete']], f: [['commit-complete']] });
  assert.match((await orq(['wait'], p, sim)).out, /^final-fail: /);
  await fs.writeFile(path.join(p.repo, '.orq', 'orders', 'f.md'), 'Work order for f.\n');
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'test goal', units: [unitSpec('a'), unitSpec('f', { job: 'fix', deps: ['a'] })] }));
  const r = await orq(['wait'], p, sim);
  const head = (await readState(p.repo)).plan.integrationHead;
  assert.equal(r.out, `done: 2 units integrated at ${head.slice(0, 12)}; final checks pass\n`);
});

test('wait: the slot line counts only ready units, not those waiting on dependencies', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b', { deps: ['a'] }), unitSpec('c')], { cap: 1 });
  await writeLease(path.join(p.home, 'leases'), foreign);
  const r = await orq(['wait', '--max-seconds', '30'], p, simulator(p, {}));
  assert.equal(r.out, 'timeout: 0 running, 0 blocked, 0 gating, 3 queued, 0 passed\nwaiting: 2 ready units wait for a free slot (machine cap 1, or a provider instance limit)\n');
});

test('wait and status name a machine cap override above what the machine computes, once per wait', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { cap: 18 });
  const sim = simulator(p, { a: [['commit-complete']] });
  const r = await orq(['wait'], p, sim);
  const note = 'note: cap 18 is an override; this machine computes 4 (cpu: 8 cores allow 4)';
  assert.deepEqual(r.out.trim().split('\n').slice(1), [note]);
  assert.ok(r.out.trim().split('\n')[0].startsWith('done: '));
  assert.ok((await orq(['status'], p, sim)).out.split('\n').includes(note));
  const fine = await makeProject(t, [unitSpec('a')], { cap: 3 });
  assert.doesNotMatch((await orq(['status'], fine, simulator(fine, {}))).out, /is an override/);
});

test('wait: a worker whose provider failed after committing is continued on another model; the gate judges the inherited work', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-fail'], ['complete']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const [first, ...notes] = r.out.trim().split('\n');
  assert.match(first, /^done: 1 units integrated at /);
  const [a1, a2] = sim.byUnit.a;
  assert.deepEqual(notes, [`note: unit a continues on ${a2.instance}::${a2.model} from 1 commits left by ${a1.instance}::${a1.model}`]);
  assert.notEqual(`${a1.instance}::${a1.model}`, `${a2.instance}::${a2.model}`);
  assert.equal(a2.base, sh(p.repo, 'rev-parse', a1.branch)); // started at the failed branch head
  assert.match(a2.message, /^## Hand-over\n/);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.baseSha], ['integrated', p.baseSha]);
  await fs.stat(path.join(p.repo, '.orq', 'integration', 'a.txt'));
  assert.match((await orq(['status'], p, sim)).out, /^a integrated attempt=1 model=\S+ tier=2 continued thread=/m);
});

test('wait: a unit with setup: false skips checks.setup; others still run it; the warning for outside evidence is a note', async (t) => {
  const p = await makeProject(t, [unitSpec('docs', { setup: false }), unitSpec('code', { evidence: 'test -f code.txt && test -f /etc/hosts' })],
    { cap: 2, checks: { setup: 'exit 7' } });
  const sim = simulator(p, { docs: [['commit-complete']], code: [['commit-complete']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  assert.equal(unitOf(st, 'docs').state, 'integrated');
  assert.equal(unitOf(st, 'code').state, 'failed');
  assert.match(unitOf(st, 'code').reason, /^setup failed \(exit 7\)/);
  assert.doesNotMatch(r.out, /warning:/); // /etc is a system location, not a check of the orchestrator's
  const q = await makeProject(t, [unitSpec('a', { evidence: 'node /srv/checks/a.mjs' })]);
  const w = await orq(['wait', '--max-seconds', '20'], q, simulator(q, { a: [['idle']] }));
  assert.ok(w.out.split('\n').includes('warning: a: evidence runs a file outside the repository (/srv/checks/a.mjs); a check belongs in the repository, written by a unit'), w.out);
});

test('wait: a thread with an unknown status is read as running, noted once, and given up when it stays quiet', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(cfgFile, 'utf8')), stallMinutes: 1 }));
  const sim = simulator(p, { a: [['throttle'], ['commit-complete']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const [first, ...notes] = r.out.trim().split('\n');
  assert.match(first, /^done: 1 units integrated at /);
  const [a1] = sim.byUnit.a;
  assert.equal(notes.filter((n) => n.includes('does not know')).length, 1);
  assert.ok(notes.includes(`note: thread ${a1.id} has status "throttled" that this version does not know; treated as running`), notes.join('\n'));
  assert.ok(notes.some((n) => /^note: unit a gave up on thread \S+ \(quiet for 2 min\); it still holds a slot until it ends: interrupt it \(t3_thread_interrupt\)$/.test(n)), notes.join('\n'));
  assert.equal(sim.byUnit.a.length, 2);
  assert.equal((await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'thread-ended' && e.status === 'stalled').length, 1);
});

test('wait: a settle line names finished unsettled threads, after the decision line and before the notes', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { cap: 18 }); // the cap override adds a note
  const sim = simulator(p, { a: [['commit-fail'], ['complete']] });
  sim.settled = false;
  const r = await orq(['wait'], p, sim);
  const lines = r.out.trim().split('\n');
  const [a1, a2] = sim.byUnit.a;
  assert.match(lines[0], /^done: /);
  assert.equal(lines[1], `settle: ${a1.id} ${a2.id}`);
  assert.match(lines[2], /^note: cap 18 is an override/);
  assert.ok(lines.slice(3).every((l) => l.startsWith('note: ')));
  const s = await orq(['settle'], p, sim);
  assert.deepEqual([s.code, s.out], [0, `${a1.id} unit a replaced\n${a2.id} unit a integrated\n`]);
  for (const th of sim.threads.values()) th.settled = true;
  assert.equal((await orq(['settle'], p, sim)).out, 'nothing to settle\n');
});

test('settle --all also covers archived plans; archive points at it when finished threads are left unsettled', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete']], b: [['commit-complete']] });
  sim.settled = false;
  await orq(['wait'], p, sim);
  sim.now += 60_000;
  const archived = await orq(['plan', 'archive'], p, sim);
  assert.equal(archived.code, 0, archived.err);
  assert.ok(archived.out.split('\n').includes('settle: run "orq settle --all"'), archived.out);
  const a1 = sim.byUnit.a[0].id;
  assert.equal((await orq(['settle'], p, sim)).out, 'nothing to settle\n'); // no current plan
  assert.equal((await orq(['settle', '--all'], p, sim)).out, `${a1} unit a integrated\n`);
  sim.threads.get(a1).settled = true;
  assert.equal((await orq(['settle', '--all'], p, sim)).out, 'nothing to settle\n');
  assert.equal((await orq(['settle', 'x'], p, sim)).code, 2);
});

test('wait: with cap 1 a given-up thread still holds the slot; the continuation launches once T3 shows it ended', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { cap: 1 });
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(cfgFile, 'utf8')), stallMinutes: 1 }));
  const sim = simulator(p, { a: [['throttle'], ['commit-complete']] });
  const first = await orq(['wait', '--max-seconds', '400'], p, sim);
  assert.match(first.out, /^timeout: 0 running, 0 blocked, 0 gating, 1 queued, 0 passed\n/);
  assert.equal(sim.byUnit.a.length, 1); // no second worker while the first may still run
  assert.ok(sim.polls.every((n) => n <= 1), `cap exceeded: ${sim.polls}`);
  const [lease] = await listLeases(path.join(p.home, 'leases'));
  assert.deepEqual([lease.threadId, lease.abandoned], [sim.byUnit.a[0].id, true]);
  assert.match((await orq(['status'], p, sim)).out, new RegExp(`^abandoned: thread ${sim.byUnit.a[0].id} of unit a holds a slot until it ends$`, 'm'));
  sim.byUnit.a[0].status = 'interrupted'; // the orchestrator interrupted it
  const second = await orq(['wait'], p, sim);
  assert.match(second.out, /^done: 1 units integrated at /);
  assert.equal(sim.byUnit.a.length, 2);
});
