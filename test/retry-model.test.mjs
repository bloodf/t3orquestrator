// Every relaunch of a unit goes to a model none of its attempts used, preferring another family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick } from '../lib/tick.mjs';
import { reduce, commit } from '../lib/ledger.mjs';
import { run } from '../lib/cli.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-12T12:00:00Z');
const A = 'a'.repeat(40);
const inst = { enabled: true, constraints: [], limit: 4, failures: 0, cooldownUntil: null };
const model = (instance, name, family) => [`${instance}::${name}`, {
  instance, model: name, family, tier: 2, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null, outcomes: {},
}];
const registry = (models) => ({ version: 1, instances: { a: inst, b: inst }, models: Object.fromEntries(models) });
const plan = {
  goal: 'g', units: [{
    id: 'u', title: 'u', job: 'implement', deps: [], paths: ['u/**'], forbidden: [], evidence: 'true', order: '.orq/u.md',
  }],
};
const started = { type: 'plan-started', at: 1, planId: 'p', baseSha: A, integrationBranch: 'orq/p/integration' };
const launched = (key, launch = 1) => ({
  type: 'launched', unit: 'u', at: 2, attempt: 1, launch, threadId: `t${launch}`, key, instance: key.split('::')[0], model: key.split('::')[1], branch: `orq/p/u-a1-l${launch}`, baseSha: A, tier: 2,
});
// launched, its worker stopped twice, judged, then `orq unit retry u`: a new start, nothing excluded
const retriedAfter = (key, launch = 1) => [launched(key, launch), { type: 'needs-judgment', unit: 'u', at: 3, reason: 'worker reported BLOCKED: x' }, { type: 'retried', unit: 'u', at: 4 }];
const go = (events, models) => tick({
  plan, state: reduce([started, ...events]), threads: {}, registry: registry(models), rules, leases: [], cap: 4, gates: {}, config: {}, now: NOW,
});
const launchKey = (r) => r.actions.find((a) => a.type === 'launch')?.key;

test('ledger: a unit keeps every model it was launched on, through retries', () => {
  const s = reduce([started, ...retriedAfter('a::m2'), ...retriedAfter('b::m2', 2)]);
  assert.deepEqual(s.units.u.used, ['a::m2', 'b::m2']);
});

test('a relaunch picks a model no attempt used, of another family first; a used one only when nothing else is left, with a note', () => {
  const models = [model('a', 'm2', 'f'), model('a', 'x2', 'f'), model('b', 'm2', 'g')];
  assert.equal(launchKey(go([], models)), 'a::m2'); // the first launch: as before
  const again = go(retriedAfter('a::m2'), models);
  assert.equal(launchKey(again), 'b::m2'); // unused, and of another family
  assert.deepEqual(again.report.notes, []);
  assert.equal(launchKey(go([...retriedAfter('a::m2'), ...retriedAfter('b::m2', 2)], models)), 'a::x2');
  const all = [...retriedAfter('a::m2'), ...retriedAfter('b::m2', 2), ...retriedAfter('a::x2', 3)];
  const reused = go(all, models);
  assert.equal(launchKey(reused), 'a::m2');
  assert.deepEqual(reused.report.notes, ['note: unit u relaunched on a::m2, a model an earlier attempt used: no unused model is eligible']);
});

test('orq status shows the models a unit was tried on', async (t) => {
  const p = await makeProject(t, [unitSpec('u')]);
  await commit(p.repo, () => [{ ...started, baseSha: p.baseSha }, ...retriedAfter('pa::m2'), launched('pb::m2', 2)]);
  const out = [];
  const code = await run(['status'], {
    stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, env: p.env, cwd: p.repo, now: () => NOW,
    deps: { readMachine: () => ({ cores: 8, availableMemBytes: 16 * 1024 ** 3, load1: 0 }), exec: () => ({ code: 1, stdout: '', stderr: '' }) },
  });
  assert.equal(code, 0);
  assert.match(out.join(''), /\nu running attempt=1 model=pb::m2 tier=2 tried=pa::m2,pb::m2 thread=t2\n/);
});
