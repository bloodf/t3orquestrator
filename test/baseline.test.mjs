// Baseline-aware unit gate: failures the integration head already had are not the unit's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureLines, checksOutput, excuse } from '../lib/baseline.mjs';

const BASE = 'b'.repeat(40);
const RED = '\x1b[0m\x1b[31m';
const OFF = '\x1b[0m';

// the last 15 lines of a real bun run on a red integration head
const BUN_BASE = [
  `${RED}(fail)${OFF} legacy-low-spool-migration: migrates thresholds below 50 g [372.48ms]`,
  `${RED}(fail)${OFF} legacy-low-spool-migration: keeps custom thresholds [12.01ms]`,
  '(fail) legacy-low-spool-migration: drops the old column [1.20ms]',
  '(fail) merged-schema: has the spool table [3.20ms]',
  '(fail) merged-schema: has the printer table',
  '(fail) merged-schema: has the job table [0.88ms]',
  '',
  ' 412 pass',
  ' 6 fail',
  ' 2 snapshots, 1201 expect() calls',
  'Ran 418 tests across 61 files. [41.23s]',
].join('\n');

// the same failures in a unit run: other durations, no colour
const BUN_UNIT = [
  'src/spools.test.ts:',
  '(pass) spools: lists spools [2.00ms]',
  '(fail) legacy-low-spool-migration: migrates thresholds below 50 g [401.10ms]',
  '(fail) merged-schema: has the spool table [2.90ms]',
  ' 410 pass',
  ' 2 fail',
].join('\n');

const NODE_SPEC = [
  '✔ ledger: replays events (1.2ms)',
  '✖ ledger: rebuilds state (3.1ms)',
  '✖ failing tests:',
  '',
  'test at test/ledger.test.mjs:12:1',
  '✖ ledger: rebuilds state (3.1ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  'ℹ tests 799',
  'ℹ fail 1',
].join('\n');

test('failureLines: one normalised line per failing test, across common runners', () => {
  assert.deepEqual([...failureLines(BUN_BASE)], [
    '(fail) legacy-low-spool-migration: migrates thresholds below 50 g',
    '(fail) legacy-low-spool-migration: keeps custom thresholds',
    '(fail) legacy-low-spool-migration: drops the old column',
    '(fail) merged-schema: has the spool table',
    '(fail) merged-schema: has the printer table',
    '(fail) merged-schema: has the job table',
  ]);
  assert.deepEqual([...failureLines(NODE_SPEC)], ['✖ ledger: rebuilds state']); // not the "failing tests:" header
  assert.deepEqual([...failureLines('ok 1 - a\nnot ok 2 - ledger: rebuilds state\n  ---\nnot ok 7 - b # TODO')], ['not ok - ledger: rebuilds state', 'not ok - b # TODO']);
  assert.deepEqual([...failureLines(' FAIL  src/a.test.ts\n  ✕ adds (5 ms)\n   × src/b.test.ts > sums 12ms\n ✓ ok')], ['FAIL src/a.test.ts', '✕ adds', '× src/b.test.ts > sums']);
  assert.deepEqual([...failureLines('FAILED tests/test_db.py::test_migrate - AssertionError: 1 != 2\n1 failed, 3 passed')], ['FAILED tests/test_db.py::test_migrate']);
  assert.deepEqual([...failureLines("src/a.ts(12,5): error TS2322: Type 'x' is not assignable.\nsrc/b.ts:3:1 - error TS2304: Cannot find name 'y'.  \nFound 2 errors.")], [
    "src/a.ts(12,5): error TS2322: Type 'x' is not assignable.",
    "src/b.ts:3:1 - error TS2304: Cannot find name 'y'.",
  ]);
  assert.equal(failureLines('Error: something broke\nexit 1').size, 0); // unknown format: nothing
});

test('checksOutput: only the checks steps of a gate log, retry included', () => {
  const log = '== setup\n(fail) from setup\n== evidence\nok\n== checks\n(fail) a\n== checks (retry)\n(fail) b\n';
  assert.deepEqual([...failureLines(checksOutput(log))], ['(fail) a', '(fail) b']);
  assert.equal(checksOutput('== setup\nx\n'), '');
});

const failed = (over = {}) => ({
  verdict: 'fail', failures: ['checks failed (exit 1)'], flags: [], headSha: 'c'.repeat(40),
  steps: [{ name: 'checks', code: 1, durationMs: 1, tail: '' }], ...over,
});
const baseResult = (tail = BUN_BASE, over = {}) => ({
  verdict: 'fail', failures: ['checks failed (exit 1)'], flags: [], headSha: BASE, steps: [{ name: 'checks', code: 1, durationMs: 1, tail }], ...over,
});
const unitLog = (text) => `== checks\n${text}\n== checks (retry)\n${text}\n`;

test('excuse: a unit that fails only what its red base fails passes, flagged pre-existing-failures', () => {
  const r = excuse(failed(), unitLog(BUN_UNIT), { sha: BASE, result: baseResult(), log: null });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.failures, []);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].kind, 'pre-existing-failures');
  assert.equal(r.flags[0].detail, `2 failing tests also fail on the integration head ${BASE.slice(0, 12)}: (fail) legacy-low-spool-migration: migrates thresholds below 50 g; (fail) merged-schema: has the spool table`);
  // the base's whole log, when kept, counts as well as its tail
  const late = '(fail) zz-last: only in the log';
  const more = excuse(failed(), unitLog(`${BUN_UNIT}\n${late}\n(fail) merged-schema: has the job table`), { sha: BASE, result: baseResult(), log: `== checks\n${late}\n${BUN_BASE}\n` });
  assert.equal(more.verdict, 'pass');
  assert.match(more.flags[0].detail, /^4 failing tests .*; \+1 more$/);
});

test('excuse: anything else stays a failure, exactly as the gate said', () => {
  const base = { sha: BASE, result: baseResult(), log: null };
  const unit = failed();
  const same = (r) => assert.equal(r, unit);
  same(excuse(unit, unitLog(`${BUN_UNIT}\n(fail) spools: new failure [1ms]`), base)); // one failure of its own
  same(excuse(unit, unitLog(BUN_UNIT), null)); // no final result for its base
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: baseResult(BUN_BASE, { verdict: 'pass', failures: [] }), log: null })); // the base was green
  same(excuse(unit, unitLog('Error: boom'), base)); // unknown format: nothing matched in the unit
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: baseResult('Error: boom'), log: null })); // nor in the base
  same(excuse(unit, null, base)); // the unit's output was not kept
  same(excuse(unit, `${unitLog(BUN_UNIT)}\n== log truncated\n`, base)); // nor kept whole
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: { ...baseResult(), headSha: 'd'.repeat(40) }, log: null })); // another head's result
  for (const f of [['evidence failed (exit 1)'], ['checks timed out'], ['checks failed (exit 1)', 'forbidden paths: x']]) {
    const other = failed({ failures: f });
    assert.equal(excuse(other, unitLog(BUN_UNIT), base), other);
  }
  // a base tail cut short excuses only the lines it shows
  const cut = baseResult(BUN_BASE.split('\n').slice(3).join('\n'));
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: cut, log: null }));
});

test('excuse: never changes its inputs', () => {
  const unit = failed();
  const before = JSON.stringify(unit);
  excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: baseResult(), log: null });
  assert.equal(JSON.stringify(unit), before);
});
