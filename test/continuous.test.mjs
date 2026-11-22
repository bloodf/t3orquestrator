// Continuous mode: the rolling final gate (ledger and tick) and what `orq wait` prints for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick } from '../lib/tick.mjs';
import { reduce, apply, FINAL } from '../lib/ledger.mjs';
import { decide } from '../lib/commands/wait-report.mjs';
import {
  issuesOf, shipBody, shipTextError, shipTitle, shipUnits, newerThanShipped,
} from '../lib/ship.mjs';

const rules = JSON.parse(readFileSync(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-12T12:00:00Z');
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((x) => x.repeat(40));
const inst = { enabled: true, constraints: [], limit: 4, failures: 0, cooldownUntil: null };
const registry = {
  version: 1,
  instances: { a: inst },
  models: {
    'a::m2': {
      instance: 'a', model: 'm2', family: 'f', tier: 2, tierSource: 'user', available: true, confirmedAt: null, failures: 0, cooldownUntil: null, lastUsedAt: null, outcomes: {},
    },
  },
};
const unit = (id) => ({
  id, title: `do ${id}`, job: 'implement', deps: [], paths: [`${id}/**`], forbidden: [], evidence: 'true', order: `.orq/${id}.md`,
});
const plan = { goal: 'g', units: [unit('a'), unit('b')] };
const started = { type: 'plan-started', at: 1, planId: 'p', baseSha: A, integrationBranch: 'orq/p/integration' };
const launched = (u) => ({
  type: 'launched', unit: u, at: 2, attempt: 1, threadId: `t-${u}`, key: 'a::m2', instance: 'a', model: 'm2', branch: `orq/p/${u}-a1`, baseSha: A, tier: 2,
});
const through = (u, head) => [launched(u), { type: 'thread-ended', unit: u, at: 3, status: 'completed' },
  { type: 'gate-started', unit: u, at: 4, attempt: 1, headSha: B, pid: 7 },
  { type: 'gated', unit: u, at: 5, attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B },
  { type: 'integrated', unit: u, at: 6, sha: B, head }];
const finalStart = (head) => ({ type: 'gate-started', unit: FINAL, at: 7, attempt: 1, headSha: head, pid: 1 });
const finalGated = (head, verdict = 'pass') => ({
  type: 'final-gated', unit: null, at: 8, verdict, failures: verdict === 'fail' ? ['checks failed (exit 1)'] : [], head, checks: 'npm test',
});
const result = (head, verdict = 'pass') => ({
  running: false, result: {
    verdict, failures: verdict === 'fail' ? ['boom'] : [], flags: [], headSha: head, checks: 'npm test',
  },
});
const aInC = through('a', C);
const bRunning = [launched('b')];
const thread = { 't-b': { id: 't-b', status: 'running', pending: 0, updatedAt: NOW } };

function go(events, over = {}) {
  return tick({
    plan, state: reduce([started, ...events]), threads: thread, registry, rules, leases: [], cap: 4, gates: {}, config: { continuous: true }, now: NOW, ...over,
  });
}
const finals = (r) => r.actions.filter((a) => a.type === 'final-gate').length;

test('ledger: final starts count per head; green follows the latest pass; shipped and final-noted are plan events', () => {
  let s = reduce([started, ...aInC, finalStart(C)]);
  assert.deepEqual([s.plan.finalHead, s.plan.finalHeadStarts], [C, 1]);
  s = [...through('b', D).slice(0, 4), { type: 'integrated', unit: 'b', at: 6, sha: B, head: D }, finalStart(D)].reduce(apply, s);
  assert.deepEqual([s.plan.finalHead, s.plan.finalHeadStarts, s.plan.finalGateStarts], [D, 1, 1]); // C's lost run does not add up
  assert.deepEqual(s.plan.integrations, [{ unit: 'a', head: C }, { unit: 'b', head: D }]);
  s = apply(s, finalStart(D));
  assert.equal(s.plan.finalHeadStarts, 2);
  s = apply(s, finalGated(D, 'fail'));
  assert.equal(s.plan.green, undefined);
  s = apply(s, { type: 'final-noted', unit: null, at: 9, head: D });
  s = apply(s, { type: 'final-retried', unit: null, at: 9 });
  assert.equal(s.plan.noted, null); // a retried head that fails again is reported again
  s = apply(s, finalGated(D));
  assert.deepEqual([s.plan.green, s.plan.greenVerdict, s.plan.greenChecks, s.plan.finalHeadStarts], [D, 'pass', 'npm test', 0]);
  const unverified = apply(s, { ...finalGated(E, 'no-evidence'), checks: null });
  assert.deepEqual([unverified.plan.green, unverified.plan.greenVerdict], [E, 'no-evidence']); // `orq ship` refuses it
  s = apply(s, { type: 'shipped', unit: null, at: 10, head: D, pr: 'https://x/pull/7', n: 1 });
  assert.deepEqual([s.plan.shipped, s.plan.ships], [D, 1]);
  s = apply(s, { type: 'final-noted', unit: null, at: 11, head: D });
  assert.equal(s.plan.noted, D);
  assert.equal(reduce([started]).plan.green, undefined); // older ledgers: unset, read as none
});

test('rolling start: only in continuous mode, once a unit is integrated, the head has no verdict, nothing runs, and a gate slot is free', () => {
  assert.equal(finals(go([...aInC, ...bRunning])), 1);
  assert.equal(finals(go([...aInC, ...bRunning], { config: {} })), 0); // other modes: only when the plan is complete
  assert.equal(finals(go(bRunning)), 0); // nothing integrated
  assert.equal(finals(go([...aInC, ...bRunning, finalStart(C), finalGated(C)])), 0); // this head has its verdict
  assert.equal(finals(go([...aInC, ...bRunning, finalStart(C)], { gates: { [FINAL]: { running: true, result: null } } })), 0);
  // the final gate runs on its own slot: unit gates keep all gateConcurrency slots
  const bGating = [...aInC, ...through('b', D).slice(0, 2)];
  assert.deepEqual(go(bGating).actions.map((a) => a.type), ['gate-start', 'final-gate']);
  const busy = go([...aInC, finalStart(C), ...through('b', D).slice(0, 2)], { gates: { [FINAL]: { running: true, result: null } } });
  assert.deepEqual(busy.actions.map((a) => a.type), ['gate-start']);
  assert.deepEqual(go(bGating, { config: {} }).actions.map((a) => a.type), ['gate-start']); // other modes: as before
  assert.equal(go([...aInC, ...bRunning]).report.done, false);
});

test('a final run on an old head is recorded for that head after the head moved, and is never restarted while it runs', () => {
  const moved = [...aInC, finalStart(C), ...through('b', D)];
  const running = go(moved, { gates: { [FINAL]: { running: true, result: null } } });
  assert.deepEqual([running.events, finals(running)], [[], 0]);
  const r = go(moved, { gates: { [FINAL]: result(C) } });
  assert.deepEqual(r.events.map((e) => [e.type, e.head, e.verdict, e.checks]), [['final-gated', C, 'pass', 'npm test']]);
  assert.equal(finals(r), 1); // the new head gets its own run
  assert.equal(r.report.done, false);
  const s = reduce([started, ...moved, ...r.events]);
  assert.deepEqual([s.plan.green, s.plan.final.head, s.plan.integrationHead], [C, C, D]);
  // the run on the current head finishing completes the plan
  const done = go([...moved, ...r.events, finalStart(D)], { gates: { [FINAL]: result(D) } });
  assert.deepEqual(done.events.map((e) => e.head), [D]);
  assert.equal(done.report.done, true);
});

test('per-head counting: a lost run on an old head and one on the new head do not add up to "could not complete"', () => {
  const lost = { [FINAL]: { running: false, result: null } };
  const oneEach = go([...aInC, finalStart(C), ...through('b', D), finalStart(D)], { gates: lost });
  assert.deepEqual([oneEach.report.judgment, finals(oneEach)], [[], 1]);
  const twice = go([...aInC, ...through('b', D), finalStart(D), finalStart(D)], { gates: lost });
  assert.deepEqual([twice.report.judgment, finals(twice)], [[{ unit: FINAL, reason: 'final gate could not complete' }], 0]);
  const lostOld = go([...aInC, finalStart(C), finalStart(C), ...through('b', D)], { gates: lost });
  assert.deepEqual([lostOld.report.judgment, finals(lostOld)], [[], 1]); // the old head is behind: run the new one
  const setup = { running: false, result: { ...result(C).result, verdict: 'fail', setupFailed: true, failures: ['setup failed (exit 1)'] } };
  const broke = go([...aInC, ...bRunning, finalStart(C)], { gates: { [FINAL]: setup } });
  assert.deepEqual([broke.events, broke.report.judgment, finals(broke)], [[], [{ unit: FINAL, reason: 'setup failed (exit 1)' }], 0]);
});

// decide: wait's summary line
const report = {
  done: false, judgment: [], newlyBlocked: [], unroutable: [], noSlots: false, slotWaiting: [], stalled: [],
};
const integrations = [{ unit: 'a', head: C }, { unit: 'b', head: D }];
const st = (units, p) => ({
  plan: {
    integrationHead: D, baseSha: A, final: null, integrations, greenVerdict: 'pass', ...p,
  },
  units,
});
const two = { units: [{ id: 'a' }, { id: 'b' }] };
const bothIn = { a: { state: 'integrated' }, b: { state: 'integrated' } };
const aIn = { a: { state: 'integrated' }, b: { state: 'running' } };
const say = (s, over = {}, continuous = true, stale = null) => decide({
  plan: two, report: { ...report, ...over }, state: s, launched: 0, continuous, stale,
});

test('decide in continuous: ship-ready when a passed head is not shipped, after judgment lines', () => {
  const ready = st(aIn, { green: C, final: { verdict: 'pass', failures: [], head: C }, integrations: integrations.slice(0, 1) });
  const run = 'run "orq ship --title <conventional title> --body-file <summary file>"';
  assert.deepEqual(say(ready), [`ship-ready: ${C.slice(0, 12)} passed the final checks; 1 units not shipped yet; ${run}`]);
  const withShip = st(bothIn, { green: D, shipped: C, final: { verdict: 'pass', failures: [], head: D } });
  assert.deepEqual(say(withShip, { done: true }), [`ship-ready: ${D.slice(0, 12)} passed the final checks; 1 units not shipped yet; ${run}`]);
  assert.deepEqual(say(st({ a: { state: 'failed', reason: 'x' }, b: { state: 'integrated' } }, { green: C })), ['judgment: a: x']);
  assert.equal(say(st(aIn, { green: C, shipped: C })), null); // shipped: b still runs
  assert.equal(say(ready, {}, false), null); // other modes never print it
  const behind = { base: 'main', synced: false, files: [] };
  assert.equal(say(ready, {}, true, behind), null); // origin's base moved past it: `orq ship` would refuse; units still run, keep polling
  // nothing left in flight: say what unblocks it, never `done` for a head that did not ship
  const fix = 'append a unit with job "fix" that merges origin/main into the integration branch';
  assert.deepEqual(say(withShip, { done: true }, true, behind), [`ship-blocked: ${D.slice(0, 12)} passed the final checks, but origin/main moved past it; ${fix}`]);
  const conflicts = { ...behind, files: ['a.txt', 'b/c.ts'] }; // orq tried to merge it
  assert.deepEqual(say(withShip, { done: true }, true, conflicts), [`ship-blocked: ${D.slice(0, 12)} passed the final checks, but origin/main moved past it and merging it conflicts in a.txt, b/c.ts; ${fix}`]);
  // orq merged origin's base into the integration branch: neither line, the final checks run on the merged head
  const merged = st(bothIn, {
    green: D, shipped: C, final: { verdict: 'pass', failures: [], head: D }, integrationHead: E,
  });
  assert.equal(say(merged, {}, true, { ...behind, synced: true }), null);
  assert.equal(say(ready, {}, true, { ...behind, synced: true }), null);
  assert.equal(say({ ...ready, plan: { ...ready.plan, greenVerdict: 'no-evidence' } }), null); // proved nothing: not ready
  // the merge unit landed and the newer head fails: the failure is the line, not another merge
  const mergedFails = st(bothIn, { green: C, final: { verdict: 'fail', failures: ['boom'], head: D } });
  assert.deepEqual(say(mergedFails, { done: true }, true, behind), [`final-fail: 2 units integrated at ${D.slice(0, 12)}; boom`]);
});

test('ledger: orq merging origin\'s base moves the head like an integration with no unit; a conflict is kept per base sha', () => {
  let s = reduce([started, ...aInC, finalStart(C), finalGated(C)]);
  s = apply(s, { type: 'sync-conflicted', unit: null, at: 9, base: E, files: ['a.txt'] });
  assert.deepEqual(s.plan.syncConflict, { base: E, files: ['a.txt'], at: 9 });
  assert.equal(s.plan.integrationHead, C);
  s = apply(s, {
    type: 'synced', unit: null, at: 10, from: C, to: D, base: B,
  });
  assert.deepEqual([s.plan.integrationHead, s.plan.finalGateStarts, s.plan.syncConflict], [D, 0, null]);
  assert.deepEqual(s.plan.synced, {
    from: C, to: D, base: B, at: 10,
  });
  assert.deepEqual(s.plan.integrations, [{ unit: 'a', head: C }, { unit: null, head: D }]);
  assert.equal(newerThanShipped({ ...s.plan, shipped: C }, D), true); // a merged head ships
  assert.equal(go([...aInC, finalStart(C), finalGated(C), { type: 'synced', unit: null, at: 10, from: C, to: D, base: B }, ...bRunning]).actions.filter((a) => a.type === 'final-gate').length, 1);
});

test('decide in continuous: an early final-fail once per failing head while units are open', () => {
  const failing = st(aIn, { final: { verdict: 'fail', failures: ['boom'], head: C } });
  assert.deepEqual(say(failing), [`final-fail: ${C.slice(0, 12)} fails the final checks while units are still open; boom; details in .orq/units/integration/head-${C.slice(0, 12)}.json`]);
  assert.equal(say({ ...failing, plan: { ...failing.plan, noted: C } }), null); // already reported: b runs on
  assert.equal(say(failing, {}, false), null);
});

test('decide in continuous: done only when every unit is in and the head is shipped', () => {
  const passed = { verdict: 'pass', failures: [], head: D };
  assert.deepEqual(say(st(bothIn, { green: D, shipped: D, final: passed }), { done: true }), [`done: 2 units integrated at ${D.slice(0, 12)}; final checks pass`]);
  const failedLast = st(bothIn, { green: C, shipped: C, final: { verdict: 'fail', failures: ['boom'], head: D } });
  assert.deepEqual(say(failedLast, { done: true }), [`final-fail: 2 units integrated at ${D.slice(0, 12)}; boom`]);
  const none = st({ a: { state: 'dropped' }, b: { state: 'dropped' } }, { integrationHead: A });
  assert.match(say(none, { done: true })[0], /^done: 0 units integrated/);
  // other modes: done as before, shipped or not
  assert.match(say(st(bothIn, { final: passed }), { done: true }, false)[0], /^done: 2 units/);
});

test('a ship carries the units integrated since the last ship, never a merge of the base', () => {
  const p = { integrations: [{ unit: 'a', head: C }, { unit: 'b', head: D }, { unit: 'c', head: E }], shipped: C, green: E };
  assert.deepEqual(shipUnits(p), ['b', 'c']);
  assert.deepEqual(shipUnits({ ...p, shipped: undefined, green: D }), ['a', 'b']);
  assert.deepEqual(shipUnits({ green: D }), []); // a ledger from before 0.8.0
  const synced = { ...p, integrations: [...p.integrations, { unit: null, head: A }] }; // orq merged origin's base
  assert.deepEqual(shipUnits({ ...synced, green: A }), ['b', 'c']);
  assert.deepEqual(shipUnits({ ...synced, shipped: E, green: A }), []); // only a merge since the last ship
  assert.deepEqual(shipUnits(synced, E), ['b', 'c']); // up to any head
});

const titled = (pairs) => ({ goal: 'g', units: pairs.map(([id, title]) => ({ ...unit(id), title })) });

test('the default ship title is the work, never plan, ship or unit ids', () => {
  const one = titled([['issue-843', '#843 Bound model parsing']]);
  assert.equal(shipTitle(one, ['issue-843']), 'Bound model parsing');
  const many = titled([['issue-843', '#843 #850: restore export checks'], ['issue-858', '#858 b'], ['x', 'c']]);
  assert.equal(shipTitle(many, ['issue-843', 'issue-858', 'x']), 'restore export checks and 2 more');
  assert.equal(shipTitle(titled([['issue-1', 'issue-1: fix the shop']]), ['issue-1']), 'fix the shop');
  const long = shipTitle(titled([['a', `#1 ${'x'.repeat(80)}`], ['b', 'b']]), ['a', 'b']);
  assert.equal(long.length, 72);
  assert.match(long, /^x+… and 1 more$/);
  assert.equal(shipTitle({ goal: 'Ship the export', units: [] }, []), 'Ship the export'); // a ledger from before 0.8.0
  assert.equal(shipTitle(null, []), 'Ship integrated work');
});

test('the ship body: the orchestrator summary, Closes for an issue whose units are all in, Refs otherwise, then the checks line', () => {
  const plan = titled([['a', '#843 add a'], ['b', '#850, #851 and #852 add b'], ['c', '#843: more a, see #99'], ['d', 'no issue, fixes #7'], ['e', '#860 part one'], ['f', '#860 part two']]);
  const all = new Set(['a', 'b', 'c', 'd', 'e']); // f is not integrated yet
  assert.equal(shipBody(plan, ['a', 'b', 'c', 'd', 'e'], E, 'Users can now export.\n', all), `Users can now export.\n\nCloses #843\nCloses #850\nCloses #851\nCloses #852\nRefs #860\n\nFinal checks passed on ${E.slice(0, 12)}.`);
  assert.equal(shipBody(plan, ['d'], E), `Final checks passed on ${E.slice(0, 12)}.`); // only leading refs count
  assert.equal(shipBody(plan, ['a'], E, ' '), `Refs #843\n\nFinal checks passed on ${E.slice(0, 12)}.`); // c, also #843, not in
  assert.deepEqual(issuesOf('#12, #14 and #15: add x'), ['12', '14', '15']);
  assert.deepEqual(issuesOf('Fix #12 crash'), []);
});

test('ship text: a one-line title of at most 72 characters, and no tool or model credited anywhere', () => {
  assert.equal(shipTextError({ title: 'fix(shop): bound model parsing and restore export checks', body: 'Users can now export.' }), null);
  assert.equal(shipTextError({}), null);
  assert.equal(shipTextError({ title: ` ${'x'.repeat(72)} ` }), null); // trimmed first
  for (const title of ['', '  ', 'x'.repeat(73), 'feat: a\nb']) assert.equal(shipTextError({ title }), 'ship: --title must be one line of 1 to 72 characters; nothing was shipped');
  // naming a product is fine: only credit for writing the change is refused
  for (const title of ['Update CLAUDE.md routing notes', 'Add Gemini provider', 'Add Opus codec support', 'Implement minimax search', 'build: bump gpt-tokenizer',
    'fix: list jobs reviewed with cursor pagination', 'docs: notes written by AI team members']) {
    assert.equal(shipTextError({ title }), null, title);
  }
  assert.equal(shipTextError({ title: 'fix: a', body: 'Admins act on behalf of the user.\nCo-Authored-By: Ana Lima <ana@example.com>' }), null);
  assert.equal(shipTextError({ title: 'feat: add a 🤖' }), 'ship: --title credits a tool or model ("🤖"); write it as the maintainer; nothing was shipped');
  const credits = ['🤖 Generated with [Claude Code](https://claude.com/claude-code)', 'generated by ChatGPT', 'x\nCo-Authored-By: Claude <noreply@anthropic.com>', 'Co-authored-by: bot <x@openai.com>',
    'Co-authored-by: GPT-5 <x@y.z>', 'Written by Claude.', 'Reviewed with Gemini 2.5', 'Orchestrated by an AI agent', 'Kimi responding on behalf of the team',
    'x\nAssisted-by: Claude', 'Built using Claude Code', 'made with claude code'];
  for (const body of credits) {
    assert.match(shipTextError({ title: 'fix: a', body }) ?? '', /^ship: --body-file credits a tool or model \(".+"\); write it as the maintainer; nothing was shipped$/, body);
  }
});

test('a shipped head must come later in the integration order than the one shipped before', () => {
  const p = { integrations: [{ unit: 'a', head: C }, { unit: 'b', head: D }] };
  assert.equal(newerThanShipped(p, C), true);
  assert.equal(newerThanShipped({ ...p, shipped: C }, D), true);
  assert.equal(newerThanShipped({ ...p, shipped: D }, C), false);
  assert.equal(newerThanShipped({ ...p, shipped: C }, E), false); // not an integration head at all
});
