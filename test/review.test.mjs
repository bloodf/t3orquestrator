import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { commit } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function fakeT3(world) {
  const calls = [];
  const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
  const exec = (_bin, args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[1] === 'start') return world.startFail ? { code: 1, stdout: '', stderr: 'boom' } : ok({ threadId: 'rv1', projectId: 'pr', runId: 'r1' });
    return ok({
      thread: {
        threadId: 'rv1', projectId: 'pr', status: world.status, itemCount: 2, updatedAt: '2026-11-12T10:00:00.000Z',
        providerInstanceId: 'pa', model: 'm2', pendingRequestCount: 0,
      },
      messages: [{ role: 'user', runId: 'r', text: 'order' }, { role: 'assistant', runId: 'r', text: world.text }],
    });
  };
  return { calls, exec };
}

async function orq(args, p, world = {}) {
  const t3 = fakeT3({ status: 'running', text: 'No findings.', ...world });
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: { exec: t3.exec, readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }) },
  });
  return { code, out: out.join(''), err: err.join(''), calls: t3.calls };
}

async function integratedProject(t, opts = {}) {
  const p = await makeProject(t, [unitSpec('a')], opts);
  const ev = [
    { type: 'plan-started', unit: null, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration' },
    {
      type: 'launched', unit: 'a', attempt: 1, launch: 1, threadId: 'th1', key: 'pa::m2', instance: 'pa', model: 'm2', branch: 'orq/p1/a-a1', baseSha: p.baseSha, tier: 2, family: 'fam-a',
    },
    { type: 'thread-ended', unit: 'a', status: 'completed' },
    {
      type: 'gated', unit: 'a', attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: p.baseSha,
    },
    { type: 'integrated', unit: 'a', head: p.baseSha },
  ];
  await commit(p.repo, () => ev.map((e) => ({ at: NOW, ...e })));
  await fs.writeFile(path.join(p.repo, '.orq/orders/review.md'), 'Review the integrated diff.\n');
  return p;
}

const readJson = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const reviews = (p) => readJson(path.join(p.repo, '.orq/reviews.json'));
const registry = (p) => readJson(path.join(p.home, 'registry.json'));

test('start: launches on the integration head with a lease and a record', async (t) => {
  const p = await integratedProject(t);
  const r = await orq(['review', 'start'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `review 1: thread=rv1 model=pa::m2 head=${p.baseSha.slice(0, 12)}\n`);
  const start = r.calls.find((c) => c.args[1] === 'start');
  assert.equal(start.input, 'Review the integrated diff.\n');
  assert.deepEqual(start.args, [
    'thread', 'start', p.repo, '-', '--provider', 'pa', '--model', 'm2', '--worktree', p.baseSha, '--branch', 'orq/p1/review-1', '--title', 'orq review 1', '--json',
  ]);
  const doc = await reviews(p);
  assert.deepEqual(doc.reviews.map(({ n, threadId, key, status, head, tier, family }) => [n, threadId, key, status, head, tier, family]),
    [[1, 'rv1', 'pa::m2', 'running', p.baseSha, 2, 'f']]);
  const leases = await listLeases(path.join(p.home, 'leases'));
  assert.deepEqual(leases.map((l) => [l.threadId, l.unit, l.project, l.kind, l.review]), [['rv1', 'review-1', p.repo, 'review', 1]]);
  assert.equal((await registry(p)).models['pa::m2'].lastUsedAt, NOW);
  const second = await orq(['review', 'start'], p);
  assert.match(second.out, /^review 2: /);
  assert.ok(second.calls.find((c) => c.args[1] === 'start').args.includes('orq/p1/review-2'));
});

test('start: nothing integrated yet', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const r = await orq(['review', 'start'], p);
  assert.equal(r.code, 4);
  assert.match(r.err, /review: nothing integrated yet/);
  assert.equal(r.calls.length, 0);
});

test('start: no candidate prints the route verdict', async (t) => {
  const p = await integratedProject(t);
  const reg = await registry(p);
  for (const m of Object.values(reg.models)) m.cooldownUntil = NOW + 60_000;
  await fs.writeFile(path.join(p.home, 'registry.json'), JSON.stringify(reg));
  const r = await orq(['review', 'start'], p);
  assert.equal(r.code, 4);
  assert.equal(r.out, `none blocked=cooling retry_at=${new Date(NOW + 60_000).toISOString()} reason="all cooling down"\n`);
  assert.equal(r.calls.length, 0);
});

test('start: the order file must be under .orq/, present and short', async (t) => {
  const p = await integratedProject(t);
  for (const order of ['../x.md', '/etc/hosts', 'README.md', '.orq/plan.json', '.orq/ledger.jsonl']) {
    const r = await orq(['review', 'start', '--order', order], p);
    assert.equal(r.code, 2, order);
    assert.match(r.err, /--order must be a file under \.orq\//);
  }
  const missing = await orq(['review', 'start', '--order', '.orq/orders/nope.md'], p);
  assert.equal(missing.code, 4);
  assert.match(missing.err, /missing/);
  await fs.writeFile(path.join(p.repo, '.orq/orders/long.md'), 'x\n'.repeat(41));
  const long = await orq(['review', 'start', '--order', '.orq/orders/long.md'], p);
  assert.equal(long.code, 4);
  assert.match(long.err, /41 lines.*40/);
  assert.equal(long.calls.length, 0);
});

test('start: a failed start records the failure and no review', async (t) => {
  const p = await integratedProject(t);
  const r = await orq(['review', 'start'], p, { startFail: true });
  assert.equal(r.code, 4);
  assert.match(r.err, /^orq: review: start failed on pa::m2; run it again for the next candidate\n$/);
  await assert.rejects(fs.stat(path.join(p.repo, '.orq/reviews.json')));
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  const m = (await registry(p)).models['pa::m2'];
  assert.equal(m.failures, 1);
  assert.equal(m.cooldownUntil, NOW + 10 * 60_000);
  const next = await orq(['route', '--job', 'review'], p);
  assert.match(next.out, /^1 pb m2 /);
});

test('start: respects the machine cap', async (t) => {
  const p = await integratedProject(t, { cap: 1 });
  await writeLease(path.join(p.home, 'leases'), {
    threadId: 'other', project: '/elsewhere', unit: 'z', instance: 'pb', model: 'm2', startedAt: NOW, heartbeatAt: NOW, blocked: false,
  });
  const r = await orq(['review', 'start'], p);
  assert.equal(r.code, 4);
  assert.match(r.out, /^none blocked=limit retry_at=- reason="cap reached"\n$/);
  assert.equal(r.calls.filter((c) => c.args[1] === 'start').length, 0);
  assert.deepEqual((await listLeases(path.join(p.home, 'leases'))).map((l) => l.threadId), ['other']);
});

test('show: none started', async (t) => {
  const p = await integratedProject(t);
  const r = await orq(['review', 'show'], p);
  assert.equal(r.code, 4);
  assert.match(r.err, /review: none started/);
});

test('show: running, completed (recorded once), failed', async (t) => {
  const p = await integratedProject(t);
  await orq(['review', 'start'], p);
  const running = await orq(['review', 'show'], p, { status: 'running' });
  assert.equal(running.out, 'review 1: running\n');
  assert.equal((await reviews(p)).reviews[0].status, 'running');
  const done = await orq(['review', 'show', '1'], p, { status: 'completed', text: 'Finding: x\nline two' });
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, 'review 1: completed\nFinding: x\nline two\n');
  const doc = await reviews(p);
  assert.deepEqual([doc.reviews[0].status, doc.reviews[0].endedAt], ['completed', NOW]);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  await orq(['review', 'show'], p, { status: 'completed' });
  const m = (await registry(p)).models['pa::m2'];
  assert.equal(m.outcomes.review.attempts, 1);
  assert.equal(m.confirmedAt, NOW);
  const p2 = await integratedProject(t);
  await orq(['review', 'start'], p2);
  const failed = await orq(['review', 'show'], p2, { status: 'failed' });
  assert.equal(failed.code, 4);
  assert.equal(failed.out, 'review 1: failed; run "orq review start" again\n');
  await orq(['review', 'show'], p2, { status: 'failed' });
  assert.equal((await registry(p2)).models['pa::m2'].failures, 1);
  assert.equal((await reviews(p2)).reviews[0].status, 'failed');
  assert.deepEqual(await listLeases(path.join(p2.home, 'leases')), []);
});

test('show: a running review keeps its lease fresh', async (t) => {
  const p = await integratedProject(t);
  await orq(['review', 'start'], p);
  const dir = path.join(p.home, 'leases');
  const [l] = await listLeases(dir);
  await writeLease(dir, { ...l, heartbeatAt: 5 });
  await orq(['review', 'show'], p, { status: 'running' });
  assert.equal((await listLeases(dir))[0].heartbeatAt, NOW);
});

test('review: usage errors', async (t) => {
  const p = await integratedProject(t);
  for (const args of [['review'], ['review', 'frob'], ['review', 'show', 'x'], ['review', 'start', '--bogus'], ['review', 'show', '--order', 'x']]) {
    assert.equal((await orq(args, p)).code, 2, args.join(' '));
  }
});

test('start: the reservation lease is marked as a review lease too', async (t) => {
  const p = await integratedProject(t);
  const dir = path.join(p.home, 'leases');
  let seen = null;
  const fake = fakeT3({ status: 'running', text: '' });
  await run(['review', 'start'], {
    stdout: { write() {} }, stderr: { write() {} }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }),
      exec: (...a) => { seen = fsSync.readdirSync(dir).map((n) => JSON.parse(fsSync.readFileSync(path.join(dir, n), 'utf8'))); return fake.exec(...a); },
    },
  });
  const during = seen;
  assert.ok(during.some((l) => l.reservation === true && l.kind === 'review' && l.review === 1));
});

test('start: an order that is a directory or a symlink out of .orq is refused', async (t) => {
  const p = await integratedProject(t);
  await fs.mkdir(path.join(p.repo, '.orq/orders/dir.md'));
  const d = await orq(['review', 'start', '--order', '.orq/orders/dir.md'], p);
  assert.equal(d.code, 4);
  await fs.writeFile(path.join(p.root, 'outside.md'), 'x\n');
  await fs.symlink(path.join(p.root, 'outside.md'), path.join(p.repo, '.orq/orders/link.md'));
  const l = await orq(['review', 'start', '--order', '.orq/orders/link.md'], p);
  assert.equal(l.code, 2);
  assert.equal(l.calls.length, 0);
});
