import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGit, defaultExec } from '../lib/git.mjs';
import { perform } from '../lib/effects.mjs';
import { ensurePlanStarted } from '../lib/launch.mjs';
import { collectGate, spawnGateRun } from '../lib/gaterun.mjs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import { loadProjectConfig } from '../lib/config.mjs';
import { readLines } from '../lib/store.mjs';
import { gateFile } from '../lib/paths.mjs';
import { run as cli } from '../lib/cli.mjs';
import {
  makeProject, unitSpec, commitOn, sh,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const git = createGit({ exec: defaultExec });
const leasesOf = (p) => listLeases(path.join(p.home, 'leases'));
const registryOf = async (p) => JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));

function fakeT3(repo, { fail = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    startThread(o) {
      calls.push(['start', o]);
      if (fail) throw new Error('thread start failed (exit 1): provider down');
      sh(repo, 'branch', o.branch, o.worktree);
      n += 1;
      return { threadId: `th${n}`, projectId: 'p', runId: 'r' };
    },
    sendThread(id, message) {
      calls.push(['send', id, message]);
      if (fail) throw new Error('thread send failed (exit 1): gone');
      return { threadId: id, runId: 'r2', status: 'queued', delivery: 'queued' };
    },
  };
}

async function setup(t, units, opts = {}) {
  const p = await makeProject(t, units, opts);
  const t3 = fakeT3(p.repo, opts);
  const fx = {
    cwd: p.repo, env: p.env, now: () => NOW, t3, git, spawnGate: spawnGateRun, isAlive: () => false, ...opts.fx,
  };
  const run = {
    plan: JSON.parse(await fs.readFile(path.join(p.repo, '.orq', 'plan.json'), 'utf8')),
    config: await loadProjectConfig(path.join(p.repo, '.orq', 'config.json')),
    cap: opts.cap ?? 2,
  };
  return { p, t3, fx, run, act: (a) => perform(fx, a, run) };
}

const launchA = (unit = 'a', over = {}) => ({
  type: 'launch', unit, attempt: 1, key: 'pa::m2', instance: 'pa', model: 'm2', tier: 2, job: 'implement', failures: null, ...over,
});
const append = (s, ...events) => commit(s.p.repo, () => events.map((e) => ({ at: NOW, ...e })));

// Walk a launched unit to `passed` with a real commit on its branch.
async function toPassed(s, unit, files) {
  const u = unitOf(await readState(s.p.repo), unit);
  const sha = await commitOn(s.p.repo, u.branch, files);
  await append(s, { type: 'thread-ended', unit, status: 'completed' }, { type: 'gate-started', unit, attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit, attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: sha });
  return sha;
}

test('plan start resolves the base commit once', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  const plan = await ensurePlanStarted(s.fx, s.run);
  const planId = Math.floor(NOW / 1000).toString(36);
  assert.equal(plan.planId, planId);
  assert.equal(plan.baseSha, s.p.baseSha);
  assert.equal(plan.integrationBranch, `orq/${planId}/integration`);
  assert.equal(plan.integrationHead, s.p.baseSha);
  await ensurePlanStarted({ ...s.fx, now: () => NOW + 5000 }, s.run);
  const events = await readLines(path.join(s.p.repo, '.orq', 'ledger.jsonl'));
  assert.deepEqual(events.map((e) => e.type), ['plan-started']);
});

test('launch: starts from the integration head, swaps the reservation for a lease, marks used, is idempotent', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const [[, o]] = s.t3.calls;
  const planId = Math.floor(NOW / 1000).toString(36);
  assert.deepEqual(o, {
    project: s.p.repo, message: 'Work order for a.\n', provider: 'pa', model: 'm2', worktree: s.p.baseSha,
    branch: `orq/${planId}/a-a1`, title: 'orq a: do a',
  });
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.equal(u.state, 'running');
  assert.equal(u.threadId, 'th1');
  assert.equal(u.baseSha, s.p.baseSha);
  assert.deepEqual((await leasesOf(s.p)).map((l) => [l.threadId, l.unit, l.blocked]), [['th1', 'a', false]]);
  const [written] = await leasesOf(s.p);
  assert.deepEqual([written.attempt, written.launch, written.branch, written.baseSha, written.key, written.tier, written.heartbeatAt],
    [1, 1, o.branch, s.p.baseSha, 'pa::m2', 2, NOW]);
  assert.equal((await registryOf(s.p)).models['pa::m2'].lastUsedAt, NOW);
  assert.deepEqual(await s.act(launchA()), { skipped: 'already launched' });
  assert.equal(s.t3.calls.length, 1);
});

test('launch: a relaunch gets a fresh branch; attempt 3 prepends the previous failures', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  await s.act(launchA());
  await append(s, { type: 'thread-ended', unit: 'a', status: 'failed' });
  await s.act(launchA());
  assert.match(s.t3.calls[1][1].branch, /\/a-a1-l2$/);
  const h = s.p.baseSha;
  const failures = ['evidence failed (exit 1)', 'outside writable paths: x'];
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['f1'], flags: [], headSha: h },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th2' }, { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 2, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 2, verdict: 'fail', failures, flags: [], headSha: h });
  await s.act(launchA('a', { attempt: 3, key: 'pa::m3', model: 'm3', tier: 3, failures }));
  const o = s.t3.calls[2][1];
  assert.equal(o.message, 'Previous attempt failed the gate:\n- evidence failed (exit 1)\n- outside writable paths: x\n\nWork order for a.\n');
  assert.match(o.branch, /\/a-a3-l3$/);
  assert.equal(o.model, 'm3');
});

test('launch: cap is re-checked under the machine lock (leases of other projects count)', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  const dir = path.join(s.p.home, 'leases');
  for (const id of ['x1', 'x2']) {
    await writeLease(dir, { threadId: id, project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false });
  }
  assert.deepEqual(await s.act(launchA()), { skipped: 'cap reached' });
  assert.equal(s.t3.calls.length, 0);
  await writeLease(dir, { threadId: 'x2', project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: true });
  await s.act(launchA());
  assert.equal(s.t3.calls.length, 1);
});

test('launch: a failed start is a provider failure and leaves no lease', async (t) => {
  const s = await setup(t, [unitSpec('a')], { fail: true });
  const r = await s.act(launchA());
  assert.match(r.error, /provider down/);
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.equal(u.state, 'queued');
  assert.equal(u.providerFailures, 1);
  assert.deepEqual(u.tried, ['pa::m2']);
  assert.deepEqual(await leasesOf(s.p), []);
  assert.equal((await registryOf(s.p)).models['pa::m2'].failures, 1);
});

test('launch base: a dependant branches from an integration head that contains its dependency', async (t) => {
  const s = await setup(t, [unitSpec('a'), unitSpec('b', { deps: ['a'] })]);
  await s.act(launchA());
  const aSha = await toPassed(s, 'a', { 'a.txt': 'A\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  const st = await readState(s.p.repo);
  assert.equal(unitOf(st, 'a').state, 'integrated');
  assert.notEqual(st.plan.integrationHead, s.p.baseSha);
  await s.act(launchA('b'));
  const base = s.t3.calls[1][1].worktree;
  assert.equal(base, st.plan.integrationHead);
  sh(s.p.repo, 'merge-base', '--is-ancestor', aSha, base);
  assert.equal(unitOf(await readState(s.p.repo), 'b').baseSha, base);
});

test('integrate: a conflict needs judgment and names the files', async (t) => {
  const s = await setup(t, [unitSpec('a', { paths: ['shared.txt'] }), unitSpec('b', { paths: ['shared.txt'] })]);
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'shared.txt': 'from a\n' });
  await toPassed(s, 'b', { 'shared.txt': 'from b\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'integrate', unit: 'b' });
  const b = unitOf(await readState(s.p.repo), 'b');
  assert.equal(b.state, 'failed');
  assert.equal(b.reason, 'merge conflict: shared.txt');
});

async function waitForResult(fx, unit, attempt) {
  for (let i = 0; i < 300; i += 1) {
    const g = await collectGate(fx, unit, attempt);
    if (g.result) return g.result;
    await delay(100);
  }
  throw new Error(`no gate result for ${unit}`);
}

test('gate start and collect through a real detached gate-run, then the final gate', async (t) => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const s = await setup(t, [unitSpec('a'), unitSpec('b')], { fx: { isAlive: alive }, cap: 3 });
  await s.act(launchA());
  await s.act(launchA('b'));
  const st0 = await readState(s.p.repo);
  const aSha = await commitOn(s.p.repo, unitOf(st0, 'a').branch, { 'a.txt': 'A\n' });
  await commitOn(s.p.repo, unitOf(st0, 'b').branch, { 'other.txt': 'B\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'thread-ended', unit: 'b', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  await s.act({ type: 'gate-start', unit: 'b', attempt: 1 });
  const a = unitOf(await readState(s.p.repo), 'a');
  assert.equal(a.headSha, aSha);
  assert.equal(a.gateStarts, 1);
  assert.match(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'pid'), 'utf8'), /^\d+\n$/);
  const ra = await waitForResult(s.fx, 'a', 1);
  await assert.rejects(fs.stat(gateFile(s.p.repo, 'a', 1, 'pid')), /ENOENT/);
  assert.equal(ra.verdict, 'pass');
  assert.equal(ra.headSha, aSha);
  const rb = await waitForResult(s.fx, 'b', 1);
  assert.equal(rb.verdict, 'fail');
  assert.match(rb.failures.join(), /outside writable paths: other\.txt/);

  await append(s, { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: aSha },
    { type: 'dropped', unit: 'b' });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'final-gate' });
  const fin = await waitForResult(s.fx, 'integration', 1);
  assert.equal(fin.verdict, 'no-evidence');
  assert.equal(fin.headSha, (await readState(s.p.repo)).plan.integrationHead);
});

test('collectGate: running while the pid lives, nothing after it dies', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  assert.deepEqual(await collectGate(s.fx, 'a', 1), { running: false, result: null });
  await fs.mkdir(path.dirname(gateFile(s.p.repo, 'a', 1, 'pid')), { recursive: true });
  await fs.writeFile(gateFile(s.p.repo, 'a', 1, 'pid'), '4242\n');
  assert.deepEqual(await collectGate({ ...s.fx, isAlive: (pid) => pid === 4242 }, 'a', 1), { running: true, result: null });
  assert.deepEqual(await collectGate(s.fx, 'a', 1), { running: false, result: null });
});

test('gate start: a branch that cannot be resolved needs judgment', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  sh(s.p.repo, 'branch', '-D', u.branch);
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  const after = unitOf(await readState(s.p.repo), 'a');
  assert.equal(after.state, 'failed');
  assert.match(after.reason, /^gate could not start: /);
});

const feedback = (failures = ['evidence failed (exit 1)']) => ({
  type: 'send-feedback', unit: 'a', attempt: 2, threadId: 'th1', failures, key: 'pa::m2', instance: 'pa', model: 'm2',
});

// Launch a, complete it, and fail its first gate: the unit now awaits feedback on th1.
async function awaitingFeedback(s) {
  await s.act(launchA());
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: s.p.baseSha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['x'], flags: [], headSha: s.p.baseSha });
  await s.act({ type: 'lease-remove', unit: 'a', threadId: 'th1' });
}

test('send-feedback: sends first, then records feedback-sent and leases the thread through a reservation', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(s);
  await s.act(feedback());
  assert.deepEqual(s.t3.calls[1], ['send', 'th1', 'The gate rejected this work:\n- evidence failed (exit 1)\nFix it, commit, and report.']);
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([u.state, u.attempt, u.since], ['running', 2, NOW]);
  assert.deepEqual((await leasesOf(s.p)).map((l) => [l.threadId, !!l.reservation]), [['th1', false]]);
  assert.deepEqual(await s.act(feedback()), { skipped: 'no longer awaiting feedback' });
  assert.equal(s.t3.calls.length, 2);
});

test('send-feedback: a full machine defers the send', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(s);
  const dir = path.join(s.p.home, 'leases');
  for (const id of ['x1', 'x2']) {
    await writeLease(dir, { threadId: id, project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false });
  }
  assert.deepEqual(await s.act(feedback()), { skipped: 'cap reached' });
  assert.equal(s.t3.calls.length, 1);
  assert.equal(unitOf(await readState(s.p.repo), 'a').state, 'queued');
});

test('send-feedback: a failed send is a provider failure; after a drop it records nothing', async (t) => {
  const f = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(f);
  const broken = { ...f.fx, t3: fakeT3(f.p.repo, { fail: true }) };
  const r = await perform(broken, feedback(['x']), f.run);
  assert.match(r.error, /gone/);
  const u = unitOf(await readState(f.p.repo), 'a');
  assert.deepEqual([u.state, u.providerFailures, u.threadId, u.attempt], ['queued', 1, null, 2]);
  assert.deepEqual(await leasesOf(f.p), []);

  const d = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(d);
  const dropping = {
    ...d.fx,
    t3: { sendThread: () => { throw new Error('thread send failed (exit 1): gone'); } },
  };
  await append(d, { type: 'dropped', unit: 'a' });
  assert.deepEqual(await perform(dropping, feedback(), d.run), { skipped: 'no longer awaiting feedback' });
  assert.equal(unitOf(await readState(d.p.repo), 'a').state, 'dropped');
});

test('lease and registry actions', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await writeLease(path.join(s.p.home, 'leases'), {
    threadId: 'th9', project: s.p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false,
  });
  await s.act({ type: 'lease-block', unit: 'a', threadId: 'th9' });
  assert.equal((await leasesOf(s.p))[0].blocked, true);
  await s.act({ type: 'lease-unblock', unit: 'a', threadId: 'th9' });
  assert.equal((await leasesOf(s.p))[0].blocked, false);
  await s.act({ type: 'lease-remove', unit: 'a', threadId: 'th9' });
  assert.deepEqual(await leasesOf(s.p), []);
  await s.act({ type: 'record-failure', unit: 'a', key: 'pa::m2', job: 'implement', kind: 'unknown' });
  assert.equal((await registryOf(s.p)).models['pa::m2'].failures, 1);
  await s.act({ type: 'record-success', unit: 'a', key: 'pa::m2', job: 'implement', firstPass: true });
  const m = (await registryOf(s.p)).models['pa::m2'];
  assert.equal(m.failures, 0);
  assert.deepEqual(m.outcomes.implement, { attempts: 2, firstPass: 1 });
  await assert.rejects(s.act({ type: 'nope' }), /unknown action "nope"/);
});

test('integrate: an exception needs judgment; a unit no longer passed is not merged', async (t) => {
  const s = await setup(t, [unitSpec('a'), unitSpec('b')]);
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'a.txt': 'A\n' });
  await toPassed(s, 'b', { 'b.txt': 'B\n' });
  const boom = { ...s.fx, git: { ...git, ensureWorktree: () => { throw new Error('git worktree failed (exit 128): fatal: boom\nhint: x'); } } };
  await perform(boom, { type: 'integrate', unit: 'a' }, s.run);
  const a = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([a.state, a.reason], ['failed', 'integrate failed: hint: x']);
  await append(s, { type: 'dropped', unit: 'b' });
  await s.act({ type: 'integrate', unit: 'b' });
  assert.equal((await readState(s.p.repo)).plan.integrationHead, s.p.baseSha);
  await assert.rejects(fs.stat(path.join(s.p.repo, '.orq', 'integration')));
});

test('item 8: collectGate drops a result for another commit', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  const file = gateFile(s.p.repo, 'a', 1, 'json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ verdict: 'pass', failures: [], flags: [], headSha: 'f'.repeat(40) }));
  assert.deepEqual(await collectGate(s.fx, 'a', 1, 'e'.repeat(40)), { running: false, result: null });
  await assert.rejects(fs.stat(file));
});

test('item 10: a live gate pid file prevents a second gate process for the same unit and attempt', async (t) => {
  const spawned = [];
  const spawnGate = async () => { spawned.push(1); return 5151; };
  const s = await setup(t, [unitSpec('a')], { fx: { spawnGate, isAlive: (pid) => pid === 4242 } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' });
  const pidFile = gateFile(s.p.repo, 'a', 1, 'pid');
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, '4242\n');
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.equal(spawned.length, 0);
  const after = unitOf(await readState(s.p.repo), 'a');
  assert.equal(after.gateStarts, 1);
  await fs.writeFile(pidFile, '999\n');
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.equal(spawned.length, 1);
  assert.equal(await fs.readFile(pidFile, 'utf8'), '5151\n');
});

test('item 1: gate-run removes its pid file when it finishes, also when it fails', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  const pidFile = gateFile(s.p.repo, 'a', 1, 'pid');
  const quiet = { write: () => {} };
  const gateRun = (args) => cli(['gate-run', ...args], { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo });
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, '123\n');
  assert.equal(await gateRun(['a', '1', sha]), 0);
  await assert.rejects(fs.stat(pidFile), /ENOENT/);
  await fs.writeFile(pidFile, '123\n');
  assert.equal(await gateRun(['a', '1', 'not-a-sha']), 1);
  await assert.rejects(fs.stat(pidFile), /ENOENT/);
});

test('item 1: a leftover pid file with a result present reads as finished and is removed', async (t) => {
  const s = await setup(t, [unitSpec('a')], { fx: { isAlive: () => true } });
  const file = (ext) => gateFile(s.p.repo, 'a', 1, ext);
  await fs.mkdir(path.dirname(file('pid')), { recursive: true });
  await fs.writeFile(file('pid'), `${process.pid}\n`);
  await fs.writeFile(file('json'), JSON.stringify({ verdict: 'pass', failures: [], flags: [], headSha: 'e'.repeat(40) }));
  const g = await collectGate(s.fx, 'a', 1, 'e'.repeat(40));
  assert.equal(g.running, false);
  assert.equal(g.result.verdict, 'pass');
  await assert.rejects(fs.stat(file('pid')), /ENOENT/);
});

test('item 1: starting a gate ignores a live pid whose attempt already has a result', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { fx: { isAlive: () => true, spawnGate: async () => { spawned.push(1); return 777; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' });
  const file = (ext) => gateFile(s.p.repo, 'a', 1, ext);
  await fs.mkdir(path.dirname(file('pid')), { recursive: true });
  await fs.writeFile(file('pid'), '4242\n');
  await fs.writeFile(file('json'), JSON.stringify({ verdict: 'pass', failures: [], flags: [], headSha: 'f'.repeat(40) }));
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.equal(spawned.length, 1);
});

const writeResult = async (s, attempt, result) => {
  const file = gateFile(s.p.repo, 'a', attempt, 'json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof result === 'string' ? result : JSON.stringify(result));
};
const longTail = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(150)}`).join('\n');
const failing = {
  verdict: 'fail', headSha: 'e'.repeat(40), failures: ['evidence failed (exit 1)'],
  steps: [{ name: 'setup', code: 0, tail: 'ok' }, { name: 'evidence', code: 1, tail: longTail }, { name: 'evidence (retry)', code: 1, tail: 'again' }],
  flags: [{ kind: 'skipped-test', path: 'test/a.test.mjs', detail: '1 added line' }, { kind: 'flaky', path: '', detail: 'ignored' },
    { kind: 'placeholder', path: 'a.txt', detail: '2 added lines' }],
};

test('feedback carries the failing step output, capped, and the flags to undo', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(s);
  await writeResult(s, 1, failing);
  await s.act(feedback());
  const msg = s.t3.calls[1][2];
  const [head, out] = msg.split('Output of the failing step (evidence):\n');
  assert.equal(head, 'The gate rejected this work:\n- evidence failed (exit 1)\n');
  const block = out.slice(0, out.indexOf('\nFlag: '));
  assert.ok(block.length <= 2000, `block length ${block.length}`);
  assert.ok(block.endsWith(`line 29 ${'x'.repeat(150)}`));
  assert.ok(!block.includes('line 14 '));
  assert.ok(!msg.includes('again'));
  assert.match(msg, /\nFlag: skipped-test test\/a\.test\.mjs — 1 added line\nFlag: placeholder a\.txt — 2 added lines\nFix it, commit, and report\.$/);
  assert.ok(!msg.includes('flaky'));
});

test('feedback: no failing step adds no output; an unreadable result still sends', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(s);
  await writeResult(s, 1, { ...failing, steps: [], flags: [], failures: ['outside writable paths: x'] });
  await s.act(feedback(['outside writable paths: x']));
  assert.equal(s.t3.calls[1][2], 'The gate rejected this work:\n- outside writable paths: x\nFix it, commit, and report.');
  const u = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(u);
  await writeResult(u, 1, '{not json');
  await u.act(feedback());
  assert.equal(u.t3.calls[1][2], 'The gate rejected this work:\n- evidence failed (exit 1)\nFix it, commit, and report.');
});

test('the attempt-3 work order carries the failing output of the attempt-2 gate', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  await s.act(launchA());
  const h = s.p.baseSha;
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['f1'], flags: [], headSha: h },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 2, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 2, verdict: 'fail', failures: ['evidence failed (exit 1)'], flags: [], headSha: h });
  await writeResult(s, 2, { ...failing, steps: [{ name: 'checks', code: 2, tail: 'assert broke\nat x.test.mjs:3' }] });
  await s.act(launchA('a', { attempt: 3, key: 'pa::m3', model: 'm3', tier: 3, failures: ['evidence failed (exit 1)'] }));
  assert.equal(s.t3.calls[1][1].message, 'Previous attempt failed the gate:\n- evidence failed (exit 1)\n'
    + 'Output of the failing step (checks):\nassert broke\nat x.test.mjs:3\n'
    + 'Flag: skipped-test test/a.test.mjs — 1 added line\nFlag: placeholder a.txt — 2 added lines\n\nWork order for a.\n');
});
