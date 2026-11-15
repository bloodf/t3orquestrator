import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNotes, evidenceNote, timeoutLines } from '../lib/commands/wait-report.mjs';

const notes = (n) => Array.from({ length: n }, (_, i) => `note: n${i}`);

test('notes sit after the summary line and never push decision lines out', () => {
  assert.deepEqual(withNotes(['judgment: a: x', 'b: y'], notes(2)), ['judgment: a: x', 'note: n0', 'note: n1', 'b: y']);
  const out = ['judgment: a: x', 'b: y', 'c: z', 'd: w'];
  assert.deepEqual(withNotes(out, notes(6)), ['judgment: a: x', 'note: n0', 'note: n1', 'note: 4 more notes omitted', 'b: y', 'c: z', 'd: w']);
  const many = ['judgment: a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.deepEqual(withNotes(many, notes(1)), ['judgment: a', 'note: 1 more notes omitted', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(withNotes(['idle: x'], []), ['idle: x']);
});

test('a settle line sits after the summary, is not a note, and never pushes a decision line out', () => {
  const out = ['judgment: a: x', 'settle: t1 t2', 'b: y', 'c: z', 'd: w', 'e: v', 'f: u'];
  assert.deepEqual(withNotes(out, notes(3), 7, 2), ['judgment: a: x', 'settle: t1 t2', 'note: 3 more notes omitted', 'b: y', 'c: z', 'd: w', 'e: v', 'f: u']);
  assert.deepEqual(withNotes(['done: x', 'settle: t1'], notes(2), 7, 2), ['done: x', 'settle: t1', 'note: n0', 'note: n1']);
});

test('evidenceNote: one note for every unit whose evidence runs outside the repository, naming up to 3', () => {
  const w = (id) => `${id}: evidence runs a file outside the repository (/x/${id}.py); a check belongs in the repository, written by a unit`;
  assert.equal(evidenceNote([]), null);
  assert.equal(evidenceNote([w('a')]), 'note: 1 units run evidence outside the repository (a); run "orq plan check" for the list');
  assert.equal(evidenceNote(['a', 'b', 'c'].map(w)), 'note: 3 units run evidence outside the repository (a, b, c); run "orq plan check" for the list');
  assert.equal(evidenceNote(['a', 'b', 'c', 'd', 'e'].map(w)), 'note: 5 units run evidence outside the repository (a, b, c +2 more); run "orq plan check" for the list');
});

test('timeoutLines: the waiting line names the limit in force', () => {
  const plan = { units: [{ id: 'a' }] };
  const state = { plan: {}, units: {} };
  const report = { noSlots: true, slotWaiting: ['a'], stalled: [] };
  assert.equal(timeoutLines(plan, state, report, 4)[1], 'waiting: 1 ready units wait for a free slot (machine cap 4, or a provider instance limit)');
  assert.equal(timeoutLines(plan, state, { ...report, capBy: 'project' }, 4, 2)[1], 'waiting: 1 ready units wait for a free slot (project cap 2 of this project, machine cap 4, or a provider instance limit)');
});

test('timeoutLines: a ship line when most units are integrated and none was for 30 minutes', () => {
  const MIN = 60000;
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const plan = { units: ids.map((id) => ({ id })) };
  const units = Object.fromEntries(ids.map((id) => [id, { state: 'integrated' }]));
  const report = { noSlots: false, slotWaiting: [], stalled: [] };
  const at = (u, lastIntegratedAt) => ({ plan: { lastIntegratedAt }, units: { ...units, ...u } });
  const tail = { g: { state: 'running' }, h: { state: 'queued' } };
  const ship = 'ship: 6 of 8 units integrated, none for 45 min; still open: g, h. Drop them to the next plan ("orq unit drop <id>") so the final checks run and the pull request ships now';
  assert.equal(timeoutLines(plan, at(tail, 0), report, 4, undefined, 45 * MIN).at(-1), ship);
  assert.notEqual(timeoutLines(plan, at(tail, 0), report, 4, undefined, 29 * MIN).at(-1).slice(0, 5), 'ship:'); // too soon
  const half = { ...tail, e: { state: 'running' }, f: { state: 'running' } };
  assert.notEqual(timeoutLines(plan, at(half, 0), report, 4, undefined, 45 * MIN).at(-1).slice(0, 5), 'ship:'); // under 75%
  const dropped = { g: { state: 'running' }, h: { state: 'dropped' } }; // a dropped unit is neither done nor open
  assert.match(timeoutLines(plan, at(dropped, 0), report, 4, undefined, 45 * MIN).at(-1), /^ship: 6 of 7 units integrated, none for 45 min; still open: g\. /);
  assert.notEqual(timeoutLines(plan, at(tail, undefined), report, 4, undefined, 45 * MIN).at(-1).slice(0, 5), 'ship:'); // older ledger
  const gating = { g: { state: 'gating' }, h: { state: 'queued' } };
  assert.notEqual(timeoutLines(plan, at(gating, 0), report, 4, undefined, 45 * MIN).at(-1).slice(0, 5), 'ship:'); // may land in minutes
  const small = { units: ['a', 'b', 'c', 'd'].map((id) => ({ id })) };
  const smallState = { plan: { lastIntegratedAt: 0 }, units: { a: { state: 'integrated' }, b: { state: 'integrated' }, c: { state: 'integrated' }, d: { state: 'running' } } };
  assert.notEqual(timeoutLines(small, smallState, report, 4, undefined, 45 * MIN).at(-1).slice(0, 5), 'ship:'); // a small plan waits
});
