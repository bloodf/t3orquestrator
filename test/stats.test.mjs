import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { computeStats, renderStats } from '../lib/stats.mjs';

const MIN = 60_000;
const ev = (type, unit, at, extra = {}) => ({ type, unit, at: at * MIN, ...extra });
const start = (at = 0) => ev('plan-started', null, at, { planId: 'p1' });
const launch = (unit, at, key, extra = {}) => {
  const [instance, model] = key.split('::');
  return ev('launched', unit, at, {
    attempt: 1, threadId: 't', key, instance, model, tier: 2, ...extra,
  });
};
const ended = (unit, at, status = 'completed') => ev('thread-ended', unit, at, { status });
const gated = (unit, at, verdict, attempt = 1, failures = []) => ev('gated', unit, at, { attempt, verdict, failures });
const A = 'pa::m2';
const B = 'pb::m3';

test('attribution across a relaunch', () => {
  const s = computeStats([
    start(), launch('u', 1, A), ended('u', 3, 'failed'), launch('u', 4, B), ended('u', 9), gated('u', 10, 'pass'), ev('integrated', 'u', 11),
  ]);
  assert.equal(s.models[A].provider_failed, 1);
  assert.equal(s.models[A].gate_pass, 0);
  assert.equal(s.models[B].gate_pass, 1);
  assert.equal(s.models[B].first_pass, 1);
  assert.equal(s.models[B].completed, 1);
  assert.equal(s.models[B].integrated, 1);
  assert.equal(s.workerMinutes, 7);
  assert.equal(s.wallMinutes, 11);
  assert.deepEqual([s.plans, s.units, s.integrated], [1, 1, 1]);
});

test('a failed start counts as a provider failure', () => {
  const s = computeStats([start(), launch('u', 1, A, { threadId: null }), ended('u', 1, 'start-failed')]);
  assert.equal(s.models[A].provider_failed, 1);
});

test('feedback round: no commit, then pass, is not a first pass', () => {
  const s = computeStats([
    start(), launch('u', 1, A), ended('u', 5),
    gated('u', 6, 'fail', 1, ['no commits on top of abc123']),
    ev('feedback-sent', 'u', 7, { attempt: 2, threadId: 't' }), ended('u', 10), gated('u', 11, 'pass', 2),
  ]);
  assert.deepEqual(
    [s.models[A].gate_fail, s.models[A].gate_pass, s.models[A].no_commit, s.models[A].first_pass],
    [1, 1, 1, 0],
  );
  assert.equal(s.workerMinutes, 7);
});

test('a nudged turn counts as no-commit, not as a gate failure, and the later pass is not a first pass', () => {
  const s = computeStats([
    start(), launch('u', 1, A), ended('u', 5), ev('unfinished', 'u', 6, { failures: ['no commits on top of abc123'] }),
    ev('feedback-sent', 'u', 7, { attempt: 1, threadId: 't' }), ended('u', 10), gated('u', 11, 'pass', 1),
  ]);
  assert.deepEqual(
    [s.models[A].gate_fail, s.models[A].gate_pass, s.models[A].no_commit, s.models[A].first_pass],
    [0, 1, 1, 0],
  );
  assert.equal(s.workerMinutes, 7);
});

test('worker-reported stop and unit end states', () => {
  const s = computeStats([
    start(), launch('u', 1, A), launch('v', 1, A), launch('w', 1, B),
    ev('needs-judgment', 'u', 2, { reason: 'worker reported blocked: x' }),
    ev('needs-judgment', 'v', 2, { reason: 'gate could not start' }), ev('dropped', 'w', 3),
  ]);
  assert.equal(s.models[A].stopped, 1);
  assert.deepEqual([s.failed, s.dropped, s.units], [2, 1, 3]);
  assert.deepEqual(s.tiers, { 1: 0, 2: 3, 3: 0, 4: 0 });
  assert.deepEqual(s.instances, { pa: 2, pb: 1 });
});

test('no-evidence on attempt 1 is a first pass; an attempt 2 first result is not', () => {
  const s = computeStats([start(), launch('u', 1, A), gated('u', 2, 'no-evidence'), launch('v', 1, A), gated('v', 2, 'pass', 2)]);
  assert.equal(s.models[A].first_pass, 1);
});

test('unknown and malformed events are ignored; input not mutated', () => {
  const input = [null, 7, 'x', {}, { type: 'weird', unit: 'u', at: 'soon' }, start(), launch('u', 1, A), { type: 'gated', unit: 'u' }, ev('thread-ended', 'zz', 2)];
  const copy = structuredClone(input);
  const s = computeStats(input);
  assert.deepEqual(input, copy);
  assert.equal(s.models[A].launched, 1);
  assert.equal(computeStats(undefined).plans, 0);
});

test('empty input renders a plain line; long tables are capped', () => {
  assert.equal(renderStats(computeStats([])), 'no runs recorded\n');
  const events = [start()];
  for (let i = 0; i < 45; i += 1) events.push(launch(`u${i}`, i, `inst::m${i}`));
  const text = renderStats(computeStats(events));
  assert.match(text, /\+5 more\n$/);
  for (const line of text.split('\n')) assert.ok(line.length < 160);
});

async function project(t, current, archives = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-stats-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const put = async (file, events) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  };
  await put(path.join(dir, '.orq', 'ledger.jsonl'), current);
  for (const [id, events] of Object.entries(archives)) await put(path.join(dir, '.orq', 'archive', id, 'ledger.jsonl'), events);
  return dir;
}
async function orq(args, cwd) {
  const out = [];
  const code = await run(args, { stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, env: {}, cwd, now: () => 0 });
  return { code, out: out.join('') };
}

test('command: --all merges archived plans; default reads the current plan only', async (t) => {
  const cwd = await project(t, [start(), launch('u', 1, A)], { p0: [start(), launch('u', 1, B), gated('u', 2, 'pass')] });
  const one = JSON.parse((await orq(['stats', '--json'], cwd)).out);
  assert.deepEqual([one.plans, Object.keys(one.models)], [1, [A]]);
  const all = JSON.parse((await orq(['stats', '--all', '--json'], cwd)).out);
  assert.equal(all.plans, 2);
  assert.equal(all.models[B].first_pass, 1);
  assert.equal(all.models[A].launched, 1);
});

test('command: empty ledger and text table', async (t) => {
  const empty = await orq(['stats'], await project(t, []));
  assert.deepEqual(empty, { code: 0, out: 'no runs recorded\n' });
  const r = await orq(['stats'], await project(t, [start(), launch('u', 1, A), ended('u', 4), gated('u', 5, 'pass')]));
  assert.equal(r.code, 0);
  assert.match(r.out, /^plans: 1 {2}units: 1 .*worker time: 3 min/);
  assert.match(r.out, /tiers: t1=0 t2=1 t3=0 t4=0/);
  assert.match(r.out, /^pa::m2 +1 +1 +0 +1 +0 +1 +0 +0 +0$/m);
});

test('command: --json shape and bad usage', async (t) => {
  const cwd = await project(t, [start(), launch('u', 1, A)]);
  const j = JSON.parse((await orq(['stats', '--json'], cwd)).out);
  assert.deepEqual(Object.keys(j).sort(), ['dropped', 'failed', 'instances', 'integrated', 'models', 'plans', 'tiers', 'units', 'wallMinutes', 'workerMinutes']);
  assert.equal((await orq(['stats', '--bogus'], cwd)).code, 2);
});

test('a continued launch is counted as continued, never as a first pass', () => {
  const s = computeStats([
    start(), launch('u', 1, A), ended('u', 3, 'stalled'), launch('u', 4, B, { continues: 'c'.repeat(40) }), ended('u', 9), gated('u', 10, 'pass'),
  ]);
  assert.deepEqual([s.models[B].continued, s.models[B].first_pass, s.models[B].gate_pass, s.models[A].continued], [1, 0, 1, 0]);
  const text = renderStats(s);
  assert.match(text.split('\n')[3], / continued$/);
  assert.match(text, new RegExp(`^${B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .* 1$`, 'm'));
});
