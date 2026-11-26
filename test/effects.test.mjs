import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createGit, defaultExec } from '../lib/git.mjs';
import { perform, feedbackMessage } from '../lib/effects.mjs';
import { awaitsFeedback } from '../lib/tick-util.mjs';
import { ensurePlanStarted } from '../lib/launch.mjs';
import { collectGate, spawnGateRun } from '../lib/gaterun.mjs';
import { commit, readState, unitOf } from '../lib/ledger.mjs';
import {
  confirmGateLease, defaultGateCap, listLeases, liveGateLeases, readGateLeases, removeLease, writeGateLease, writeLease,
} from '../lib/leases.mjs';
import { loadProjectConfig } from '../lib/config.mjs';
import { readLines } from '../lib/store.mjs';
import { gateFile } from '../lib/paths.mjs';
import { run as cli } from '../lib/cli.mjs';
import { observeThreads } from '../lib/wait-threads.mjs';
import {
  makeProject, unitSpec, commitOn, sh,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const git = createGit({ exec: defaultExec });
const leasesOf = (p) => listLeases(path.join(p.home, 'leases'));
const registryOf = async (p) => JSON.parse(await fs.readFile(path.join(p.home, 'registry.json'), 'utf8'));

function fakeT3(repo, { fail = false, world = {} } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    startThread(o) {
      calls.push(['start', o]);
      if (fail || (world.startFails ?? 0) > 0) {
        world.startFails = Math.max(0, (world.startFails ?? 0) - 1);
        throw new Error(world.startError ?? 'thread start failed (exit 1): provider down');
      }
      sh(repo, 'branch', o.branch, o.worktree);
      n += 1;
      if (world.makeWorktrees) { // like T3: a worktree of its own for the thread, outside the repository
        const dir = `${repo}-wt-${n}`;
        sh(repo, 'worktree', 'add', '-q', dir, o.branch);
        world.worktrees = { ...world.worktrees, [`th${n}`]: dir };
      }
      return { threadId: `th${n}`, projectId: 'p', runId: 'r' };
    },
    showThread(id) {
      calls.push(['show', id]);
      if (!world.worktrees?.[id]) throw new Error('thread show failed');
      return { thread: { id, status: 'failed', worktreePath: world.worktrees[id] }, messages: [] };
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
    cwd: p.repo, env: p.env, now: () => NOW, t3, git, spawnGate: spawnGateRun, isAlive: () => false, pause: async () => {}, ...opts.fx,
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
});

test('plan start skips a planId already used by an archived plan', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  const taken = Math.floor(NOW / 1000);
  await fs.mkdir(path.join(s.p.repo, '.orq', 'archive', taken.toString(36)), { recursive: true });
  await fs.mkdir(path.join(s.p.repo, '.orq', 'archive', (taken + 1).toString(36)), { recursive: true });
  const plan = await ensurePlanStarted(s.fx, s.run);
  assert.equal(plan.planId, (taken + 2).toString(36));
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
    branch: `orq/${planId}/a-a1`, title: 'Implement - a | do a',
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
  const startsOf = () => s.t3.calls.filter((c) => c[0] === 'start');
  assert.match(startsOf()[1][1].branch, /\/a-a1-l2$/);
  const h = s.p.baseSha;
  const failures = ['evidence failed (exit 1)', 'outside writable paths: x'];
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['f1'], flags: [], headSha: h },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th2' }, { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 2, headSha: h, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 2, verdict: 'fail', failures, flags: [], headSha: h });
  await s.act(launchA('a', { attempt: 3, key: 'pa::m3', model: 'm3', tier: 3, failures }));
  const o = startsOf()[2][1];
  assert.equal(o.message, 'Previous attempt failed the gate:\n- evidence failed (exit 1)\n- outside writable paths: x\n\nWork order for a.\n');
  assert.match(o.branch, /\/a-a3-l3$/);
  assert.equal(o.model, 'm3');
});

test('launch: the project cap is re-checked under the machine lock too (only this project\'s leases count)', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  const file = path.join(s.p.repo, '.orq', 'config.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), cap: 1 }));
  const dir = path.join(s.p.home, 'leases');
  await writeLease(dir, { threadId: 'x1', project: '/other', unit: 'z', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false });
  await writeLease(dir, { threadId: 'r1', project: s.p.repo, unit: 'review-1', instance: 'pb', model: 'm2', startedAt: 1, heartbeatAt: NOW, blocked: false, kind: 'review', review: 1 });
  assert.deepEqual(await s.act(launchA()), { skipped: 'cap reached' }); // the machine has a slot, the project has none
  assert.equal(s.t3.calls.length, 0);
  await removeLease(dir, 'r1');
  await s.act(launchA());
  assert.equal(s.t3.calls.length, 1);
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
  assert.deepEqual(u.failedKeys, ['pa::m2']);
  assert.deepEqual(await leasesOf(s.p), []);
  assert.equal((await registryOf(s.p)).models['pa::m2'].failures, 1);
});

test('launch: a start refused for sign-in is a limit: the instance cools, the unit is not counted', async (t) => {
  const s = await setup(t, [unitSpec('a')], { fail: true, world: { startError: 'thread start failed (exit 1): Not logged in · Please run /login' } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([u.state, u.providerFailures, u.failedLaunch.limit.kind], ['queued', 0, 'auth']);
  const reg = await registryOf(s.p);
  assert.deepEqual([reg.instances.pa.cooldownUntil, reg.models['pa::m2'].failures], [NOW + 30 * 60_000, 0]);
});

test('launch: the launch after a provider failure records where it moved and why; the same model again is no reroute', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 4 }); // the ended threads' leases are not removed here
  await s.act(launchA());
  const limit = { kind: 'limit', reason: 'Usage Limit Reached', until: NOW + 60_000 };
  await append(s, { type: 'thread-ended', unit: 'a', status: 'failed', limit });
  const r = await s.act(launchA('a', { key: 'pb::m4', instance: 'pb', model: 'm4', tier: 4 }));
  assert.ok(r.notes.includes('note: unit a rerouted from pa::m2 to pb::m4 (limit: Usage Limit Reached)'), r.notes.join('|'));
  const events = await readLines(path.join(s.p.repo, '.orq', 'ledger.jsonl'));
  assert.deepEqual(events.filter((e) => e.type === 'rerouted').map(({ at, ...e }) => e), [
    { type: 'rerouted', unit: 'a', from: 'pa::m2', to: 'pb::m4', reason: 'limit', detail: 'Usage Limit Reached' },
  ]);
  await append(s, { type: 'thread-ended', unit: 'a', status: 'failed' });
  await s.act(launchA('a', { key: 'pb::m4', instance: 'pb', model: 'm4', tier: 4 }));
  const after = await readLines(path.join(s.p.repo, '.orq', 'ledger.jsonl'));
  assert.equal(after.filter((e) => e.type === 'rerouted').length, 1);
  assert.equal(unitOf(await readState(s.p.repo), 'a').rerouted, null);
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

test('integrate: a conflict goes back to the same worker to merge the integration head; the third one needs judgment', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a', { paths: ['shared.txt'] }), unitSpec('b', { paths: ['shared.txt'] })], {
    fx: { spawnGate: async () => { spawned.push(1); return 1; } },
  });
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'shared.txt': 'from a\n' });
  await toPassed(s, 'b', { 'shared.txt': 'from b\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  const head = (await readState(s.p.repo)).plan.integrationHead;
  const thread = unitOf(await readState(s.p.repo), 'b').threadId;
  await s.act({ type: 'integrate', unit: 'b' });
  const b = unitOf(await readState(s.p.repo), 'b');
  assert.equal(b.state, 'queued');
  assert.equal(b.threadId, thread);
  assert.equal(b.attempt, 1); // the same attempt: the gate passed, only the merge is left
  assert.equal(b.conflicts, 1);
  assert.equal(b.baseSha, head); // the next gate judges only what the worker adds on top of the head it merges
  assert.equal(awaitsFeedback(b), true);
  assert.match(b.lastFailure[0], new RegExp(`^merge conflict with the integration branch in shared\\.txt: .*git merge ${head}`));
  const msg = feedbackMessage(b.lastFailure, 'Flag: test-weakened x — 1 lines removed');
  assert.match(msg, new RegExp(`git merge ${head}`));
  assert.doesNotMatch(msg, /Flag:|gate rejected/);
  // the worker's turn ends without resolving it: gated again on the same commit, it conflicts again (twice per launch)
  // the commit already passed its gate once: the shortcut passes it again with no gate run and no rung of the ladder
  const unresolved = async () => {
    await append(s, { type: 'feedback-sent', unit: 'b', attempt: 1, threadId: thread }, { type: 'thread-ended', unit: 'b', status: 'completed' });
    await s.act({ type: 'gate-start', unit: 'b', attempt: 1 });
    const u = unitOf(await readState(s.p.repo), 'b');
    assert.deepEqual([u.state, u.attempt, u.headSha], ['passed', 1, b.headSha]);
  };
  await unresolved();
  await s.act({ type: 'integrate', unit: 'b' });
  assert.equal(unitOf(await readState(s.p.repo), 'b').conflicts, 2);
  await unresolved();
  await s.act({ type: 'integrate', unit: 'b' });
  assert.equal(spawned.length, 0);
  const again = unitOf(await readState(s.p.repo), 'b');
  assert.equal(again.state, 'failed');
  assert.equal(again.reason, 'merge conflict: shared.txt');
});

test('after a conflict, a merge commit that failed its gate is never passed by the same-commit shortcut', async (t) => {
  const s = await setup(t, [unitSpec('a', { paths: ['shared.txt'] }), unitSpec('b', { paths: ['shared.txt'] })], {
    fx: { spawnGate: async () => 1 },
  });
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'shared.txt': 'from a\n' });
  await toPassed(s, 'b', { 'shared.txt': 'from b\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'integrate', unit: 'b' });
  const b = unitOf(await readState(s.p.repo), 'b');
  const m = await commitOn(s.p.repo, b.branch, { 'shared.txt': 'broken merge\n' });
  await append(s, { type: 'feedback-sent', unit: 'b', attempt: 1, threadId: b.threadId }, { type: 'thread-ended', unit: 'b', status: 'completed' },
    { type: 'gate-started', unit: 'b', attempt: 1, headSha: m, pid: 1 },
    { type: 'gated', unit: 'b', attempt: 1, verdict: 'fail', failures: ['checks failed (exit 1)'], flags: [], headSha: m },
    { type: 'feedback-sent', unit: 'b', attempt: 2, threadId: b.threadId }, { type: 'thread-ended', unit: 'b', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'b', attempt: 2 });
  const after = unitOf(await readState(s.p.repo), 'b');
  assert.deepEqual([after.state, after.attempt], ['queued', 3]);
  assert.equal(after.lastFailure[0], 'no new commit after feedback');
});

test('integrate: the worker merges the head it was given, and the unit then integrates', async (t) => {
  const s = await setup(t, [unitSpec('a', { paths: ['shared.txt'] }), unitSpec('b', { paths: ['shared.txt'] })]);
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'shared.txt': 'from a\n' });
  await toPassed(s, 'b', { 'shared.txt': 'from b\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'integrate', unit: 'b' });
  const b = unitOf(await readState(s.p.repo), 'b');
  const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-wt-'));
  t.after(() => fs.rm(wt, { recursive: true, force: true }));
  sh(s.p.repo, 'worktree', 'add', '-q', wt, b.branch);
  spawnSync('git', ['merge', '-q', b.baseSha], { cwd: wt }); // stops on the conflict, resolved below
  await fs.writeFile(path.join(wt, 'shared.txt'), 'from a\nfrom b\n');
  sh(wt, 'commit', '-qam', 'merge the integration head');
  const sha = sh(wt, 'rev-parse', 'HEAD');
  await append(s, { type: 'feedback-sent', unit: 'b', attempt: 1, threadId: b.threadId },
    { type: 'thread-ended', unit: 'b', status: 'completed' }, { type: 'gate-started', unit: 'b', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'b', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: sha });
  await s.act({ type: 'integrate', unit: 'b' });
  assert.equal(unitOf(await readState(s.p.repo), 'b').state, 'integrated');
});

test('integrate: a unit\'s commits lose their tool or model credit before the merge; the ledger keeps both heads', async (t) => {
  const s = await setup(t, [unitSpec('a'), unitSpec('b')]);
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  const a = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, a.branch, { 'a.txt': 'A\n' }, 'feat: a\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>');
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: sha });
  const plain = await toPassed(s, 'b', { 'b.txt': 'B\n' });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'integrate', unit: 'b' });
  const events = (await readLines(path.join(s.p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'integrated');
  const [ea, eb] = events;
  assert.equal(ea.original, sha);
  assert.notEqual(ea.sha, sha);
  assert.equal(sh(s.p.repo, 'rev-parse', `${ea.sha}^{tree}`), sh(s.p.repo, 'rev-parse', `${sha}^{tree}`));
  assert.equal(sh(s.p.repo, 'rev-parse', a.branch), ea.sha);
  assert.deepEqual([eb.sha, eb.original], [plain, undefined]); // nothing to drop: as before
  const st = await readState(s.p.repo);
  assert.equal(sh(s.p.repo, 'log', '--format=%B', `${st.plan.baseSha}..${st.plan.integrationHead}`).includes('anthropic'), false);
  assert.equal(unitOf(st, 'a').headSha, sha); // the gated commit stays on record
});

test('integrate: a credited unit that conflicts keeps its branch where the worker left it', async (t) => {
  const s = await setup(t, [unitSpec('a', { paths: ['shared.txt'] }), unitSpec('b', { paths: ['shared.txt'] })]);
  await s.act(launchA());
  await s.act(launchA('b', { key: 'pb::m2', instance: 'pb' }));
  await toPassed(s, 'a', { 'shared.txt': 'from a\n' });
  const b = unitOf(await readState(s.p.repo), 'b');
  const sha = await commitOn(s.p.repo, b.branch, { 'shared.txt': 'from b\n' }, 'feat: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  await append(s, { type: 'thread-ended', unit: 'b', status: 'completed' }, { type: 'gate-started', unit: 'b', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'b', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: sha });
  await s.act({ type: 'integrate', unit: 'a' });
  await s.act({ type: 'integrate', unit: 'b' });
  const after = unitOf(await readState(s.p.repo), 'b');
  assert.equal(after.state, 'queued'); // conflicted: back to its worker
  assert.equal(sh(s.p.repo, 'rev-parse', b.branch), sha); // the worker's checkout is untouched
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
  const s = await setup(t, [unitSpec('a'), unitSpec('b', { forbidden: ['other.txt'] })], { fx: { isAlive: alive }, cap: 3 });
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
  assert.match(rb.failures.join(), /forbidden paths: other\.txt/);

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

test('send-feedback: a worktree still linked to the main pnpm node_modules gets a real install before the worker goes on', async (t) => {
  for (const ok of [true, false]) {
    const installs = [];
    const s = await setup(t, [unitSpec('a')], { fx: { install: (dir, cmd) => { installs.push([dir, cmd]); return ok; } } });
    await awaitingFeedback(s);
    await fs.writeFile(path.join(s.p.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
    await fs.mkdir(path.join(s.p.repo, 'node_modules', 'dep'), { recursive: true });
    const wt = `${s.p.repo}-old-wt`;
    t.after(() => fs.rm(wt, { recursive: true, force: true }));
    await fs.mkdir(wt);
    await fs.symlink(path.join(s.p.repo, 'node_modules'), path.join(wt, 'node_modules'));
    s.t3.showThread = () => ({ thread: { worktreePath: wt } });
    await s.act(feedback());
    assert.deepEqual(installs, [[wt, 'pnpm install --frozen-lockfile --prefer-offline']]);
    assert.equal(fsSync.existsSync(path.join(wt, 'node_modules')), false);
    assert.ok(fsSync.existsSync(path.join(s.p.repo, 'node_modules', 'dep'))); // the main checkout's install stays
    const sent = s.t3.calls.find((c) => c[0] === 'send')[2];
    assert.equal(sent.startsWith('Dependencies: pnpm dependencies are not linked'), !ok, sent); // a failed install: the worker is told
  }
});

// A provider that refuses at once logs its error while t3 is still starting the thread or sending to it, before
// orq records the event: the run starts when orq calls t3, so that error is this run's.
const REFUSAL = 'Token Plan usage limit reached (2056)';
async function refusedAtOnce(t, call) {
  let clock = NOW;
  const s = await setup(t, [unitSpec('a')], { fx: { now: () => clock } });
  let loggedAt = null;
  for (const name of ['startThread', 'sendThread']) {
    const real = s.t3[name].bind(s.t3);
    s.t3[name] = (...args) => {
      const r = real(...args);
      if (name === call) {
        clock += 1000;
        loggedAt = clock; // the provider's refusal, logged during the call
        clock += 2000; // lock and lease work before the event is written
      }
      return r;
    };
  }
  return { s, at: () => loggedAt };
}
function readStopped(s, at) {
  const fx = {
    now: () => NOW + 60_000,
    threadError: (id, after) => (at() !== null && at() >= after ? REFUSAL : null),
    t3: { showThread: () => ({ thread: {}, messages: [{ role: 'assistant', text: 'Reading the upload service first.' }] }) },
  };
  return async () => observeThreads(fx, s.run.plan, await readState(s.p.repo), [{ id: 'th1', status: 'failed', updatedAt: NOW + 30_000 }]).th1.limit;
}

test('launch: a refusal logged while the thread was starting belongs to that run and is read as a limit', async (t) => {
  const { s, at } = await refusedAtOnce(t, 'startThread');
  await s.act(launchA());
  assert.equal(unitOf(await readState(s.p.repo), 'a').runStartedAt, NOW); // taken before the start, not when recorded
  assert.equal((await readStopped(s, at)())?.kind, 'limit');
});

test('send-feedback: a refusal logged while the feedback was being sent belongs to that run and is read as a limit', async (t) => {
  const { s, at } = await refusedAtOnce(t, 'sendThread');
  await awaitingFeedback(s);
  const sentAt = NOW;
  await s.act(feedback());
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([u.state, u.runStartedAt], ['running', sentAt]);
  assert.ok(u.since > at()); // the event itself is recorded after the refusal
  assert.equal((await readStopped(s, at)())?.kind, 'limit');
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
  assert.deepEqual(m.outcomes.implement, { attempts: 1, firstPass: 1 }); // the provider failure counted no outcome
  await s.act({ type: 'record-result', unit: 'a', key: 'pa::m2', job: 'implement', pass: false });
  assert.deepEqual((await registryOf(s.p)).models['pa::m2'].results.implement, [{ at: NOW, pass: false }]);
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

test('machine gate budget: a gate starts only while gateCap has room over every project, and frees it when done', async (t) => {
  const spawned = [];
  const alive = new Set([777]);
  const procStart = (pid) => `start-${pid}`;
  let seenAtSpawn = null;
  const dir = (s) => path.join(s.p.home, 'gate-leases');
  let s;
  const spawnGate = async ({ env }) => {
    seenAtSpawn = await readGateLeases(dir(s)); // the lease is reserved before the gate exists
    spawned.push(env.ORQ_GATE_LEASE);
    alive.add(5151);
    return 5151;
  };
  s = await setup(t, [unitSpec('a')], {
    fx: {
      spawnGate, isAlive: (pid) => alive.has(pid), procStart, gateCap: 1,
    },
  });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await writeGateLease(dir(s), {
    id: '0'.repeat(16), pid: 777, pidStart: 'start-777', project: '/elsewhere', unit: 'x', startedAt: NOW,
  }); // another project's gate
  assert.deepEqual(await s.act({ type: 'gate-start', unit: 'a', attempt: 1 }), { skipped: 'gate cap reached' });
  assert.equal(spawned.length, 0);
  assert.equal(unitOf(await readState(s.p.repo), 'a').gateStarts, 0); // asked for again on the next poll
  await assert.rejects(fs.stat(gateFile(s.p.repo, 'a', 1, 'pid')));
  alive.delete(777); // that gate ended without cleaning up: its lease no longer counts
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.equal(spawned.length, 1);
  assert.deepEqual(seenAtSpawn.filter((l) => l.project === s.p.repo).map((l) => [l.reservation, l.id]), [[true, spawned[0]]]);
  const deps = { isAlive: (pid) => alive.has(pid), procStart, now: NOW };
  assert.deepEqual((await liveGateLeases(dir(s), deps)).map((l) => [l.pid, l.pidStart, l.project, l.unit]), [[5151, 'start-5151', s.p.repo, 'a']]);
  await fs.writeFile(gateFile(s.p.repo, 'a', 1, 'json'), JSON.stringify({
    verdict: 'pass', failures: [], flags: [], headSha: sha,
  }));
  assert.equal((await collectGate(s.fx, 'a', 1, sha)).result.verdict, 'pass');
  await assert.rejects(fs.stat(path.join(dir(s), `${spawned[0]}.json`))); // finished: its budget slot is free
  assert.equal(defaultGateCap(10), 2);
  assert.equal(defaultGateCap(20), 2);
  assert.equal(defaultGateCap(32), 4);
});

test('gate leases: a reused pid and an expired reservation hold nothing; a fresh reservation counts for its whole window, even after its orq wait died; an unreadable lease counts; the gate confirms its own', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-gl-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const alive = new Set([10, 20, 30]);
  const deps = { isAlive: (pid) => alive.has(pid), procStart: (pid) => (pid === 10 ? 'new start' : `start-${pid}`), now: NOW };
  await writeGateLease(dir, {
    id: 'a'.repeat(16), pid: 10, pidStart: 'old start', project: '/p', unit: 'u', startedAt: NOW,
  }); // pid 10 now belongs to another process
  await writeGateLease(dir, {
    id: 'b'.repeat(16), reservation: true, owner: 20, ownerStart: 'start-20', project: '/p', unit: 'v', startedAt: NOW - 3 * 60_000,
  }); // never confirmed, older than the reservation window
  await writeGateLease(dir, {
    id: 'c'.repeat(16), reservation: true, owner: 99, project: '/p', unit: 'w', startedAt: NOW,
  }); // its orq wait died after the spawn, before the gate confirmed: the gate may be running
  await writeGateLease(dir, {
    id: 'd'.repeat(16), reservation: true, owner: 30, ownerStart: 'start-30', project: '/p', unit: 'x', startedAt: NOW,
  });
  assert.deepEqual((await liveGateLeases(dir, deps)).map((l) => l.unit), ['w', 'x']);
  const later = { ...deps, now: NOW + 2 * 60_000 - 1 };
  assert.deepEqual((await liveGateLeases(dir, later)).map((l) => l.unit), ['w', 'x']); // the whole window
  assert.deepEqual((await liveGateLeases(dir, { ...deps, now: NOW + 2 * 60_000 })).map((l) => l.unit), []);
  await fs.rm(path.join(dir, `${'c'.repeat(16)}.json`));
  await confirmGateLease(dir, 'd'.repeat(16), { pid: 20, pidStart: 'start-20', startedAt: NOW + 5 });
  const confirmed = JSON.parse(await fs.readFile(path.join(dir, `${'d'.repeat(16)}.json`), 'utf8'));
  assert.deepEqual([confirmed.pid, confirmed.reservation, confirmed.startedAt, confirmed.unit], [20, undefined, NOW, 'x']);
  await fs.writeFile(path.join(dir, `${'e'.repeat(16)}.json`), '{torn');
  assert.equal((await liveGateLeases(dir, deps)).length, 2); // never fewer than may be running
  await assert.rejects(readGateLeases(dir), /invalid JSON/);
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

test('gate-run: a failed final check is not run a second time (a full suite costs minutes); a unit check still is', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const sha = await commitOn(s.p.repo, unitOf(await readState(s.p.repo), 'a').branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  let calls = 0;
  const run = async () => { calls += 1; return { code: 1, output: 'boom', timedOut: false }; };
  const orq = (args) => cli(args, {
    stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run },
  });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'null']), 0);
  assert.equal(await orq(['config', 'set', 'checks.unit', 'false']), 0);
  assert.equal(await orq(['config', 'set', 'checks.full', 'false']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.equal(calls, 2); // a unit gate's failing evidence is run once more: a flaky test passes on the retry
  calls = 0;
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(calls, 1);
  const result = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.deepEqual(result.failures, ['checks failed (exit 1)']);
  assert.equal(await orq(['config', 'set', 'checks.setup', 'false']), 0);
  calls = 0;
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(calls, 2); // setup still gets its second try
});

test('gate-run: install once: a pnpm-only setup installs on the first gate and the next gate gets the cached node_modules; depCache false turns it off', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const sha = await commitOn(s.p.repo, unitOf(await readState(s.p.repo), 'a').branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  const commands = [];
  const run = async (command, { cwd, prefix }) => {
    commands.push([command, Array.isArray(prefix)]);
    if (command === 'pnpm install --frozen-lockfile') fsSync.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
    if (command === 'test -d node_modules/dep') return { code: fsSync.existsSync(path.join(cwd, 'node_modules', 'dep')) ? 0 : 1, output: '', timedOut: false };
    return { code: 0, output: '', timedOut: false };
  };
  const clone = (src, dst) => { fsSync.cpSync(src, dst, { recursive: true }); return true; };
  const orq = (args) => cli(args, {
    stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run, clone, depCacheKey: () => 'd'.repeat(64) },
  });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'pnpm install --frozen-lockfile']), 0);
  assert.equal(await orq(['config', 'set', 'checks.unit', 'test -d node_modules/dep']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(commands.map(([c]) => c), ['pnpm install --frozen-lockfile', 'test -f a.txt', 'test -d node_modules/dep']);
  assert.ok(commands.every(([, p]) => p)); // every step gets the priority prefix
  commands.length = 0;
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(commands.map(([c]) => c), ['test -f a.txt', 'test -d node_modules/dep']); // no install, and the checks find the deps
  const result = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'json'), 'utf8'));
  assert.equal(result.verdict, 'pass');
  assert.equal(result.steps[0].cached, true);
  assert.equal(await orq(['config', 'set', '--machine', 'depCache', 'false']), 0);
  commands.length = 0;
  await orq(['gate-run', 'a', '1', sha]);
  assert.equal(commands[0][0], 'pnpm install --frozen-lockfile');
});

test('gate-run: a failed final gate keeps its whole output in head-<sha>.log and names it; a passing one keeps none', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const sha = await commitOn(s.p.repo, unitOf(await readState(s.p.repo), 'a').branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  let code = 1;
  const run = async (_command, { logFile }) => {
    if (logFile) fsSync.appendFileSync(logFile, 'FAIL tests/x.test.ts\nlast\n');
    return { code, output: 'last', timedOut: false };
  };
  const orq = (args) => cli(args, {
    stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run },
  });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'null']), 0);
  assert.equal(await orq(['config', 'set', 'checks.full', 'false']), 0);
  const rel = `.orq/units/integration/head-${sha.slice(0, 12)}.log`;
  const log = path.join(s.p.repo, rel);
  await orq(['gate-run', 'integration', '1', sha]);
  const failed = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.equal(failed.output, rel);
  assert.match(await fs.readFile(log, 'utf8'), /^== checks\nFAIL tests\/x\.test\.ts\nlast\n$/);
  // what it printed outlives the log, for the units that fork from this head (baseline.mjs)
  const kept = JSON.parse(await fs.readFile(path.join(s.p.repo, '.orq', 'units', 'integration', `head-${sha.slice(0, 12)}.json`), 'utf8'));
  assert.deepEqual(kept.baseline, { failures: [], errors: ['FAIL tests/x.test.ts'], count: null });
  await orq(['gate-run', 'integration', '1', sha]); // the same head again: a new log, not one appended to the last
  assert.equal((await fs.readFile(log, 'utf8')).match(/FAIL/g).length, 1);
  code = 0;
  await orq(['gate-run', 'integration', '1', sha]);
  const passed = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.deepEqual([passed.output, passed.baseline], [undefined, undefined]);
  assert.equal(fsSync.existsSync(log), false);
  code = 1;
  const other = path.join(s.p.repo, '.orq/units/integration/head-000000000000.log');
  await fs.writeFile(other, 'old failure\n');
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(fsSync.existsSync(other), true); // a failing run leaves earlier logs alone
  code = 0;
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(fsSync.existsSync(other), false); // a passing final run clears every older head's log
  const seen = [];
  const unitRun = async (_c, opts) => { seen.push(opts.logFile); return { code: 0, output: '', timedOut: false }; };
  await cli(['gate-run', 'a', '1', sha], { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run: unitRun } });
  assert.ok(seen.length > 0 && seen.every((f) => f === gateFile(s.p.repo, 'a', 1, 'output.log'))); // read for its failures only
  assert.equal(fsSync.existsSync(gateFile(s.p.repo, 'a', 1, 'output.log')), false); // a unit gate keeps no log
});

test('gate-run: a unit gate tells its commands what changed; the final gate only that it is final', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n', 'shared.txt': 'changed\n' });
  const dir = path.join(s.p.root, 'del');
  sh(s.p.repo, 'worktree', 'add', '-q', dir, u.branch);
  sh(dir, 'checkout', '-q', u.baseSha, '--', 'shared.txt');
  sh(dir, 'mv', 'shared.txt', 'moved.txt'); // a rename: its old path is gone
  sh(dir, 'commit', '-q', '-m', 'move shared');
  const sha = sh(dir, 'rev-parse', 'HEAD');
  sh(s.p.repo, 'worktree', 'remove', '--force', dir);
  const quiet = { write: () => {} };
  const seen = [];
  const run = async (command, { env }) => {
    const read = (f) => (f && fsSync.existsSync(f) ? fsSync.readFileSync(f, 'utf8') : null);
    seen.push({
      command, gate: env?.ORQ_GATE, base: env?.ORQ_BASE_SHA, job: env?.ORQ_UNIT_JOB, changed: read(env?.ORQ_CHANGED_FILES), deleted: read(env?.ORQ_DELETED_FILES), files: [env?.ORQ_CHANGED_FILES, env?.ORQ_DELETED_FILES],
    });
    return { code: 0, output: '', timedOut: false };
  };
  const orq = (args, gitExec) => cli(args, { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run, ...(gitExec ? { gitExec } : {}) } });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'setup']), 0);
  assert.equal(await orq(['config', 'set', 'checks.unit', 'unit']), 0);
  assert.equal(await orq(['config', 'set', 'checks.full', 'full']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(seen.map((x) => x.command), ['setup', 'test -f a.txt', 'unit']);
  for (const x of seen) {
    assert.deepEqual([x.gate, x.base, x.job, x.changed, x.deleted], ['unit', u.baseSha, 'implement', 'a.txt\nmoved.txt\n', 'shared.txt\n']);
    assert.ok(x.files.every((f) => path.isAbsolute(f) && path.dirname(f) === path.join(s.p.repo, '.orq', 'units', 'a')), x.files.join(' '));
  }
  assert.ok(seen[0].files.every((f) => !fsSync.existsSync(f))); // removed after the gate
  assert.equal(JSON.parse(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'json'), 'utf8')).verdict, 'pass');
  // the diff cannot be had: no changed-file vars, so the commands run everything
  seen.length = 0;
  let diffs = 0; // the first diff is the env's; the gate's own comes after it
  const broken = (cmd, args, opts) => (args.includes('--name-status') && (diffs += 1) === 1 ? { code: 128, stdout: '', stderr: 'fatal: bad object' } : defaultExec(cmd, args, opts));
  await orq(['gate-run', 'a', '1', sha], broken);
  assert.deepEqual(seen.map((x) => [x.gate, x.base, x.files]), Array(3).fill(['unit', u.baseSha, [undefined, undefined]]));
  seen.length = 0;
  await orq(['gate-run', 'integration', '1', sha]);
  assert.deepEqual(seen.map((x) => [x.command, x.gate, x.base, x.job, x.files]), [['setup', 'final', undefined, undefined, [undefined, undefined]], ['full', 'final', undefined, undefined, [undefined, undefined]]]);
  // a fix unit runs everything: it exists to fix what the whole suite fails
  const planFile = path.join(s.p.repo, '.orq', 'plan.json');
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  await fs.writeFile(planFile, JSON.stringify({ ...plan, units: plan.units.map((x) => ({ ...x, job: 'fix' })) }));
  seen.length = 0;
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(seen.map((x) => [x.gate, x.base, x.job, x.files]), Array(3).fill(['unit', u.baseSha, 'fix', [undefined, undefined]]));
});

test('gate-run: a unit that fails only the tests its red base head fails passes, flagged; one more failure fails it', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  const baseTail = '(fail) merged-schema: has the spool table [3.20ms]\n(fail) legacy-low-spool-migration: keeps custom thresholds [12.01ms]\n 410 pass\n 2 fail';
  const head = path.join(s.p.repo, '.orq', 'units', 'integration', `head-${u.baseSha.slice(0, 12)}.json`);
  await fs.mkdir(path.dirname(head), { recursive: true });
  await fs.writeFile(head, JSON.stringify({
    verdict: 'fail', failures: ['checks failed (exit 1)'], flags: [], headSha: u.baseSha, steps: [{ name: 'checks', code: 1, durationMs: 9, tail: baseTail }],
  }));
  let output = '(pass) spools: lists spools [2.00ms]\n(fail) merged-schema: has the spool table [2.90ms]\n 411 pass\n 1 fail\n';
  const run = async (c, { logFile }) => {
    if (c !== 'false') return { code: 0, output: '', timedOut: false }; // the evidence passes
    if (logFile) fsSync.appendFileSync(logFile, output);
    return { code: 1, output, timedOut: false };
  };
  const orq = (args) => cli(args, { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run } });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'null']), 0);
  assert.equal(await orq(['config', 'set', 'checks.unit', 'false']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  const passed = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'json'), 'utf8'));
  assert.deepEqual([passed.verdict, passed.failures, passed.flags.map((f) => f.kind)], ['pass', [], ['pre-existing-failures']]);
  assert.deepEqual(passed.steps.map((x) => x.name), ['evidence', 'checks', 'checks (retry)']); // as they ran
  assert.equal(fsSync.existsSync(gateFile(s.p.repo, 'a', 1, 'output.log')), false);
  // a fix unit exists to fix the base's failures: they are never excused for it
  const planFile = path.join(s.p.repo, '.orq', 'plan.json');
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  await fs.writeFile(planFile, JSON.stringify({ ...plan, units: plan.units.map((x) => ({ ...x, job: 'fix' })) }));
  await orq(['gate-run', 'a', '1', sha]);
  const fix = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'json'), 'utf8'));
  assert.deepEqual([fix.verdict, fix.failures, fix.flags], ['fail', ['checks failed (exit 1)'], []]);
  await fs.writeFile(planFile, JSON.stringify(plan));
  output += '(fail) spools: rejects a negative weight [1.00ms]\n';
  await orq(['gate-run', 'a', '1', sha]);
  const failed = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'a', 1, 'json'), 'utf8'));
  assert.deepEqual([failed.verdict, failed.failures, failed.flags], ['fail', ['checks failed (exit 1)'], []]);
  // a gate that dies mid-step leaves no output file behind either
  const dying = async (c, { logFile }) => {
    if (c !== 'false') return { code: 0, output: '', timedOut: false };
    fsSync.appendFileSync(logFile, 'partial\n');
    throw new Error('runner died');
  };
  assert.equal(await cli(['gate-run', 'a', '1', sha], { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run: dying } }), 1);
  assert.equal(fsSync.existsSync(gateFile(s.p.repo, 'a', 1, 'output.log')), false);
});

test('gate-run: a final gate that fails before any step names no output', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const sha = unitOf(await readState(s.p.repo), 'a').baseSha; // no commits on top of the base
  const quiet = { write: () => {} };
  const run = async () => ({ code: 0, output: '', timedOut: false });
  const orq = (args) => cli(args, { stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run } });
  assert.equal(await orq(['config', 'set', 'checks.full', 'false']), 0);
  await orq(['gate-run', 'integration', '1', sha]);
  const r = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.equal(r.verdict, 'fail');
  assert.equal(r.output, undefined);
});

test('gate-run: the final gate gets finalTimeoutMinutes (default 60), a unit gate 20; a timed-out final check says how to raise it', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  const sha = await commitOn(s.p.repo, unitOf(await readState(s.p.repo), 'a').branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  const seen = [];
  const run = async (_command, { timeoutMs }) => {
    seen.push(timeoutMs);
    return { code: 1, output: '', timedOut: true };
  };
  const orq = (args) => cli(args, {
    stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run },
  });
  assert.equal(await orq(['config', 'set', 'checks.setup', 'null']), 0);
  assert.equal(await orq(['config', 'set', 'checks.full', 'true']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(await orq(['config', 'set', 'finalTimeoutMinutes', '45']), 0);
  await orq(['gate-run', 'integration', '1', sha]);
  assert.deepEqual(seen, [20 * 60000, 60 * 60000, 45 * 60000]);
  assert.equal(await orq(['config', 'set', 'unitTimeoutMinutes', '50']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.equal(seen.at(-1), 50 * 60000);
  const result = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.deepEqual(result.failures, [
    'checks timed out after 45 min: raise the limit with "orq config set finalTimeoutMinutes <minutes>" or narrow checks.full, then "orq unit retry integration"',
  ]);
  assert.equal(await orq(['config', 'set', 'checks.setup', 'true']), 0);
  assert.equal(await orq(['config', 'set', 'finalTimeoutMinutes', '99999']), 0);
  await orq(['gate-run', 'integration', '1', sha]);
  assert.equal(seen.at(-1), 1440 * 60000); // capped at a day
  const afterSetup = JSON.parse(await fs.readFile(gateFile(s.p.repo, 'integration', 1, 'json'), 'utf8'));
  assert.deepEqual(afterSetup.failures, ['setup timed out (the limit is 1440 min a step; "orq config set finalTimeoutMinutes <minutes>" raises it)']);
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

test('same commit after feedback: no second gate, straight to the next rung', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { cap: 3, fx: { spawnGate: async () => { spawned.push(1); return 1; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['evidence failed (exit 1)'], flags: [], headSha: sha },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 2 });
  assert.equal(spawned.length, 0);
  const after = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([after.state, after.attempt, after.minTier, after.tried], ['queued', 3, 3, ['pa::m2']]);
  assert.deepEqual(after.lastFailure, ['no new commit after feedback', 'evidence failed (exit 1)']);
  const fresh = await commitOn(s.p.repo, u.branch, { 'a.txt': 'B\n' });
  assert.notEqual(fresh, sha);
});

test('same commit after a gate that only timed out: the commit is gated again', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { cap: 3, fx: { spawnGate: async () => { spawned.push(1); return 1; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['checks timed out after 20 min: raise the limit'], flags: [], headSha: sha },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 2 });
  assert.equal(spawned.length, 1);
  const after = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([after.state, after.attempt, after.headSha], ['gating', 2, sha]);
});

test('same commit after a timeout mixed with a real failure: still the next rung', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { cap: 3, fx: { spawnGate: async () => { spawned.push(1); return 1; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['checks timed out', 'forbidden paths: x'], flags: [], headSha: sha },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 2 });
  assert.equal(spawned.length, 0);
  assert.equal(unitOf(await readState(s.p.repo), 'a').attempt, 3);
});

test('after a nudge the gate runs even when the branch did not move: the shortcut is only for judged work', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { cap: 3, fx: { spawnGate: async () => { spawned.push(1); return 1; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: u.baseSha, pid: 1 },
    { type: 'unfinished', unit: 'a', failures: ['no commits on top of x'], headSha: u.baseSha },
    { type: 'feedback-sent', unit: 'a', attempt: 1, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.equal(spawned.length, 1); // the tick, not this shortcut, decides what a second empty turn means
  const after = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([after.state, after.attempt, after.gateStarts], ['gating', 1, 1]);
});

test('a new commit after feedback is gated', async (t) => {
  const spawned = [];
  const s = await setup(t, [unitSpec('a')], { cap: 3, fx: { spawnGate: async () => { spawned.push(1); return 1; } } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const sha = await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: sha, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['x'], flags: [], headSha: sha },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'completed' });
  await commitOn(s.p.repo, u.branch, { 'a.txt': 'B\n' });
  await s.act({ type: 'gate-start', unit: 'a', attempt: 2 });
  assert.equal(spawned.length, 1);
  assert.equal(unitOf(await readState(s.p.repo), 'a').gateStarts, 1);
});

test('collectGate: a dead gate with no result reports the last line of its log', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await fs.mkdir(path.dirname(gateFile(s.p.repo, 'a', 1, 'log')), { recursive: true });
  await fs.writeFile(gateFile(s.p.repo, 'a', 1, 'log'), `first\n\u001b[31morq: globs must be an array\u001b[0m\n\n${''}`);
  const g = await collectGate(s.fx, 'a', 1);
  assert.equal(g.running, false);
  assert.equal(g.result, null);
  assert.match(g.error, /^.?\[?3?1?m?orq: globs must be an array/);
  assert.equal(/[\u0000-\u001f]/.test(g.error), false);
  await fs.writeFile(gateFile(s.p.repo, 'a', 1, 'log'), 'x'.repeat(500));
  assert.equal((await collectGate(s.fx, 'a', 1)).error.length, 160);
});

test('gate-start: the log of an earlier gate for the same unit and attempt is not read as this gate\'s reason', async (t) => {
  const s = await setup(t, [unitSpec('a')], { fx: { spawnGate: async () => 5151, isAlive: () => false } });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await commitOn(s.p.repo, u.branch, { 'a.txt': 'A\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' });
  const log = gateFile(s.p.repo, 'a', 1, 'log');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, 'gate a attempt 1: pass\n');
  await s.act({ type: 'gate-start', unit: 'a', attempt: 1 });
  assert.deepEqual(await collectGate(s.fx, 'a', 1), { running: false, result: null }); // killed before it logged anything
});

test('collectGate: a log that cannot be read gives no reason instead of failing the poll', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await fs.mkdir(gateFile(s.p.repo, 'a', 1, 'log'), { recursive: true }); // a directory: reading it fails with EISDIR
  assert.deepEqual(await collectGate(s.fx, 'a', 1), { running: false, result: null });
});

test('feedback: a gate that found no commits tells the worker plainly to do the work and commit it', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await awaitingFeedback(s);
  const failures = ['no commits on top of aaaaaaaaaaaa'];
  await writeResult(s, 1, { ...failing, steps: [], flags: [], failures });
  await s.act(feedback(failures));
  const msg = s.t3.calls[1][2];
  assert.equal(msg, [
    'Your turn ended with nothing committed (no commits on top of aaaaaaaaaaaa), so the work order is not done.',
    'You are the implementer of this work order: do the work in this worktree yourself, commit it, then report.',
    'Do not wait for another thread or for approval, and do not end your turn to report progress.',
    'If something truly blocks you, or you find that nothing needs to change, reply with first line BLOCKED or NEEDS_CONTEXT and say why.',
  ].join('\n'));
  assert.ok(msg.split('\n').length <= 6);
});

test('feedback: a worker that stopped is quoted and told that unfinished work is no blocker', () => {
  const msg = feedbackMessage(['worker reported BLOCKED: implementation incomplete'], 'ignored gate text');
  assert.equal(msg, [
    'You stopped with: "BLOCKED: implementation incomplete".',
    'Unfinished work is not a blocker: you are the implementer, so continue the work order in this worktree, commit it, then report.',
    'A file outside "You may write" that the goal needs and that "You must not touch" does not list is yours to edit, unless it is a package manifest or lockfile: edit it and name it in your report. Do not ask for it.',
    'If you truly cannot go on without something you do not have, reply again with first line BLOCKED (or NEEDS_CONTEXT) and name the one specific thing you need and where you looked for it.',
  ].join('\n'));
});

// A launch that committed work, then died on its provider.
async function failedWithWork(t, files = { 'a.txt': 'a\n' }, opts = {}) {
  const s = await setup(t, (opts.units ?? ['a']).map((id) => unitSpec(id)), { cap: 3, ...opts });
  await s.act(launchA());
  const first = unitOf(await readState(s.p.repo), 'a');
  const head = files ? await commitOn(s.p.repo, first.branch, files) : s.p.baseSha;
  await append(s, { type: 'thread-ended', unit: 'a', status: 'failed' });
  return { s, first, head };
}
const otherModel = { key: 'pb::m2', instance: 'pb', model: 'm2' };

test('continue: a relaunch after a provider failure starts at the failed branch head and keeps the first base', async (t) => {
  const { s, first, head } = await failedWithWork(t, undefined, { units: ['a', 'b'] });
  // the integration head moves on meanwhile (b integrated); the continued unit is still judged from its first base
  await s.act(launchA('b'));
  const bSha = await toPassed(s, 'b', { 'b.txt': 'B\n' });
  await append(s, { type: 'integrated', unit: 'b', sha: bSha, head: bSha });
  const r = await s.act(launchA('a', otherModel));
  const o = s.t3.calls.filter((c) => c[0] === 'start').at(-1)[1];
  assert.equal(o.worktree, head);
  assert.match(o.branch, /\/a-a1-l2$/);
  const b = s.p.baseSha.slice(0, 12);
  assert.equal(o.message, [
    '## Hand-over',
    'A previous worker (pa::m2) stopped because its provider failed. Its committed work (1 commit, '
      + `${b}..${head.slice(0, 12)}) is already in this branch.`,
    `Read it first with \`git log ${b}..HEAD\` and \`git diff ${b}..HEAD\`: keep what is right, fix what is not, then finish the work order below.`,
    'Do not start over.',
    '',
    'Work order for a.\n',
  ].join('\n'));
  const u = unitOf(await readState(s.p.repo), 'a');
  assert.deepEqual([u.baseSha, u.continues, u.key], [first.baseSha, head, 'pb::m2']);
  assert.deepEqual(r.notes, ['note: unit a continues on pb::m2 from 1 commit left by pa::m2']);
  const lease = (await leasesOf(s.p)).find((l) => l.threadId === 'th3'); // th2 is b's
  assert.equal(lease.continues, head); // an adopted launch keeps it too
});

test('continue: the old worktree is named only when T3 knows it and it exists; nothing committed starts fresh', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-old-wt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { s, head } = await failedWithWork(t, { 'a.txt': 'a\n' }, { world: { worktrees: { th1: dir } } });
  await s.act(launchA('a', otherModel));
  const msg = s.t3.calls.filter((c) => c[0] === 'start')[1][1].message;
  assert.ok(msg.includes(`\nUncommitted files it left may still be in ${dir}: you may read them, never rely on them.\n`), msg);
  assert.ok(head);

  // nothing committed: fresh from the integration head, as before; the old worktree is named only if it has changes
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  t.after(() => fs.rm(wt, { recursive: true, force: true }));
  const n = await failedWithWork(t, null, { world: { worktrees: { th1: wt, th2: wt } } });
  const u = unitOf(await readState(n.s.p.repo), 'a');
  sh(n.s.p.repo, 'worktree', 'add', '-q', wt, u.branch);
  await n.s.act(launchA('a', otherModel));
  const clean = n.s.t3.calls.filter((c) => c[0] === 'start')[1][1];
  assert.deepEqual([clean.worktree, clean.message], [n.s.p.baseSha, 'Work order for a.\n']);
  assert.equal(unitOf(await readState(n.s.p.repo), 'a').continues, null);
  await fs.writeFile(path.join(wt, 'half.txt'), 'half\n');
  await append(n.s, { type: 'thread-ended', unit: 'a', status: 'failed' });
  await n.s.act(launchA('a', otherModel));
  const dirty = n.s.t3.calls.filter((c) => c[0] === 'start')[2][1];
  assert.equal(dirty.worktree, n.s.p.baseSha);
  assert.equal(dirty.message, [
    '## Hand-over',
    'A previous worker (pb::m2) stopped because its provider failed and committed nothing; this branch starts fresh.',
    `Uncommitted files it left may still be in ${wt}: you may read them, never rely on them.`,
    '',
    'Work order for a.\n',
  ].join('\n'));
});

test('continue: the quality ladder never inherits work; attempt 3 starts fresh from the integration head', async (t) => {
  const { s, head } = await failedWithWork(t);
  await s.act(launchA('a', otherModel));
  const u = unitOf(await readState(s.p.repo), 'a');
  const h2 = await commitOn(s.p.repo, u.branch, { 'a.txt': 'b\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: h2, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['f1'], flags: [], headSha: h2 },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th2' }, { type: 'thread-ended', unit: 'a', status: 'completed' },
    { type: 'gate-started', unit: 'a', attempt: 2, headSha: h2, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 2, verdict: 'fail', failures: ['f2'], flags: [], headSha: h2 });
  await s.act(launchA('a', { attempt: 3, key: 'pa::m3', model: 'm3', tier: 3, failures: ['f2'] }));
  const o = s.t3.calls.filter((c) => c[0] === 'start')[2][1];
  assert.equal(o.worktree, s.p.baseSha);
  assert.ok(!o.message.includes('Hand-over'));
  assert.notEqual(o.worktree, head);
  assert.equal(unitOf(await readState(s.p.repo), 'a').continues, null);
});

test('continue: a thread given up as stalled is described as having stopped responding', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const head = await commitOn(s.p.repo, u.branch, { 'a.txt': 'a\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'stalled' });
  await s.act(launchA('a', otherModel));
  const msg = s.t3.calls.filter((c) => c[0] === 'start').at(-1)[1].message;
  assert.ok(msg.startsWith(`## Hand-over\nA previous worker (pa::m2) stopped responding and was given up. Its committed work (1 commit, ${s.p.baseSha.slice(0, 12)}..${head.slice(0, 12)}) is already in this branch.\n`), msg);
});

test('lease-abandon marks the lease abandoned and keeps it', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  await s.act({ type: 'lease-abandon', unit: 'a', threadId: 'th1' });
  assert.deepEqual((await leasesOf(s.p)).map((l) => [l.threadId, l.abandoned, l.blocked]), [['th1', true, false]]);
});

test('continue: a provider failure during the feedback run continues on the rejected commits and says so', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  const head = await commitOn(s.p.repo, u.branch, { 'a.txt': 'wrong\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'completed' }, { type: 'gate-started', unit: 'a', attempt: 1, headSha: head, pid: 1 },
    { type: 'gated', unit: 'a', attempt: 1, verdict: 'fail', failures: ['evidence failed (exit 1)'], flags: [], headSha: head },
    { type: 'feedback-sent', unit: 'a', attempt: 2, threadId: 'th1' }, { type: 'thread-ended', unit: 'a', status: 'failed' });
  await s.act(launchA('a', { ...otherModel, attempt: 2, failures: ['evidence failed (exit 1)'] }));
  const o = s.t3.calls.filter((c) => c[0] === 'start').at(-1)[1];
  assert.equal(o.worktree, head);
  const b = s.p.baseSha.slice(0, 12);
  assert.ok(o.message.startsWith([
    '## Hand-over',
    `A previous worker (pa::m2) stopped because its provider failed. Its committed work (1 commit, ${b}..${head.slice(0, 12)}) is already in this branch.`,
    `The gate rejected this work; its failures follow. Read it with \`git log ${b}..HEAD\` and \`git diff ${b}..HEAD\`, fix the failures, then finish the work order below.`,
    'Do not start over.',
    '',
    'Previous attempt failed the gate:\n- evidence failed (exit 1)',
  ].join('\n')), o.message);
});

test('continue: through a failed start, the next launch still continues from the first worker\'s commits', async (t) => {
  const world = {};
  const { s, first, head } = await failedWithWork(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { world });
  world.startFails = 1; // l2 never starts: its branch never exists
  await s.act(launchA('a', otherModel));
  assert.equal(unitOf(await readState(s.p.repo), 'a').state, 'queued');
  const r = await s.act(launchA('a', { key: 'pa::m3', model: 'm3', tier: 3 }));
  const o = s.t3.calls.filter((c) => c[0] === 'start').at(-1)[1];
  assert.match(o.branch, /\/a-a1-l3$/);
  assert.equal(o.worktree, head);
  assert.ok(o.message.includes(`(1 commit, ${first.baseSha.slice(0, 12)}..${head.slice(0, 12)})`), o.message);
  assert.deepEqual(r.notes, ['note: unit a continues on pa::m3 from 1 commit left by pa::m2']); // the author, not the start that failed
});

// The main checkout has installed dependencies matching its committed manifests; `share` lists them.
async function withDeps(t, over = {}) {
  const world = { makeWorktrees: true, ...over.world };
  const s = await setup(t, [unitSpec('a', over.unit ?? {})], { cap: 3, world });
  t.after(() => fs.rm(`${s.p.repo}-wt-1`, { recursive: true, force: true }));
  await fs.writeFile(path.join(s.p.repo, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(s.p.repo, 'package.json'), '{"name":"x"}\n');
  await fs.writeFile(path.join(s.p.repo, over.lock ?? 'bun.lock'), 'lockfileVersion: 1\n'); // npm and pnpm projects are never shared
  sh(s.p.repo, 'add', '-A');
  sh(s.p.repo, 'commit', '-q', '-m', 'deps');
  await fs.mkdir(path.join(s.p.repo, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(s.p.repo, 'node_modules', 'x', 'y.js'), '1\n');
  s.run.config = { ...s.run.config, share: ['node_modules'] };
  return { s, world };
}

test('S: a worker whose commit has the same manifests gets the main checkout\'s node_modules linked, and is told so', async (t) => {
  const { s, world } = await withDeps(t);
  const r = await s.act(launchA());
  assert.equal(r.notes, undefined);
  const o = s.t3.calls.find((c) => c[0] === 'start')[1];
  assert.ok(o.message.startsWith('Dependencies: node_modules are linked from the main checkout. Do not install, delete or modify them; if you must change dependencies, report NEEDS_CONTEXT.\n\nWork order for a.'), o.message);
  const link = path.join(world.worktrees.th1, 'node_modules');
  assert.equal(await fs.readlink(link), path.join(s.p.repo, 'node_modules'));
});

test('S: a pnpm worker gets no link (pnpm writes links through it that dangle once the worktree goes) but how to install', async (t) => {
  const { s, world } = await withDeps(t, { lock: 'pnpm-lock.yaml' });
  await s.act(launchA());
  const o = s.t3.calls.find((c) => c[0] === 'start')[1];
  assert.ok(o.message.startsWith('Dependencies: pnpm dependencies are not linked into this worktree. Install them before running anything: `pnpm install --frozen-lockfile --prefer-offline`'), o.message);
  assert.equal(fsSync.existsSync(path.join(world.worktrees.th1, 'node_modules')), false);
});

test('S: a bun root linked and a pnpm subproject installed: the order carries both lines', async (t) => {
  const { s, world } = await withDeps(t);
  await fs.mkdir(path.join(s.p.repo, 'site', 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(s.p.repo, 'site', 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  await s.act(launchA());
  const o = s.t3.calls.find((c) => c[0] === 'start')[1];
  assert.ok(o.message.startsWith('Dependencies: node_modules are linked from the main checkout.'), o.message);
  assert.ok(o.message.includes('\n\nDependencies: pnpm dependencies are not linked into this worktree. Install them before running anything: `pnpm -C site install --frozen-lockfile --prefer-offline`'), o.message);
  assert.equal(await fs.readlink(path.join(world.worktrees.th1, 'node_modules')), path.join(s.p.repo, 'node_modules'));
});

test('gate-run: a pnpm project with no setup step installs its own node_modules in the gate; share null keeps the old way', async (t) => {
  const s = await setup(t, [unitSpec('a')]);
  await s.act(launchA());
  await fs.writeFile(path.join(s.p.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  await fs.mkdir(path.join(s.p.repo, 'node_modules'));
  const sha = await commitOn(s.p.repo, unitOf(await readState(s.p.repo), 'a').branch, { 'a.txt': 'A\n' });
  const quiet = { write: () => {} };
  const commands = [];
  const run = async (command, { cwd }) => {
    commands.push([command, fsSync.existsSync(path.join(cwd, 'node_modules'))]);
    return { code: 0, output: '', timedOut: false };
  };
  const orq = (args) => cli(args, {
    stdout: quiet, stderr: quiet, env: s.p.env, cwd: s.p.repo, deps: { run, clone: () => false },
  });
  assert.equal(await orq(['config', 'set', 'share', 'node_modules']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(commands, [['pnpm install --frozen-lockfile --prefer-offline', false], ['test -f a.txt', false]]);
  commands.length = 0;
  assert.equal(await orq(['config', 'set', 'share', 'null']), 0);
  await orq(['gate-run', 'a', '1', sha]);
  assert.deepEqual(commands.map(([c]) => c), ['test -f a.txt']);
});

test('S: no link and no line when the manifests differ, the unit changes dependencies, or it opts out', async (t) => {
  for (const [label, over, change] of [
    ['manifests differ', {}, (repo) => fs.writeFile(path.join(repo, 'package.json'), '{"name":"y"}\n')],
    ['unit touches package.json', { unit: { paths: ['a.txt', 'package.json'] } }, null],
    ['share: false', { unit: { share: false } }, null],
  ]) {
    const { s, world } = await withDeps(t, over);
    if (change) await change(s.p.repo);
    await s.act(launchA());
    const o = s.t3.calls.find((c) => c[0] === 'start')[1];
    assert.equal(o.message, 'Work order for a.\n', label);
    assert.equal(fsSync.existsSync(path.join(world.worktrees.th1, 'node_modules')), false, label);
  }
});

test('S: a worktree T3 never reports is skipped with a note', async (t) => {
  const { s } = await withDeps(t, { world: { makeWorktrees: false } });
  const r = await s.act(launchA());
  assert.deepEqual(r.notes, ['note: unit a: dependencies not linked: node_modules (worktree not found)']);
});

test('T2: two commits are counted in the plural', async (t) => {
  const s = await setup(t, [unitSpec('a')], { cap: 3 });
  await s.act(launchA());
  const u = unitOf(await readState(s.p.repo), 'a');
  await commitOn(s.p.repo, u.branch, { 'a.txt': '1\n' });
  await commitOn(s.p.repo, u.branch, { 'a.txt': '2\n' });
  await append(s, { type: 'thread-ended', unit: 'a', status: 'failed' });
  const r = await s.act(launchA('a', otherModel));
  assert.deepEqual(r.notes, ['note: unit a continues on pb::m2 from 2 commits left by pa::m2']);
  assert.match(s.t3.calls.filter((c) => c[0] === 'start').at(-1)[1].message, /Its committed work \(2 commits, /);
});
