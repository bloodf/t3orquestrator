import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDiff } from '../lib/scan.mjs';

const added = (path, ...lines) => lines.map((line) => ({ path, line }));
const scan = (lines, files = [], extra = {}) => scanDiff({ addedLines: lines, removedLines: [], changedFiles: files, ...extra });

test('no lines, no flags', () => {
  assert.deepEqual(scan([]), []);
});

test('skip and focus markers are flagged', () => {
  const markers = [
    "describe.skip('x', () => {})", "it.only('x', f)", "xit('x', f)", "xdescribe('x', f)", "xtest('x', f)",
    "it.todo('x')", "test.todo('x')", '@pytest.mark.skip(reason="x")', '@unittest.skip("x")',
    't.Skip("x")', '#[ignore]', '@Disabled', '@Ignore',
  ];
  for (const line of markers) {
    const flags = scan(added('a.test.mjs', line));
    assert.equal(flags.length, 1, line);
    assert.equal(flags[0].kind, 'skipped-test', line);
  }
});

test('ordinary code is not flagged', () => {
  assert.deepEqual(scan(added('a.mjs', 'const skipped = 1;', 'exit(1)', 'const maxit = 2;')), []);
});

test('placeholders are flagged case-insensitively', () => {
  const lines = ['// TODO fix', '// fixme later', 'throw new Error("Not Implemented")', 'unimplemented!()', 'todo!()', 'raise NotImplementedError'];
  for (const line of lines) {
    const flags = scan(added('a.mjs', line));
    assert.equal(flags.length, 1, line);
    assert.equal(flags[0].kind, 'placeholder', line);
  }
  assert.deepEqual(scan(added('a.mjs', 'const mastodon = 1;')), []);
});

test('one flag per kind and path with a count', () => {
  const flags = scan([
    ...added('a.mjs', '// TODO one', '// TODO two'),
    ...added('b.mjs', '// FIXME'),
  ]);
  assert.deepEqual(flags, [
    { kind: 'placeholder', path: 'a.mjs', detail: '2 added lines' },
    { kind: 'placeholder', path: 'b.mjs', detail: '1 added line' },
  ]);
});

test('deleted test files are flagged, other deletions and test additions are not', () => {
  const tests = ['test/a.mjs', 'tests/a.py', 'src/__tests__/a.js', 'spec/a.rb', 'a.test.js', 'a.spec.ts', 'a_test.go'];
  for (const path of tests) {
    const flags = scan([], [{ status: 'D', path }]);
    assert.deepEqual(flags, [{ kind: 'deleted-test', path, detail: 'test file deleted' }], path);
  }
  assert.deepEqual(scan([], [{ status: 'D', path: 'lib/a.mjs' }, { status: 'D', path: 'latest/a.mjs' }]), []);
  assert.deepEqual(scan([], [{ status: 'A', path: 'test/a.mjs' }, { status: 'M', path: 'a.test.js' }]), []);
});

test('inputs are not mutated', () => {
  const lines = Object.freeze([Object.freeze({ path: 'a', line: '// TODO' })]);
  const files = Object.freeze([Object.freeze({ status: 'D', path: 'test/x.mjs' })]);
  assert.equal(scanDiff({ addedLines: lines, changedFiles: files }).length, 2);
});

test('test-weakened: modified test file with removed lines', () => {
  const removed = [{ path: 'test/a.mjs', line: 'assert.equal(1, 1)' }, { path: 'test/a.mjs', line: 'assert.ok(x)' }, { path: 'lib/a.mjs', line: 'x' }];
  const files = [{ status: 'M', path: 'test/a.mjs' }, { status: 'M', path: 'lib/a.mjs' }];
  assert.deepEqual(scan([], files, { removedLines: removed }), [
    { kind: 'test-weakened', path: 'test/a.mjs', detail: '2 lines removed' },
  ]);
});

test('test-weakened ignores added, deleted or untouched test files', () => {
  const removed = [{ path: 'test/a.mjs', line: 'x' }];
  assert.deepEqual(scan([], [{ status: 'A', path: 'test/a.mjs' }], { removedLines: removed }), []);
  assert.deepEqual(scan([], [{ status: 'M', path: 'test/a.mjs' }], { removedLines: [] }), []);
});

test('evidence-target-changed: a changed file named in the evidence command', () => {
  const files = [{ status: 'M', path: 'test/a.mjs' }, { status: 'M', path: 'lib/b.mjs' }];
  const flags = scan([], files, { evidence: 'node --test test/a.mjs' });
  assert.deepEqual(flags, [{ kind: 'evidence-target-changed', path: 'test/a.mjs', detail: 'evidence command names a changed file' }]);
  assert.deepEqual(scan([], files, { evidence: null }), []);
  assert.deepEqual(scan([], files), []);
});
