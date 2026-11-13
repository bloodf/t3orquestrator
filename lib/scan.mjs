const SKIP = [
  /\.(skip|only)\(/, /\bx(it|describe|test)\(/, /\b(it|test)\.todo\(/, /@pytest\.mark\.skip/,
  /@unittest\.skip/, /\bt\.Skip\(/, /#\[ignore\]/, /@Disabled\b/, /@Ignore\b/,
];
const PLACEHOLDER = /\bTODO\b|\bFIXME\b|not implemented|unimplemented!|todo!\(|NotImplementedError/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/;

const plural = (n) => `${n} added line${n === 1 ? '' : 's'}`;

function countBy(lines, kind, matches) {
  const counts = new Map();
  for (const { path, line } of lines) {
    if (matches(line)) counts.set(path, (counts.get(path) || 0) + 1);
  }
  return [...counts].map(([path, n]) => ({ kind, path, detail: plural(n) }));
}

const isSkip = (l) => SKIP.some((re) => re.test(l));

const isTestPath = (path) => TEST_PATH.test(path);

function weakenedTests(removedLines, changedFiles) {
  const counts = new Map();
  for (const { path } of removedLines) counts.set(path, (counts.get(path) || 0) + 1);
  return changedFiles
    .filter((f) => f.status === 'M' && isTestPath(f.path) && counts.has(f.path))
    .map((f) => ({ kind: 'test-weakened', path: f.path, detail: `${counts.get(f.path)} lines removed` }));
}

const targetsChanged = (evidence, changedFiles) => (evidence
  ? changedFiles
    // anything that existed before the unit (M, D, T, a rename's source); never an added file
    .filter((f) => f.status !== 'A' && evidence.includes(f.path))
    .map((f) => ({ kind: 'evidence-target-changed', path: f.path, detail: 'evidence command names a changed file' }))
  : []);

export function scanDiff({ addedLines, removedLines = [], changedFiles, evidence = null }) {
  return [
    ...countBy(addedLines, 'skipped-test', isSkip),
    ...countBy(addedLines, 'placeholder', (l) => !isSkip(l) && PLACEHOLDER.test(l)),
    ...changedFiles
      .filter((f) => f.status === 'D' && isTestPath(f.path))
      .map((f) => ({ kind: 'deleted-test', path: f.path, detail: 'test file deleted' })),
    ...weakenedTests(removedLines, changedFiles),
    ...targetsChanged(evidence, changedFiles),
  ];
}
