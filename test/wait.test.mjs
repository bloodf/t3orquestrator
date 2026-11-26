import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
const LIMIT_REPLY = 'Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 5 days, 4 hours.';
const CLAUDE_LIMIT_REPLY = "You've hit your Fable limit · resets Nov 13 at 12am (America/Sao_Paulo). Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
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
      Object.assign(t, { status: 'running', updatedAt: sim.now + 1, step: 0, script: [sim.afterSend ?? (sim.stubborn ? 'complete' : 'commit-complete')] });
      return ok({ threadId: t.id, runId: 'r', status: 'queued', delivery: 'queued' });
    }
    const unit = /^orq\/[^/]+\/(.+)-a\d+(?:-l\d+)?$/.exec(opt(args, '--branch'))[1];
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
      if (step === 'blocked') Object.assign(t, { status: 'completed', reply: 'BLOCKED: implementation incomplete, nothing committed' });
      if (step === 'blocked-again') Object.assign(t, { status: 'completed', reply: 'BLOCKED\nneed the staging password; looked in .env and README' });
      if (step === 'commit-fail') { // committed its work, then its provider died
        await commitOn(p.repo, t.branch, { [`${t.unit}.txt`]: `${t.unit}\n` }, t.unit);
        t.status = 'failed';
      }
      if (step === 'limit') Object.assign(t, { status: 'failed', reply: LIMIT_REPLY }); // seen on antigravity
      if (step === 'limit-complete') Object.assign(t, { status: 'completed', reply: CLAUDE_LIMIT_REPLY }); // a limit reply as a finished turn
      if (step === 'commit-limit') { // committed part of its work, then its account ran out
        await commitOn(p.repo, t.branch, { [`${t.unit}.txt`]: `${t.unit}\n` }, t.unit);
        Object.assign(t, { status: 'failed', reply: LIMIT_REPLY });
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
  assert.equal(first.out, `pending: unit b: thread ${bThread} waits on a request: answer it (t3_pending_request, action "respond") or interrupt the thread (t3_thread_interrupt) so orq replaces it\n`);

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

test('wait: done with a standing goal adds goal: and next:; without one the done line stands alone', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { checks: { full: 'test -f a.txt' } });
  const cfg = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfg, JSON.stringify({ ...JSON.parse(await fs.readFile(cfg, 'utf8')), goal: 'ship it' }));
  const r = await orq(['wait'], p, simulator(p, { a: [['commit-complete']] }));
  assert.equal(r.code, 0, r.err);
  const [done, goal, next, ...rest] = r.out.split('\n');
  assert.match(done, /^done: 1 units integrated at [0-9a-f]{12}; final checks pass$/);
  assert.deepEqual([goal, next, rest], ['goal: ship it', 'next: the goal is still open: finish this plan as the playbook says, run "orq plan archive", then plan the next part and call "orq wait" again in this same turn', ['']]);
});

test('wait: refuses without a valid plan or a usable t3', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, {});
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'g', units: [] }));
  const noPlan = await orq(['wait'], p, sim);
  assert.equal(noPlan.code, 4);
  assert.equal(noPlan.err, 'orq: no valid plan; run "orq plan check"\n');
  const cfg = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfg, JSON.stringify({ ...JSON.parse(await fs.readFile(cfg, 'utf8')), goal: 'ship it' }));
  const invalid = await orq(['wait'], p, sim); // a plan that exists but is invalid: not told to plan its next part
  assert.equal(invalid.err, 'orq: no valid plan; run "orq plan check"\n');
  await fs.rm(path.join(p.repo, '.orq', 'plan.json'));
  const withGoal = await orq(['wait'], p, sim);
  assert.equal(withGoal.code, 4);
  assert.equal(withGoal.err, 'orq: no valid plan; run "orq plan check"\ngoal: ship it\nnext: the goal is still open: plan its next part, run "orq plan check", then call "orq wait"\n');
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

test('wait: a worker asking for context is told once to go on in the same thread, then returns for judgment without a gate', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const gates = [];
  const sim = simulator(p, { a: [['needs-context']] });
  sim.afterSend = 'needs-context';
  const r = await orq(['wait'], p, sim, { spawnGate: async () => { gates.push(1); return 1; } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'judgment: a: worker reported NEEDS_CONTEXT: The work order says 41 but the test wants 42.\n');
  assert.equal(gates.length, 0);
  assert.deepEqual(sim.sends, ['th1']);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.providerFailures, u.nudges], ['failed', 0, 1]);
});

test('wait: a worker that answers BLOCKED every time ends in a judgment with its second reason: one message, never a loop', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['blocked'], ['blocked'], ['blocked']] });
  sim.afterSend = 'blocked-again';
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'judgment: a: worker reported BLOCKED: need the staging password; looked in .env and README\n');
  assert.deepEqual(sim.sends, ['th1']);
  assert.equal(sim.byUnit.a.length, 1);
  const sent = (await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'unfinished');
  assert.deepEqual(sent.map((e) => [e.stop, e.failures]), [['BLOCKED', ['worker reported BLOCKED: implementation incomplete, nothing committed']]]);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.launches, u.nudges], ['failed', 1, 1]);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  const again = await orq(['wait', '--max-seconds', '20'], p, sim); // and it stays there
  assert.match(again.out, /^judgment: a: worker reported BLOCKED/);
  assert.deepEqual([sim.sends.length, sim.byUnit.a.length], [1, 1]);
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
  assert.equal(outs.at(-1).split('\n')[0], 'judgment: a: 3 provider failures');
  assert.ok(outs.some((o) => o.includes('note: unit a relaunched on pa::m2, a model an earlier attempt used: no unused model is eligible\n'))); // the only model: said so
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
  assert.match(s.out, /^a integrated attempt=1 model=pa::m2 tier=2 wanted_tier=3 used=pa::m2 thread=/m);
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
  assert.deepEqual(notes, [`note: unit a continues on ${a2.instance}::${a2.model} from 1 commit left by ${a1.instance}::${a1.model}`]);
  assert.notEqual(`${a1.instance}::${a1.model}`, `${a2.instance}::${a2.model}`);
  assert.equal(a2.base, sh(p.repo, 'rev-parse', a1.branch)); // started at the failed branch head
  assert.match(a2.message, /^## Hand-over\n/);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.baseSha], ['integrated', p.baseSha]);
  await fs.stat(path.join(p.repo, '.orq', 'integration', 'a.txt'));
  assert.match((await orq(['status'], p, sim)).out, /^a integrated attempt=1 model=\S+ tier=2 used=\S+,\S+ continued rerouted=\S+->\S+\(failed\) thread=/m);
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
  assert.ok(w.out.split('\n').includes('note: 1 units run evidence outside the repository (a); run "orq plan check" for the list'), w.out);
  assert.doesNotMatch(w.out, /^warning:/m); // one note, not a line per unit: plan check keeps those
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

test('G1: a plan.json replaced before archiving is refused; archive keeps it and archives the ledger; the next wait runs it fresh', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete']], b: [['commit-complete']] });
  assert.match((await orq(['wait'], p, sim)).out, /^done: /);
  const old = (await readState(p.repo)).plan;
  const planFile = path.join(p.repo, '.orq', 'plan.json');
  await fs.writeFile(path.join(p.repo, '.orq', 'orders', 'b.md'), 'Work order for b.\n');
  const next = JSON.stringify({ goal: 'next request', units: [unitSpec('b')] });
  await fs.writeFile(planFile, next);
  const msg = 'plan.json no longer lists units the ledger knows (a); this looks like a new request: restore plan.json or run "orq plan archive" first';
  const check = await orq(['plan', 'check'], p, sim);
  assert.deepEqual([check.code, check.out], [4, `error: ${msg}\n`]);
  const w = await orq(['wait'], p, sim);
  assert.deepEqual([w.code, w.err], [4, `orq: ${msg}\n`]);
  // appending units is still a growing plan, not a new request
  await fs.writeFile(planFile, JSON.stringify({ goal: 'test goal', units: [unitSpec('a'), unitSpec('b')] }));
  assert.equal((await orq(['plan', 'check'], p, sim)).code, 0);
  await fs.writeFile(planFile, next);
  sim.now += 60_000;
  const archived = await orq(['plan', 'archive'], p, sim);
  assert.equal(archived.code, 0, archived.err);
  assert.ok(archived.out.split('\n').includes('note: plan.json did not match the ledger; archived the ledger and kept plan.json for the next request'), archived.out);
  assert.equal(await fs.readFile(planFile, 'utf8'), next);
  const dir = path.join(p.repo, '.orq', 'archive', old.planId);
  assert.equal(fsSync.existsSync(path.join(dir, 'ledger.jsonl')), true);
  assert.equal(fsSync.existsSync(path.join(dir, 'plan.json')), false); // the new request's plan was not archived as the old one
  await fs.stat(path.join(p.repo, '.orq', 'orders', 'b.md')); // its work orders stay too
  const fresh = await orq(['wait'], p, sim);
  assert.match(fresh.out, /^done: 1 units integrated at /);
  const now = (await readState(p.repo)).plan;
  assert.notEqual(now.planId, old.planId);
  assert.equal(unitOf(await readState(p.repo), 'b').state, 'integrated');
});

// A kit of its own (not a git checkout) whose playbook the test can change.
async function kitWith(t, text) {
  const kit = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-kit-'));
  t.after(() => fs.rm(kit, { recursive: true, force: true }));
  await fs.mkdir(path.join(kit, 'playbook'));
  await fs.writeFile(path.join(kit, 'playbook', 'ORCHESTRATOR.md'), text);
  return { kit, file: path.join(kit, 'playbook', 'ORCHESTRATOR.md') };
}
const recordPlaybook = async (p, file) => {
  const { playbookHash } = await import('../lib/playbook-mark.mjs');
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(cfgFile, 'utf8')), playbook: { hash: playbookHash(file) } }));
};

test('U1: wait names a changed playbook as the second line, before settle and notes; not when unchanged', async (t) => {
  const { kit, file } = await kitWith(t, 'v1\n');
  const p = await makeProject(t, [unitSpec('a')], { cap: 18 });
  await recordPlaybook(p, file);
  const sim = simulator(p, { a: [['commit-fail'], ['complete']] });
  sim.settled = false;
  await fs.writeFile(file, 'v2\n');
  const r = await orq(['wait'], p, sim, { kitDir: kit });
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /^done: /);
  assert.equal(lines[1], `playbook: the kit was updated; read ${file} again now, then run "orq init"`);
  assert.match(lines[2], /^settle: /);
  assert.match(lines[3], /^note: cap 18 is an override/);
  assert.equal((await orq(['status'], p, sim, { kitDir: kit })).out.split('\n')[1], lines[1]); // status, with a plan
  await recordPlaybook(p, file);
  assert.doesNotMatch((await orq(['wait'], p, sim, { kitDir: kit })).out, /playbook:/);
});

test('U1: a config written by an older kit (no playbook record) still runs; the line says unknown', async (t) => {
  const { kit, file } = await kitWith(t, 'v1\n');
  const p = await makeProject(t, [unitSpec('a')]);
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  const { playbook: _drop, ...old } = JSON.parse(await fs.readFile(cfgFile, 'utf8'));
  await fs.writeFile(cfgFile, JSON.stringify(old));
  const r = await orq(['wait'], p, simulator(p, { a: [['commit-complete']] }), { kitDir: kit });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').slice(0, 2).map((l) => l.replace(/[0-9a-f]{12}/g, 'X')),
    ['done: 1 units integrated at X; final checks no-evidence', `playbook: this session has no record of reading the playbook; read ${file} now, then run "orq init"`]);
});

test('G1: a finished plan whose plan.json now has another goal is a new request, even with the same unit ids', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete'], ['commit-complete']] });
  assert.match((await orq(['wait'], p, sim)).out, /^done: /);
  assert.equal((await readState(p.repo)).plan.goal, 'test goal');
  const planFile = path.join(p.repo, '.orq', 'plan.json');
  await fs.writeFile(planFile, JSON.stringify({ goal: 'another request', units: [unitSpec('a')] }));
  const msg = 'plan.json has a new goal ("another request", was "test goal") but the ledger\'s plan is finished; this looks like a new request: restore plan.json or run "orq plan archive" first';
  assert.deepEqual(await orq(['plan', 'check'], p, sim).then((r) => [r.code, r.out]), [4, `error: ${msg}\n`]);
  assert.deepEqual(await orq(['wait'], p, sim).then((r) => [r.code, r.err]), [4, `orq: ${msg}\n`]);
  sim.now += 60_000;
  const archived = await orq(['plan', 'archive'], p, sim);
  assert.ok(archived.out.split('\n').includes('note: plan.json did not match the ledger; archived the ledger and kept plan.json for the next request'), archived.out);
  assert.match((await orq(['wait'], p, sim)).out, /^done: 1 units integrated/);
  assert.equal((await readState(p.repo)).plan.goal, 'another request');
});

test('G1: a goal edit while the plan still runs is allowed; a ledger without a recorded goal is not checked', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['idle']] });
  assert.match((await orq(['wait', '--max-seconds', '20'], p, sim)).out, /^timeout: 1 running/);
  await fs.writeFile(path.join(p.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'clearer goal', units: [unitSpec('a')] }));
  assert.equal((await orq(['plan', 'check'], p, sim)).code, 0);
  const q = await makeProject(t, [unitSpec('a')]);
  await commit(q.repo, () => [
    { type: 'plan-started', unit: null, at: NOW, planId: 'p1', baseSha: q.baseSha, integrationBranch: 'orq/p1/integration' },
    { type: 'dropped', unit: 'a', at: NOW },
  ]);
  await fs.writeFile(path.join(q.repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'whatever', units: [unitSpec('a')] }));
  assert.equal((await orq(['plan', 'check'], q, simulator(q, {}))).code, 0);
});

async function setProjectCap(p, cap) {
  const file = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), cap }));
}

test('wait: a project cap below the machine cap bounds this project\'s threads and is named when it binds', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')], { cap: 3 });
  await setProjectCap(p, 1);
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']], c: [['commit-complete']] });
  const r = await orq(['wait', '--max-seconds', '120'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^timeout: 1 running, 0 blocked, 0 gating, 1 queued, 0 passed\nwaiting: 1 ready units wait for a free slot \(project cap 1 of this project, machine cap 3, or a provider instance limit\)\n/);
  assert.ok(sim.polls.every((n) => n <= 1), `project cap exceeded: ${sim.polls}`);
  assert.equal(sim.byUnit.c, undefined);
  await setProjectCap(p, null); // cleared by hand: the machine cap alone again
  sim.byUnit.b[0].script = ['commit-complete'];
  const done = await orq(['wait'], p, sim);
  assert.match(done.out, /^done: 3 units integrated/);
});

test('wait: a worker whose turn ends with nothing committed is told to go on in the same thread; its work passes as attempt 1', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['complete']] }); // the turn ends with no commit; after a message the thread commits
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 1 units integrated at /);
  assert.deepEqual(sim.sends, ['th1']);
  assert.equal(sim.byUnit.a.length, 1); // no second thread
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.attempt, u.launches, u.nudges], ['integrated', 1, 1, 1]);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
});

test('wait: workers that never commit end in a judgment after two threads, each told once: no endless relaunch', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['complete'], ['complete'], ['complete'], ['complete']] });
  sim.stubborn = true; // a message changes nothing: the next turn ends empty too
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^judgment: a: gate failed 3 times: no commits on top of [0-9a-f]{12}\n/);
  assert.deepEqual(sim.sends, ['th1', 'th2']);
  assert.equal(sim.byUnit.a.length, 2);
  assert.notEqual(sim.byUnit.a[1].model, sim.byUnit.a[0].model);
  const u = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([u.state, u.launches, u.nudges], ['failed', 2, 1]); // two threads, never a third
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  const again = await orq(['wait', '--max-seconds', '20'], p, sim); // and it stays there
  assert.match(again.out, /^judgment: a: gate failed 3 times/);
  assert.equal(sim.byUnit.a.length, 2);
});

async function continuousProject(t, full) {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')], { checks: { full } });
  const file = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), autonomy: 'continuous' }));
  return p;
}

test('wait in continuous mode: the final checks run while a unit still works, and a passed head is ready to ship', async (t) => {
  const p = await continuousProject(t, 'test -f a.txt');
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  assert.equal(st.plan.green, st.plan.integrationHead);
  assert.equal(st.plan.greenChecks, 'test -f a.txt'); // the command the green run used
  assert.equal(r.out.split('\n')[0], `ship-ready: ${st.plan.green.slice(0, 12)} passed the final checks; 1 units not shipped yet; run "orq ship --title <conventional title> --body-file <summary file>"`);
  assert.equal(unitOf(st, 'b').state, 'running');
});

test('wait in continuous mode: origin\'s base moved past a passed head: wait merges it, and the merged head is ship-ready', async (t) => {
  const p = await continuousProject(t, 'test -f a.txt');
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']] });
  assert.match((await orq(['wait'], p, sim)).out, /^ship-ready: /);
  const { green } = (await readState(p.repo)).plan;
  // another machine shipped: origin/main (as last fetched; this repo has no remote to fetch) has a commit the head lacks
  const git = (...a) => spawnSync('git', a, { cwd: p.repo, encoding: 'utf8' });
  const moved = git('commit-tree', `${green}^{tree}`, '-p', green, '-m', 'other machine').stdout.trim();
  assert.equal(git('update-ref', 'refs/remotes/origin/main', moved).status, 0);
  sim.now += 10 * 60_000; // past finalDebounceMinutes: the merged head gets its own final run
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  assert.deepEqual([st.plan.synced.from, st.plan.synced.base], [green, moved]);
  assert.equal(st.plan.green, st.plan.synced.to); // the final checks ran on the merged head and passed
  assert.equal(git('merge-base', '--is-ancestor', moved, st.plan.green).status, 0); // it fast-forwards the base
  assert.equal(r.out.split('\n')[0], `ship-ready: ${st.plan.green.slice(0, 12)} passed the final checks; 1 units not shipped yet; run "orq ship --title <conventional title> --body-file <summary file>"`);
  assert.match(r.out, new RegExp(`\nnote: merged origin/main \\(${moved.slice(0, 12)}\\) into the integration branch at ${st.plan.green.slice(0, 12)}; the final checks run on it\n`));
});

test('wait in continuous mode: a final run starts only after origin\'s base is merged, so a pass is not stale on arrival', async (t) => {
  const p = await continuousProject(t, 'test -f a.txt');
  const remote = path.join(p.root, 'remote.git');
  sh(p.root, 'init', '-q', '--bare', remote);
  sh(p.repo, 'remote', 'add', 'origin', remote);
  sh(p.repo, 'push', '-q', 'origin', 'main');
  sh(p.repo, 'fetch', '-q', 'origin');
  // origin was just fetched (the 5-minute fetch interval has not run out), then another machine shipped
  await fs.writeFile(path.join(p.repo, '.orq', 'sync.json'), JSON.stringify({ fetchedAt: NOW }));
  sh(p.repo, 'branch', 'other', p.baseSha);
  const moved = await commitOn(p.repo, 'other', { 'other.txt': 'o\n' }, 'other machine');
  sh(p.repo, 'push', '-q', 'origin', `${moved}:refs/heads/main`);
  sh(p.repo, 'update-ref', 'refs/remotes/origin/main', p.baseSha); // pushed from another clone: not fetched here
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  const events = await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'));
  const finals = events.filter((e) => e.type === 'gate-started' && e.unit === 'integration').map((e) => e.headSha);
  assert.deepEqual(finals, [st.plan.synced.to]); // never a run on the head that lacked origin's base
  assert.equal(st.plan.green, st.plan.synced.to);
  assert.equal(sh(p.repo, 'merge-base', '--is-ancestor', moved, st.plan.green), '');
  assert.match(r.out, /^ship-ready: /);
});

test('wait in continuous mode: a base that conflicts with the integration branch is tried once per origin sha and reported', async (t) => {
  const p = await continuousProject(t, 'test -f a.txt');
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']] });
  assert.match((await orq(['wait'], p, sim)).out, /^ship-ready: /);
  const { green, integrationHead } = (await readState(p.repo)).plan;
  sh(p.repo, 'branch', 'other', p.baseSha);
  const moved = await commitOn(p.repo, 'other', { 'a.txt': 'not a\n' }, 'other machine');
  sh(p.repo, 'update-ref', 'refs/remotes/origin/main', moved);
  const r = await orq(['wait', '--max-seconds', '1'], p, sim);
  assert.match(r.out, /^timeout: /);
  assert.match(r.out, new RegExp(`\nnote: origin/main \\(${moved.slice(0, 12)}\\) conflicts with the integration branch in a\\.txt; a unit with job "fix" has to merge it\n`));
  assert.match(r.out, new RegExp(`\nnote: ${green.slice(0, 12)} passed the final checks but origin/main moved past it; it ships once a unit merges origin/main \\(conflicts in a\\.txt\\)\n`));
  const st = await readState(p.repo);
  assert.deepEqual([st.plan.integrationHead, st.plan.syncConflict.base, st.plan.syncConflict.files], [integrationHead, moved, ['a.txt']]);
  assert.equal(sh(path.join(p.repo, '.orq', 'integration'), 'status', '--porcelain'), ''); // the merge was aborted
  const again = await orq(['wait', '--max-seconds', '1'], p, sim);
  assert.doesNotMatch(again.out, /conflicts with the integration branch/); // tried once until origin moves
  const events = (await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'sync-conflicted');
  assert.equal(events.length, 1);
  assert.ok((await orq(['status'], p, sim)).out.includes(`sync-conflict=${moved.slice(0, 12)} in a.txt`));
});

test('wait in continuous mode: a failing head is reported once while units are open', async (t) => {
  const p = await continuousProject(t, 'echo broken; exit 3');
  const sim = simulator(p, { a: [['commit-complete']], b: [['idle']] });
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  const st = await readState(p.repo);
  const head12 = st.plan.final.head.slice(0, 12);
  assert.equal(r.out.split('\n')[0], `final-fail: ${head12} fails the final checks while units are still open; ${st.plan.final.failures.join('; ')}; details in .orq/units/integration/head-${head12}.json`);
  const kept = JSON.parse(await fs.readFile(path.join(p.repo, '.orq', 'units', 'integration', `head-${head12}.json`), 'utf8'));
  assert.equal(kept.headSha, st.plan.final.head); // kept per head: the next rolling run does not remove it
  assert.equal(st.plan.noted, st.plan.final.head);
  const again = await orq(['wait', '--max-seconds', '60'], p, sim);
  assert.match(again.out, /^timeout: 1 running/);
});

test('wait: a message left while the plan runs returns on the next poll', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['idle']] });
  const sleep = sim.sleep;
  sim.sleep = async (ms) => {
    await sleep(ms);
    if (sim.polls.length === 1) await run(['inbox', 'stop after a'], { stdout: quiet, stderr: quiet, env: p.env, cwd: p.repo, now: () => sim.now, deps: { exec: () => ({ code: 1, stdout: '', stderr: '' }) } });
  };
  const r = await orq(['wait', '--max-seconds', '600'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.equal(sim.polls.length, 1);
  assert.equal(r.out, `message: from the user, through orq inbox; read it and follow it before anything else\n## ${new Date(NOW + 15000).toISOString()}\nstop after a\n`);
});

test('wait: an instance at its usage limit gets no launch, and the registry keeps no usage cooldown', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b')]);
  const t3home = path.join(p.root, 't3');
  await fs.mkdir(path.join(t3home, 'caches'), { recursive: true });
  const reset = new Date(NOW + 86400_000).toISOString();
  await fs.writeFile(path.join(t3home, 'caches', 'pa.json'), JSON.stringify({
    status: 'ready', auth: { status: 'authenticated' },
    usageLimits: { checkedAt: new Date(NOW).toISOString(), windows: [{ id: 'primary', kind: 'weekly', usedPercent: 97, resetsAt: reset }] },
  }));
  const q = { ...p, env: { ...p.env, T3CODE_HOME: t3home } };
  const sim = simulator(p, { a: [['commit-complete']], b: [['commit-complete']] });
  let r = await orq(['wait'], q, sim);
  for (let i = 0; i < 3 && !r.out.startsWith('done:'); i += 1) r = await orq(['wait'], q, sim);
  assert.match(r.out, /^done: 2 units integrated at /, r.err);
  assert.deepEqual([...new Set(Object.values(sim.byUnit).flat().map((x) => x.instance))], ['pb']);
  const reg = JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));
  assert.equal(reg.models['pa::m2'].cooldownUntil, null);
});

for (const cleanup of [true, false]) {
  test(`wait: ${cleanup ? 'cleans up the worktree of an integrated unit, salvaging its uncommitted work' : 'with cleanup false keeps the worktree of an integrated unit'}`, async (t) => {
    const p = await makeProject(t, [unitSpec('a')], { checks: { full: 'test -f a.txt' } });
    if (!cleanup) {
      const file = path.join(p.repo, '.orq', 'config.json');
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), cleanup: false }));
    }
    const sim = simulator(p, { a: [['commit-complete']] });
    const first = await orq(['wait'], p, sim);
    assert.match(first.out, /^done: 1 units integrated/, first.err);
    const dir = path.join(p.root, 'wt-a'); // T3's worktree, left with work the worker never committed
    sh(p.repo, 'worktree', 'add', '-q', dir, sim.byUnit.a[0].branch);
    await fs.writeFile(path.join(dir, 'shared.txt'), 'uncommitted\n');
    sim.now += 11 * 60_000;
    const second = await orq(['wait'], p, sim);
    assert.equal(second.code, 0, second.err);
    const salvage = path.join(p.repo, '.orq', 'salvage');
    if (cleanup) {
      assert.match(second.out, /\nnote: cleanup saved the uncommitted work of 1 removed worktrees under \.orq\/salvage\/\n/);
      assert.equal(fsSync.existsSync(dir), false);
      assert.equal(fsSync.readdirSync(salvage).length, 1);
    } else {
      assert.doesNotMatch(second.out, /cleanup/);
      assert.equal(fsSync.existsSync(dir), true);
      assert.equal(fsSync.existsSync(salvage), false);
    }
    sh(p.repo, 'rev-parse', '--verify', '-q', `refs/heads/${sim.byUnit.a[0].branch}`);
  });
}

// pa and pb run different model families, so a limit on one sends the unit to the other
const FAMILIES = {
  ...REGISTRY,
  models: Object.fromEntries(Object.entries(REGISTRY.models).map(([k, m]) => [k, { ...m, family: m.instance === 'pa' ? 'fam-a' : 'fam-b' }])),
};

test('wait: a usage limit mid-work relaunches at once on another instance and family, continuing its commits, with no count', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { registry: FAMILIES, checks: { full: 'test -f a.txt' } });
  const sim = simulator(p, { a: [['commit-limit'], ['complete']] }); // the second only reports: the commit it inherited is the work
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 1 units integrated/);
  const [first, second] = sim.byUnit.a;
  assert.notEqual(first.instance, second.instance);
  assert.match(second.message, /## Hand-over/); // the new worker starts from the commit the limited one left
  assert.equal(second.base, sh(p.repo, 'rev-parse', first.branch));
  const st = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([st.providerFailures, st.attempt, st.state], [0, 1, 'integrated']);
  const events = (await readLines(path.join(p.repo, '.orq', 'ledger.jsonl')));
  const ended = events.find((e) => e.type === 'thread-ended' && e.status === 'failed');
  assert.deepEqual([ended.limit.kind, ended.limit.reason, ended.limit.until], ['limit', 'Usage Limit Reached', sim.byUnit.a[0].updatedAt + (5 * 24 + 4) * 3600_000]);
  const moved = events.find((e) => e.type === 'rerouted');
  assert.deepEqual([moved.from, moved.to, moved.reason, moved.detail], [`${first.instance}::${first.model}`, `${second.instance}::${second.model}`, 'limit', 'Usage Limit Reached']);
  // the account's pool cools until its reset; the other instance is untouched
  const reg = JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));
  assert.equal(reg.models[`${first.instance}::${first.model}`].cooldownUntil, ended.limit.until);
  assert.equal(reg.models[`${first.instance}::${first.model}`].failures, 0);
  const status = await orq(['status'], p, sim);
  assert.match(status.out, new RegExp(`rerouted=${first.instance}::${first.model}->${second.instance}::${second.model}\\(limit\\)`));
});

test('wait: a thread refused without a reply (Codex at its usage limit) is a limit read from T3\'s log, not a failure strike', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { registry: FAMILIES, checks: { full: 'test -f a.txt' } });
  const sim = simulator(p, { a: [['fail'], ['commit-complete']] });
  const said = 'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 13th, 2026 7:59 PM.';
  const logs = path.join(p.env.T3CODE_HOME, 'userdata', 'logs', 'provider');
  await fs.mkdir(logs, { recursive: true });
  await fs.writeFile(path.join(logs, 'events.th1.log'), `[2026-11-12T12:00:15.000Z] NTIVE: ${JSON.stringify({ event: { payload: { method: 'error', params: { error: { message: said, codexErrorInfo: 'usageLimitExceeded' } } } } })}\n`);
  const r = await orq(['wait'], p, sim);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^done: 1 units integrated/);
  const [first, second] = sim.byUnit.a;
  assert.notEqual(first.instance, second.instance);
  const ended = (await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).find((e) => e.type === 'thread-ended' && e.status === 'failed');
  assert.deepEqual([ended.limit.kind, ended.limit.until], ['limit', new Date(2026, 10, 13, 19, 59).getTime()]);
  assert.equal(unitOf(await readState(p.repo), 'a').providerFailures, 0);
  // the account is held until the reset it named, with no failure strike
  const reg = JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));
  const held = reg.models[`${first.instance}::${first.model}`];
  assert.deepEqual([held.cooldownUntil, held.failures, reg.instances[first.instance].failures], [ended.limit.until, 0, 0]);
});

test('wait: when every instance is at its limit the unit waits for the earliest reset, never judged', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { registry: FAMILIES });
  const sim = simulator(p, { a: [['limit'], ['limit-complete'], ['limit'], ['limit'], ['limit']] });
  const r = await orq(['wait', '--max-seconds', '300'], p, sim);
  assert.equal(r.code, 0, r.err);
  const [line] = r.out.split('\n');
  assert.match(line, /^idle: no model for a: all cooling down; retry at /);
  assert.ok(sim.byUnit.a.length <= 4, `${sim.byUnit.a.length} launches`); // every pool hit cools: no launch loop
  const st = unitOf(await readState(p.repo), 'a');
  assert.deepEqual([st.state, st.providerFailures, st.attempt], ['queued', 0, 1]);
  // the claude reply named its reset (Nov 13 00:00 in São Paulo); the earliest reset is when to come back
  assert.equal(line.split('retry at ')[1], '2026-11-13T03:00:00.000Z');
});

// v0.17.0: pressure-aware admission, the own thread's queue
const calm = { cores: 8, availableMemBytes: 16 * GIB, load1: 0, pressure: { io: 1 } };

test('wait: a machine under pressure starts nothing and says why; work goes on when the pressure drops', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['commit-complete']] });
  let facts = { ...calm, pressure: { io: 72 } };
  const held = await orq(['wait', '--max-seconds', '40'], p, sim, { readMachine: () => facts });
  assert.equal(held.code, 0, held.err);
  assert.deepEqual(held.out.trimEnd().split('\n'), [
    'timeout: 0 running, 0 blocked, 0 gating, 1 queued, 0 passed',
    'waiting: 1 launches or checks wait for this machine: io pressure 72% (limit 40%)',
  ]);
  assert.equal(sim.threads.size, 0);
  const self = JSON.parse(await fs.readFile(path.join(p.home, 'peers', 'self.json'), 'utf8'));
  assert.deepEqual([self.held, self.free, self.reasons], [true, 0, ['io pressure 72% (limit 40%)']]);
  facts = { ...calm, pressure: { io: 35 } }; // under the limit, over the release point: still held
  const band = await orq(['wait', '--max-seconds', '20'], p, sim, { readMachine: () => facts });
  assert.match(band.out, /waiting: 1 launches or checks wait for this machine: io pressure 35% \(limit 40%, releases under 32%\)/);
  assert.equal(sim.threads.size, 0);
  facts = calm;
  const done = await orq(['wait'], p, sim, { readMachine: () => facts });
  assert.match(done.out, /^done: 1 units integrated/);
});

test('wait: a failing protected service holds launches on this machine, whatever the project cap says', async (t) => {
  const p = await makeProject(t, [unitSpec('a')], { cap: 8 });
  await fs.writeFile(path.join(p.home, 'config.json'), JSON.stringify({ cap: 8, protect: [{ name: 'gateway', url: 'http://127.0.0.1:1/v1/models', timeoutMs: 200 }] }));
  await fs.writeFile(path.join(p.repo, '.orq', 'config.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(p.repo, '.orq', 'config.json'), 'utf8')), cap: 6 }));
  const sim = simulator(p, { a: [['commit-complete']] });
  let up = false;
  const fetch = async () => {
    if (!up) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return { status: 200, body: { cancel: async () => {} } };
  };
  const held = await orq(['wait', '--max-seconds', '30'], p, sim, { fetch });
  assert.match(held.out, /waiting: 1 launches or checks wait for this machine: protected service gateway is failing \(no answer in 200 ms\)/);
  assert.equal(sim.threads.size, 0);
  up = true;
  const done = await orq(['wait'], p, sim, { fetch });
  assert.match(done.out, /^done: 1 units integrated/);
});

test('wait: messages queued in the orchestrator\'s own thread end the wait at once', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['idle']] });
  const own = { threadId: 'own', projectId: 'p', status: 'running', itemCount: 9, updatedAt: new Date(NOW).toISOString(), pendingRequestCount: 0, runCount: 4, activeRunId: 'run:thread:own:ordinal:3' };
  const exec = (bin, args, o) => (args[1] === 'show' && args[2] === 'own' ? { code: 0, stdout: JSON.stringify({ thread: own, messages: [] }), stderr: '' } : sim.exec(bin, args, o));
  const env = { ...p.env, T3CODE_THREAD_ID: 'own' };
  const first = await orq(['wait', '--max-seconds', '30'], { ...p, env }, sim, { exec });
  assert.match(first.out, /^queued: 1 message waits in your own thread's queue/);
  assert.equal(sim.threads.size, 0); // before the first poll, like an inbox message
  const second = await orq(['wait', '--max-seconds', '30'], { ...p, env }, sim, { exec });
  assert.match(second.out, /^timeout: 1 running/); // told once
});

test('wait: a pending request that cannot be recorded as told is not told, and the call does not fail', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const sim = simulator(p, { a: [['block', 'idle']] });
  await fs.mkdir(path.join(p.repo, '.orq', 'attention.json')); // nothing can be written here
  const r = await orq(['wait', '--max-seconds', '60'], p, sim);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines[0], 'timeout: 0 running, 1 blocked, 0 gating, 0 queued, 0 passed');
  assert.equal(lines.filter((l) => l.startsWith('note: pending requests and peers could not be checked')).length, 1);
});
