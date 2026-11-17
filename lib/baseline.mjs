// A unit forks from the integration head: when that head already failed its final checks, the unit's checks fail
// the same tests. Those failures are not the unit's. Pure: the caller reads the files.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DURATION = /\s*(\[\d+(?:\.\d+)?\s*m?s\]|\(\d+(?:\.\d+)?\s*m?s\))/g; // bun [1.2ms], node (1.2ms), jest (5 ms)
const TRAILING_MS = /\s+\d+(?:\.\d+)?\s*m?s$/; // vitest: `× name 12ms`
const FAILURE = [
  /^\(fail\) \S/, // bun
  /^not ok \d+ - \S/, // node:test TAP
  /^✖ (?!failing tests:)\S/, // node:test spec
  /^FAIL \S/, // jest, vitest: the file
  /^[✕×] \S/, // jest, vitest: the test
  /^FAILED \S+::\S/, // pytest
  /^\S+?(?:\(\d+,\d+\)|:\d+:\d+)\S*\s.*\berror TS\d+:/, // tsc, plain and pretty
];
const CHECKS_FAILED = /^checks failed \(exit \d+\)$/;

const normalise = (raw) => raw.replace(ANSI, '').replace(DURATION, '').trim().replace(/\s+/g, ' ');

// The failure lines of a test run, normalised so two runs of the same failing test read the same.
export function failureLines(text) {
  const out = new Set();
  for (const raw of String(text ?? '').split('\n')) {
    let l = normalise(raw);
    if (!FAILURE.some((re) => re.test(l))) continue;
    if (/^[✕×✖] /.test(l)) l = l.replace(TRAILING_MS, '');
    out.add(l.replace(/^not ok \d+ - /, 'not ok - ').replace(/^(FAILED \S+) - .*$/, '$1'));
  }
  return out;
}

// The output of the checks steps (and their retry) in a gate log, whose steps start with `== <step>` lines.
export function checksOutput(log) {
  const parts = String(log ?? '').split(/^== (setup|evidence|checks)(?: \(retry\))?\n/m);
  return parts.filter((_, i) => i > 0 && i % 2 === 0 && parts[i - 1] === 'checks').join('\n');
}

const tails = (result) => (result.steps ?? []).filter((s) => s.name.startsWith('checks')).map((s) => s.tail).join('\n');

// result: the unit's gate result. unitLog: the unit's whole gate output (null when not kept). base: { sha, result,
// log } for the final run on the head the unit forked from, or null. A unit whose checks fail only tests that base
// also failed passes, flagged. A truncated base tail excuses only the lines it shows.
export function excuse(result, unitLog, base) {
  const onlyChecks = result.verdict === 'fail' && result.failures.length === 1 && CHECKS_FAILED.test(result.failures[0]);
  if (!onlyChecks || unitLog === null || unitLog.includes('\n== log truncated\n')) return result;
  if (base?.result?.verdict !== 'fail' || base.result.headSha !== base.sha) return result;
  const mine = [...failureLines(checksOutput(unitLog))];
  const theirs = failureLines(`${checksOutput(base.log)}\n${tails(base.result)}`);
  if (mine.length === 0 || !mine.every((l) => theirs.has(l))) return result;
  const more = mine.length > 3 ? `; +${mine.length - 3} more` : '';
  const flag = {
    kind: 'pre-existing-failures', path: '', detail: `${mine.length} failing tests also fail on the integration head ${base.sha.slice(0, 12)}: ${mine.slice(0, 3).join('; ')}${more}`,
  };
  return { ...result, verdict: 'pass', failures: [], flags: [...result.flags, flag] };
}
