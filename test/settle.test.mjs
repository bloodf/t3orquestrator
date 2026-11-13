import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleList, settleLine } from '../lib/settle.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let clock = 0;
const ev = (type, unit, extra = {}) => ({ type, unit, at: (clock += 1), ...extra });
const launched = (unit, threadId, over = {}) => ev('launched', unit, {
  attempt: 1, threadId, key: 'i::m', instance: 'i', model: 'm', branch: `orq/p/${unit}-${threadId}`, baseSha: A, tier: 2, ...over,
});
const started = ev('plan-started', null, { planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration' });
const ended = (unit, status = 'completed') => ev('thread-ended', unit, { status });
const pass = (unit) => [ended(unit), ev('gate-started', unit, { attempt: 1, headSha: B, pid: 1 }),
  ev('gated', unit, { attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: B })];
const row = (status = 'completed', settled = false) => ({ status, settled });

test('settleList: finished orq threads that T3 reports unsettled, and nothing else', () => {
  const events = [started,
    launched('a', 'ta'), ...pass('a'), ev('integrated', 'a', { head: B }), // integrated: its thread
    launched('b', 'tb1'), ended('b', 'failed'), launched('b', 'tb2'), // tb1 replaced; tb2 is the current one of a running unit
    launched('c', 'tc'), ev('dropped', 'c'), // dropped
    launched('d', 'td'), ev('blocked', 'd'), // blocked: its current thread is never listed
    launched('e', 'te1'), ended('e', 'stalled'), launched('e', 'te2'), // te1 given up but T3 still shows it running
    launched('f', 'tf'), ev('needs-judgment', 'f', { reason: 'x' }), // failed: the orchestrator still reads it
    launched('g', 'tg1'), ended('g', 'failed'), // failed thread, unit queued, not relaunched yet: current, kept
  ];
  const threads = {
    ta: row(), tb1: row('failed'), tb2: row('running'), tc: row('interrupted'), td: row('running'), te1: row('running'), tf: row(), tg1: row('failed'),
    rv1: row(), rv2: row('running'), q1: row(), q2: row(), other: row(),
  };
  const reviews = { reviews: [{ n: 1, threadId: 'rv1', status: 'failed' }, { n: 2, threadId: 'rv2', status: 'running' }] };
  const asks = { asks: [{ n: 1, threadId: 'q1', status: 'answered' }, { n: 2, threadId: 'q2', status: 'running' }, { n: 3, threadId: null, status: 'failed' }] };
  assert.deepEqual(settleList({ events, reviews, asks, threads }), [
    { threadId: 'ta', what: 'unit a integrated' },
    // tb1 was replaced, but b still runs: its worker may still read tb1's worktree, so it is not listed yet
    { threadId: 'tc', what: 'unit c dropped' },
    { threadId: 'rv1', what: 'review 1' },
    { threadId: 'q1', what: 'decision 1' },
  ]);
  // settled or unknown never; once the given-up thread stops, it is listed
  const later = { ...threads, ta: row('completed', true), tc: row('interrupted', null), te1: row('failed') };
  assert.deepEqual(settleList({ events, reviews, asks, threads: later }).map((x) => x.threadId), ['rv1', 'q1']);
  // once b is integrated its replaced thread and its last one are listed
  const bDone = [...events, ...pass('b'), ev('integrated', 'b', { head: B })];
  assert.deepEqual(settleList({ events: bDone, reviews, asks, threads: { ...threads, tb2: row() } }).slice(1, 3),
    [{ threadId: 'tb1', what: 'unit b replaced' }, { threadId: 'tb2', what: 'unit b integrated' }]);
  // a thread T3 does not list is never named
  assert.deepEqual(settleList({ events, reviews, asks, threads: {} }), []);
});

test('settleLine: at most 20 ids, then +<n> more; nothing when empty', () => {
  assert.equal(settleLine([]), null);
  assert.equal(settleLine([{ threadId: 'x' }, { threadId: 'y' }]), 'settle: x y');
  const many = Array.from({ length: 23 }, (_, i) => ({ threadId: `t${i}` }));
  assert.equal(settleLine(many), `settle: ${many.slice(0, 20).map((x) => x.threadId).join(' ')} +3 more`);
});
