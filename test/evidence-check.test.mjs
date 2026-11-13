import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsidePaths } from '../lib/evidence-check.mjs';

const ROOT = '/work/repo';
const HOME = '/Users/x';
const check = (cmd) => outsidePaths(cmd, { root: ROOT, home: HOME });

test('outsidePaths: scripts outside the repository or under .orq/ are named', () => {
  assert.deepEqual(check('python3 /Users/x/plans/p1/verify.py unit-a'), ['/Users/x/plans/p1/verify.py']);
  assert.deepEqual(check('node /work/repo/.orq/verify.mjs a'), ['/work/repo/.orq/verify.mjs']);
  assert.deepEqual(check('node .orq/verify.mjs a && test -f x'), ['.orq/verify.mjs']);
  assert.deepEqual(check('bash ~/bin/check.sh'), ['~/bin/check.sh']);
  assert.deepEqual(check('/opt/x/../../Users/x/run-checks a'), ['/opt/x/../../Users/x/run-checks']); // normalised, a command word
  assert.deepEqual(check("sh -c 'node \"/tmp/v.js\"'"), ['/tmp/v.js']);
  assert.deepEqual(check('npm test; /home/ci/check'), ['/home/ci/check']);
  assert.deepEqual(check('node --config=/srv/conf/x.json t.js'), ['/srv/conf/x.json']);
});

test('outsidePaths: repository paths, tools and patterns are not flagged', () => {
  for (const cmd of [
    'npm test -- test/a.test.mjs', 'node /work/repo/scripts/check.mjs', '/usr/bin/env node t.js', 'test -f a.txt > /dev/null',
    '/opt/homebrew/bin/node t.js', 'grep -q "/api/v1" src/routes.js', 'curl -s http://localhost:3000/health', 'node ./scripts/x.mjs',
    'test -d /work/repo/dist', '/bin/sh -c "npm test"', 'echo ok 2>/dev/null', 'node scripts/orq-tools.mjs',
  ]) assert.deepEqual(check(cmd), [], cmd);
});
