import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNotes } from '../lib/commands/wait-report.mjs';

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
