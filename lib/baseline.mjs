// A unit forks from the integration head: when that head already failed its final checks, the unit's checks fail
// the same tests. Those failures are not the unit's. Pure: the caller reads the files.
// Limit: a test that fails on both for a different reason reads as the same failure, unless its error lines differ.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DURATION = /\s*(\[\d+(?:\.\d+)?\s*m?s\]|\(\d+(?:\.\d+)?\s*m?s\))/g; // bun [1.2ms], node (1.2ms), jest (5 ms)
const TRAILING_MS = /\s+\d+(?:\.\d+)?\s*m?s$/; // vitest: `× name 12ms`
const GATE_DIR = /\S*\/\.orq\/gate\/[^/\s)]+/g; // each gate runs in its own checkout
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T[\d:_.]+Z/g;
const TEST = [
  /^\(fail\) \S/, // bun
  /^not ok \d+ - \S/, // node:test TAP
  /^✖ (?!failing tests:)\S/, // node:test spec
  /^● (?!Console)\S/, // jest: `● suite › test`
  /^FAIL \S+ > \S/, // vitest
  /^[✕×] \S/, // jest, vitest
  /^FAILED \S+::\S/, // pytest
  /^\S+?(?:\(\d+,\d+\)|:\d+:\d+)\S*\s.*\berror TS\d+:/, // tsc, plain and pretty
];
const FILE = [/^(\S+\.\w+):$/, /^(?:FAIL|PASS) (\S+)$/]; // bun's file headers; jest's FAIL/PASS <file>
const COUNT = [/^(\d+) fail$/, /^ℹ fail (\d+)$/, /^# fail (\d+)$/, /^Tests: .*?(\d+) failed/, /^=+ .*?\b(\d+) failed\b/];
const SUMMARY = /^\d+ tests? failed:$|^✖ failing tests:$|^Test Suites:/; // bun lists its failures again, with no file
const PASSED = /^(?:\(pass\)|✓|✔|ok \d+ |PASS )/;
const ERROR = /\berror\b|\bfail/i;
const CHECKS_FAILED = /^checks failed \(exit \d+\)$/;

const normalise = (raw) => raw.replace(ANSI, '').replace(DURATION, '').replace(GATE_DIR, '<gate>').replace(TIMESTAMP, '<time>')
  .trim().replace(/\s+/g, ' ');
const testKey = (l) => (/^[✕×✖] /.test(l) ? l.replace(TRAILING_MS, '') : l).replace(/^not ok \d+ - /, 'not ok - ').replace(/^(FAILED \S+) - .*$/, '$1');

// What a test run's output says: its failing tests (`<file>: <line>` where the runner names the file), the error-
// looking lines no pattern knows, the runner's failure count (null when not printed), and whether a failing file
// named no failing test.
export function scan(text) {
  const failures = new Set();
  const errors = new Set();
  const failing = new Set();
  const named = new Set();
  let file = null;
  let count = null;
  for (const raw of String(text ?? '').split('\n')) {
    const l = normalise(raw);
    const header = FILE.map((re) => re.exec(l)).find(Boolean);
    const n = COUNT.map((re) => re.exec(l)).find(Boolean);
    if (n) count = Math.max(count ?? 0, Number(n[1]));
    if (n || SUMMARY.test(l)) file = null;
    else if (header && !TEST.some((re) => re.test(l))) {
      file = header[1];
      if (l.startsWith('FAIL ')) failing.add(file);
    } else if (TEST.some((re) => re.test(l))) {
      failures.add(file ? `${file}: ${testKey(l)}` : testKey(l));
      if (file) named.add(file);
    }
    if (ERROR.test(l) && !n && !SUMMARY.test(l) && !PASSED.test(l)) errors.add(l);
  }
  return {
    failures, errors, count, unnamed: [...failing].some((f) => !named.has(f)),
  };
}

export const failureLines = (text) => scan(text).failures;

// The output of the checks steps (and their retry) in a gate log, whose steps start with `== <step>` lines.
export function checksOutput(log) {
  const parts = String(log ?? '').split(/^== (setup|evidence|checks)(?: \(retry\))?\n/m);
  return parts.filter((_, i) => i > 0 && i % 2 === 0 && parts[i - 1] === 'checks').join('\n');
}

const tails = (result) => (result.steps ?? []).filter((s) => s.name.startsWith('checks')).map((s) => s.tail).join('\n');
const within = (mine, theirs) => [...mine].every((l) => theirs.has(l));

// result: the unit's gate result. unitLog: the unit's whole gate output (null when not kept). base: { sha, result,
// log } for the final run on the head the unit forked from, or null. A unit whose checks fail only tests that base
// also failed, with no error line the base did not print and no more failures than it counted, passes, flagged.
// Only lines actually seen in the base's log or tail are excused.
export function excuse(result, unitLog, base) {
  const onlyChecks = result.verdict === 'fail' && result.failures.length === 1 && CHECKS_FAILED.test(result.failures[0]);
  if (!onlyChecks || unitLog === null || unitLog.includes('\n== log truncated\n')) return result;
  if (base?.result?.verdict !== 'fail' || base.result.headSha !== base.sha) return result;
  const mine = scan(checksOutput(unitLog));
  const theirs = scan(`${checksOutput(base.log)}\n${tails(base.result)}`);
  const counted = mine.count === null || (theirs.count !== null && mine.count <= theirs.count);
  if (mine.failures.size === 0 || mine.unnamed || !counted || !within(mine.failures, theirs.failures) || !within(mine.errors, theirs.errors)) return result;
  const names = [...mine.failures];
  const more = names.length > 3 ? `; +${names.length - 3} more` : '';
  const flag = {
    kind: 'pre-existing-failures', path: '', detail: `${names.length} failing tests also fail on the integration head ${base.sha.slice(0, 12)}: ${names.slice(0, 3).join('; ')}${more}`,
  };
  return { ...result, verdict: 'pass', failures: [], flags: [...result.flags, flag] };
}
