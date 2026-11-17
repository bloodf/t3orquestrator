// Thread titles: `<Type> - <Ticket> | <Name>` for every thread orq starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askTitle, reviewTitle, unitTitle } from '../lib/thread-title.mjs';

test('unitTitle: type from the job, ticket from leading issue refs or the unit id, name without the refs', () => {
  assert.equal(unitTitle({ id: 'i843', job: 'implement', title: '#843 Bound model parsing' }), 'Implement - #843 | Bound model parsing');
  assert.equal(unitTitle({ id: 'x', job: 'fix', title: '#843, #850 and #851: restore export checks' }), 'Fix - #843, #850, #851 | restore export checks');
  assert.equal(unitTitle({ id: 'i9', job: 'implement-complex', title: 'Add the export, see #12' }), 'Implement - i9 | Add the export, see #12');
  const types = {
    test: 'Test', docs: 'Docs', mechanical: 'Chore', explore: 'Explore', summarize: 'Summary', plan: 'Plan', architecture: 'Plan', 'debug-hard': 'Debug', review: 'Review', decide: 'Decision', triage: 'Triage',
  };
  for (const [job, type] of Object.entries(types)) assert.equal(unitTitle({ id: 'u', job, title: 'x' }), `${type} - u | x`);
  assert.equal(unitTitle({ id: 'u', job: 'fix', title: '#7 - ' }), 'Fix - #7 | u'); // nothing left: the id names it
  const long = unitTitle({ id: 'u', job: 'docs', title: `#1 ${'word '.repeat(40)}` });
  assert.ok(long.length <= 100, long);
  assert.match(long, /^Docs - #1 \| (word )*word…$/); // cut on a word boundary
});

test('reviewTitle and askTitle', () => {
  const plan = { goal: 'Export the catalogue\nmore', units: [{ id: 'a', title: '#12 add a' }, { id: 'b', title: '#14, #12 add b' }, { id: 'c', title: '#99 c' }] };
  const state = { plan: { planId: 'p1' }, units: { a: { state: 'integrated' }, b: { state: 'integrated' }, c: { state: 'running' } } };
  assert.equal(reviewTitle(2, plan, state), 'Review - #12, #14 | Export the catalogue');
  assert.equal(reviewTitle(3, { units: [{ id: 'a', title: 'a' }] }, { plan: { planId: 'p1' }, units: { a: { state: 'integrated' } } }), 'Review - p1 | Integration review 3');
  assert.equal(askTitle(4, 'Which port should the server use?\nThe order says 8080.'), 'Decision - ask-4 | Which port should the server use?');
  assert.ok(askTitle(1, 'why '.repeat(50)).length <= 100);
});
