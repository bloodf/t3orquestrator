import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShape, shapeLines } from '../lib/plan-shape.mjs';

const u = (id, deps = []) => ({ id, deps });

test('planShape: how many of the units still to run can start now, and the longest chain', () => {
  assert.deepEqual(planShape([u('a'), u('b'), u('c')], []), { remaining: 3, ready: 3, chain: 1 });
  assert.deepEqual(planShape([u('a'), u('b', ['a']), u('c', ['b'])], []), { remaining: 3, ready: 1, chain: 3 });
  assert.deepEqual(planShape([u('a'), u('b', ['a']), u('c', ['a']), u('d', ['b', 'c'])], []), { remaining: 4, ready: 1, chain: 3 });
  // finished units no longer hold anything back
  assert.deepEqual(planShape([u('a'), u('b', ['a']), u('c', ['a'])], ['a']), { remaining: 2, ready: 2, chain: 1 });
  assert.deepEqual(planShape([u('a')], ['a']), { remaining: 0, ready: 0, chain: 0 });
  assert.deepEqual(planShape([{ id: 'a' }, u('b', ['zz'])], []), { remaining: 2, ready: 2, chain: 1 }); // unknown dep: validation's job
});

test('shapeLines: silent for small plans, a warning when everything left is one chain', () => {
  assert.deepEqual(shapeLines({ remaining: 2, ready: 1, chain: 2 }), []);
  assert.deepEqual(shapeLines({ remaining: 5, ready: 3, chain: 2 }), ['shape: 5 units to run, 3 can start now, longest chain 2']);
  assert.deepEqual(shapeLines({ remaining: 4, ready: 1, chain: 4 }), [
    'warning: the 4 units still to run form one chain, so they run one at a time; keep a dep only where a unit needs what another commits',
  ]);
});

test('shapeLines: one ready unit is not a chain when units fan out behind it', () => {
  assert.deepEqual(shapeLines({ remaining: 4, ready: 1, chain: 3 }), ['shape: 4 units to run, 1 can start now, longest chain 3']);
});
