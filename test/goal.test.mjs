import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGoal, goalLines, NEXT } from '../lib/goal.mjs';

test('goalLines: nothing without a goal; otherwise goal: and, for the commands that stop, next:', () => {
  for (const kind of ['wait', 'archive', 'noPlan', 'status']) assert.deepEqual(goalLines(undefined, kind), []);
  assert.deepEqual(goalLines('ship it', 'status'), ['goal: ship it']);
  assert.deepEqual(goalLines('ship it', 'wait'), ['goal: ship it', `next: ${NEXT.wait}`]);
  assert.deepEqual(goalLines('ship it', 'archive'), ['goal: ship it', `next: ${NEXT.archive}`]);
  assert.deepEqual(goalLines('ship it', 'noPlan'), ['goal: ship it', `next: ${NEXT.noPlan}`]);
});

test('the next: wording is fixed', () => {
  assert.equal(NEXT.wait, 'the goal is still open: finish this plan as the playbook says, run "orq plan archive", then plan the next part and call "orq wait" again in this same turn');
  assert.equal(NEXT.archive, 'the goal is still open: plan its next part now and call "orq wait"; run "orq config set goal null" only when nothing of it is left to build');
  assert.equal(NEXT.noPlan, 'the goal is still open: plan its next part, run "orq plan check", then call "orq wait"');
});

test('cleanGoal: control, C1, zero-width and bidi characters go; ordinary text is kept', () => {
  assert.equal(cleanGoal('a\u0085b\u200bc\u202ed\u2066e\u009ff\u0007g  h'), 'a b c d e f g h');
  assert.equal(cleanGoal('Prazo: 5 días, ça va – ok'), 'Prazo: 5 días, ça va – ok');
});
