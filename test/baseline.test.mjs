// Baseline-aware unit gate: failures the integration head already had are not the unit's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as baseline from '../lib/baseline.mjs';
import {
  baselineOf, failureLines, checksOutput, excuse,
} from '../lib/baseline.mjs';

const BASE = 'b'.repeat(40);
const RED = '\x1b[0m\x1b[31m';
const OFF = '\x1b[0m';

// a bun run on a red integration head (the final gate's kept log), as bun prints it to a pipe
const bunRun = ({ ms = 372.48, keeps = true, extra = [], fails = 3 } = {}) => [
  'bun test v1.2.0',
  '',
  'test/legacy-low-spool-migration.test.ts:',
  `${RED}(fail)${OFF} legacy-low-spool-migration: migrates thresholds below 50 g [${ms}ms]`,
  'error: expect(received).toBe(expected)',
  `      at <anonymous> (/work/repo/.orq/gate/${ms === 372.48 ? 'integration' : 'a'}/test/legacy-low-spool-migration.test.ts:20:5)`,
  keeps ? '(fail) legacy-low-spool-migration: keeps custom thresholds [12.01ms]' : '(pass) legacy-low-spool-migration: keeps custom thresholds [12.01ms]',
  ...(keeps ? ['error: expect(received).toBe(expected)'] : []),
  '',
  'test/merged-schema.test.ts:',
  '(fail) merged-schema: has the spool table [3.20ms]',
  'error: no such table: spool',
  '(pass) merged-schema: rejects a failing migration [1.00ms]',
  ...extra,
  '',
  `${fails} tests failed:`,
  `(fail) legacy-low-spool-migration: migrates thresholds below 50 g [${ms}ms]`,
  ...(keeps ? ['(fail) legacy-low-spool-migration: keeps custom thresholds [12.01ms]'] : []),
  '(fail) merged-schema: has the spool table [3.20ms]',
  '',
  ' 410 pass',
  ` ${fails} fail`,
  'Ran 413 tests across 3 files. [41.23s]',
].join('\n');
const BUN_BASE = bunRun();
const BUN_UNIT = bunRun({ ms: 401.1, keeps: false, fails: 2 }); // one of them fixed, other durations

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

const JEST = (tests) => [' FAIL  src/math.test.ts (5.2 s)', ...tests.map((t) => `  ● math › ${t}`), '', 'Tests:       2 failed, 9 passed, 11 total'].join('\n');

test('failureLines: one normalised line per failing test, named by its file where the runner prints one', () => {
  assert.deepEqual([...failureLines(BUN_BASE)], [
    'test/legacy-low-spool-migration.test.ts: (fail) legacy-low-spool-migration: migrates thresholds below 50 g',
    'test/legacy-low-spool-migration.test.ts: (fail) legacy-low-spool-migration: keeps custom thresholds',
    'test/merged-schema.test.ts: (fail) merged-schema: has the spool table',
    '(fail) legacy-low-spool-migration: migrates thresholds below 50 g', // bun's closing list names no file
    '(fail) legacy-low-spool-migration: keeps custom thresholds',
    '(fail) merged-schema: has the spool table',
  ]);
  assert.deepEqual([...failureLines(NODE_SPEC)], ['✖ ledger: rebuilds state']); // not the "failing tests:" header
  assert.deepEqual([...failureLines('ok 1 - a\nnot ok 2 - ledger: rebuilds state\n  ---\nnot ok 7 - b # TODO')], ['not ok - ledger: rebuilds state', 'not ok - b # TODO']);
  assert.deepEqual([...failureLines(JEST(['adds', 'subtracts']))], ['src/math.test.ts: ● math › adds', 'src/math.test.ts: ● math › subtracts']); // FAIL <file> alone is no test
  assert.deepEqual([...failureLines(' FAIL  src/b.test.ts > sums\n   × src/b.test.ts > sums 12ms\n ✓ ok')], ['FAIL src/b.test.ts > sums', '× src/b.test.ts > sums']); // vitest
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
const tail = (text) => text.split('\n').slice(-15).join('\n');
const baseResult = (text = BUN_BASE, over = {}) => ({
  verdict: 'fail', failures: ['checks failed (exit 1)'], flags: [], headSha: BASE, steps: [{ name: 'checks', code: 1, durationMs: 1, tail: tail(text) }], ...over,
});
const withLog = (text = BUN_BASE) => ({ sha: BASE, result: baseResult(text), log: `== setup\nok\n== checks\n${text}\n` });
const unitLog = (text) => `== checks\n${text}\n== checks (retry)\n${text}\n`;

test('excuse: a unit that fails only what its red base fails passes, flagged pre-existing-failures', () => {
  const r = excuse(failed(), unitLog(BUN_UNIT), withLog());
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.flags, [{
    kind: 'pre-existing-failures', path: '', detail: `4 failing tests also fail on the integration head ${BASE.slice(0, 12)}: test/legacy-low-spool-migration.test.ts: (fail) legacy-low-spool-migration: migrates thresholds below 50 g; test/merged-schema.test.ts: (fail) merged-schema: has the spool table; (fail) legacy-low-spool-migration: migrates thresholds below 50 g; +1 more; checks after the failing step did not run on this unit`,
  }]);
  // a runner that prints no file names, against the base's result tail alone
  const plain = '(pass) spools: lists spools [2.00ms]\n(fail) merged-schema: has the spool table [2.90ms]\n 411 pass\n 1 fail';
  assert.equal(excuse(failed(), unitLog(plain), { sha: BASE, result: baseResult(), log: null }).verdict, 'pass');
  assert.equal(excuse(failed(), unitLog(JEST(['adds'])), withLog(JEST(['adds', 'divides']))).verdict, 'pass');
});

test('excuse: anything else stays a failure, exactly as the gate said', () => {
  const base = withLog();
  const unit = failed();
  const same = (r, why) => assert.equal(r, unit, why);
  same(excuse(unit, unitLog(bunRun({ ms: 401.1, extra: ['(fail) merged-schema: new failure [1ms]'], fails: 4 })), base), 'one failure of its own');
  same(excuse(unit, unitLog(BUN_UNIT), null), 'no final result for its base');
  same(excuse(unit, unitLog(BUN_UNIT), { ...base, result: baseResult(BUN_BASE, { verdict: 'pass', failures: [] }) }), 'the base was green');
  same(excuse(unit, unitLog('Error: boom'), base), 'unknown format');
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: baseResult('Error: boom'), log: null }), 'nothing matched in the base');
  same(excuse(unit, null, base), 'the unit output was not kept');
  same(excuse(unit, `${unitLog(BUN_UNIT)}\n== log truncated\n`, base), 'nor kept whole');
  same(excuse(unit, unitLog(BUN_UNIT), { ...base, result: { ...baseResult(), headSha: 'd'.repeat(40) } }), 'another head');
  for (const f of [['evidence failed (exit 1)'], ['checks timed out'], ['checks failed (exit 1)', 'forbidden paths: x']]) {
    const other = failed({ failures: f });
    assert.equal(excuse(other, unitLog(BUN_UNIT), base), other);
  }
  // the base's tail alone does not show which file each failure is in, nor its error lines
  same(excuse(unit, unitLog(BUN_UNIT), { sha: BASE, result: baseResult(), log: null }), 'tail only');
  // jest: a new failing test in a file that already fails, or a failing file with no test named
  same(excuse(unit, unitLog(JEST(['adds', 'subtracts'])), withLog(JEST(['adds']))), 'new jest test');
  same(excuse(unit, unitLog(' FAIL  src/math.test.ts\n  Test suite failed to run\nTests: 0 total'), withLog(JEST(['adds']))), 'jest file with no test line');
  // an error no runner pattern knows: a lint or build line not in the base's output
  same(excuse(unit, unitLog(`${BUN_UNIT}\nsrc/x.ts:3:1  error  'y' is unused  no-unused-vars`), base), 'lint error');
  same(excuse(unit, unitLog(`${BUN_UNIT}\nBuild failed with 1 error`), base), 'build error');
  for (const line of ['Jest: "global" coverage threshold for lines (80%) not met: 78%', "src/x.py:1:1: F401 'os' imported but unused",
    '[warn] Code style issues found in 2 files. Run Prettier with --write to fix.', 'TypeError: spool.weight is not a function', '1 problem (1 warning)']) {
    same(excuse(unit, unitLog(`${BUN_UNIT}\n${line}`), base), line);
  }
  // the same test name in another file
  same(excuse(unit, unitLog('test/b.test.ts:\n(fail) x [1ms]\n 1 fail'), withLog('test/a.test.ts:\n(fail) x [1ms]\n 1 fail')), 'other file');
  // more failures than the base had, by the runner's own count
  same(excuse(unit, unitLog('(fail) x [1ms]\n 3 fail'), { sha: BASE, result: baseResult('(fail) x [1ms]\n 2 fail'), log: null }), 'count');
});

test('excuse: never changes its inputs', () => {
  const unit = failed();
  const before = JSON.stringify(unit);
  excuse(unit, unitLog(BUN_UNIT), withLog());
  assert.equal(JSON.stringify(unit), before);
});

test('baselineOf: what a failed final run printed, kept in its result once its log is gone', () => {
  const kept = baselineOf(`== setup\nok\n== checks\n${BUN_BASE}\n`);
  assert.equal(kept.count, 3);
  assert.ok(kept.failures.includes('test/merged-schema.test.ts: (fail) merged-schema: has the spool table'));
  assert.ok(kept.errors.includes('error: no such table: spool'));
  // the head's log was removed after a later head passed: its result still carries what it printed
  const summary = BUN_BASE.split('\n').slice(-8).join('\n'); // bun's closing list: no file names, no error lines
  assert.equal(excuse(failed(), unitLog(BUN_UNIT), { sha: BASE, result: baseResult(summary), log: null }).verdict, 'fail');
  const base = { sha: BASE, result: { ...baseResult(summary), baseline: kept }, log: null };
  assert.equal(excuse(failed(), unitLog(BUN_UNIT), base).verdict, 'pass');
  assert.equal(excuse(failed(), unitLog(BUN_UNIT), { ...base, result: { ...base.result, baseline: { ...kept, errors: [] } } }).verdict, 'fail');
  assert.equal(baselineOf(null), null);
});

test('scan: a node warning reads the same whatever process printed it', () => {
  const { scan } = baseline;
  const a = scan('(node:4242) ExperimentalWarning: VM Modules is experimental');
  const b = scan('(node:977) ExperimentalWarning: VM Modules is experimental');
  assert.deepEqual([...a.errors], [...b.errors]);
});

test('excuse: a unit gate scoped to its changed files fails a subset of the base, and its count may not exceed the base count', () => {
  const scoped = 'test/merged-schema.test.ts:\n(fail) merged-schema: has the spool table [2.90ms]\nerror: no such table: spool\n\n 4 pass\n 1 fail';
  assert.equal(excuse(failed(), unitLog(scoped), withLog()).verdict, 'pass'); // 1 of the base's 3
  const over = scoped.replace(' 1 fail', ' 4 fail');
  assert.equal(excuse(failed(), unitLog(over), withLog()).verdict, 'fail');
});
