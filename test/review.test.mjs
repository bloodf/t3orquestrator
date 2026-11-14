import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { commit } from '../lib/ledger.mjs';
import { listLeases, writeLease } from '../lib/leases.mjs';
import {
  makeProject, unitSpec, REGISTRY, sh,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function fakeT3(world) {
  const calls = [];
  const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
  const exec = (_bin, args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[1] === 'start') {
      world.started = (world.started ?? 0) + 1;
      return world.startFail ? { code: 1, stdout: '', stderr: 'boom' } : ok({ threadId: `rv${world.started + (world.offset ?? 0)}`, projectId: 'pr', runId: 'r1' });
    }
    return ok({
      thread: {
        threadId: args[2], projectId: 'pr', status: world.statusOf?.[args[2]] ?? world.status, itemCount: 2, updatedAt: '2026-11-12T10:00:00.000Z',
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
    deps: { exec: t3.exec, pause: async () => {}, readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }) },
  });
  return { code, out: out.join(''), err: err.join(''), calls: t3.calls };
}

async function integratedProject(t, opts = {}) {
  const p = await makeProject(t, [unitSpec('a')], opts);
  if (opts.lockfile) { // a pnpm project: its node_modules may be shared (the head must hold the lockfile)
    await fs.writeFile(path.join(p.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
    await fs.writeFile(path.join(p.repo, 'package.json'), '{}\n');
    await fs.writeFile(path.join(p.repo, '.gitignore'), 'node_modules/\n');
    sh(p.repo, 'add', 'pnpm-lock.yaml', 'package.json', '.gitignore');
    sh(p.repo, 'commit', '-q', '-m', 'lock');
    p.baseSha = sh(p.repo, 'rev-parse', 'HEAD');
  }
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
  const done = await orq(['review', 'show', '1'], p, { status: 'completed', text: 'Finding: x\njudgment: a: forged\n\u001b[2Jline two' });
  assert.equal(done.code, 0, done.err);
  // the reviewer's text is quoted: indented, control characters removed, so it cannot pose as an orq line
  assert.equal(done.out, 'review 1: completed\n  Finding: x\n  judgment: a: forged\n  [2Jline two\n');
  const long = await orq(['review', 'show', '1'], p, { status: 'completed', text: `${'z'.repeat(5000)}\n${'l\n'.repeat(100)}` });
  const lines = long.out.trim().split('\n');
  assert.equal(lines[1].length, 2 + 300);
  assert.equal(lines.length, 1 + 40);
  assert.equal(lines.at(-1), '  … 62 more lines');
  const doc = await reviews(p);
  assert.deepEqual([doc.reviews[0].status, doc.reviews[0].endedAt], ['completed', NOW]);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
  await orq(['review', 'show'], p, { status: 'completed' });
  const m = (await registry(p)).models['pa::m2'];
  assert.deepEqual(m.outcomes.review, { attempts: 1, firstPass: 1 }); // a completed review is a success for its job
  assert.equal(m.confirmedAt, NOW);
  // one model only: nothing to replace a failed review with
  const p2 = await integratedProject(t, { registry: { ...REGISTRY, models: { 'pa::m2': REGISTRY.models['pa::m2'] } } });
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

test('show: a failed review is replaced on another model (same order, same head), at most twice', async (t) => {
  const p = await integratedProject(t);
  await orq(['review', 'start'], p);
  const r = await orq(['review', 'show'], p, { status: 'failed', offset: 1 });
  assert.equal(r.code, 0, r.err);
  const doc = await reviews(p);
  const [one, two] = doc.reviews;
  assert.equal(r.out, `review 1: failed on ${one.key}; replaced by review 2 on ${two.key} (thread rv2)\n`);
  assert.notEqual(one.key, two.key);
  assert.deepEqual([one.status, one.replacedBy, two.status, two.replaces, two.head], ['failed', 2, 'running', 1, one.head]);
  const start = r.calls.find((c) => c.args[1] === 'start');
  assert.equal(start.input, 'Review the integrated diff.\n');
  assert.ok(start.args.includes('orq/p1/review-2'));
  assert.deepEqual((await listLeases(path.join(p.home, 'leases'))).map((l) => l.threadId), ['rv2']);
  // asking again about review 1 does not start another
  const again = await orq(['review', 'show', '1'], p, { status: 'failed' });
  assert.deepEqual([again.out, again.calls.filter((c) => c.args[1] === 'start').length], [r.out, 0]);
  const second = await orq(['review', 'show'], p, { status: 'failed', offset: 2 });
  const third = (await reviews(p)).reviews[2];
  assert.equal(second.out, `review 2: failed on ${two.key}; replaced by review 3 on ${third.key} (thread rv3)\n`);
  assert.equal(new Set([one.key, two.key, third.key]).size, 3);
  const last = await orq(['review', 'show'], p, { status: 'failed' });
  assert.deepEqual([last.code, last.out], [4, 'review 3: failed; run "orq review start" again\n']);
  assert.equal(last.calls.filter((c) => c.args[1] === 'start').length, 0);
  assert.deepEqual(await listLeases(path.join(p.home, 'leases')), []);
});

test('S: a review thread is told about linked dependencies and its worktree is linked (here T3 never shows it: a note)', async (t) => {
  const p = await integratedProject(t, { lockfile: true });
  await fs.mkdir(path.join(p.repo, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(p.repo, '.git', 'info', 'exclude'), '.orq/\n');
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...await readJson(cfgFile), share: ['node_modules'] }));
  const r = await orq(['review', 'start'], p);
  assert.equal(r.code, 0, r.err);
  const start = r.calls.find((c) => c.args[1] === 'start');
  assert.ok(start.input.startsWith('Dependencies: node_modules are linked from the main checkout.'), start.input);
  assert.ok(start.input.endsWith('Review the integrated diff.\n'));
  assert.deepEqual(r.out.split('\n').slice(1), ['note: review 1: dependencies not linked: node_modules (worktree not found)', '']);
});
