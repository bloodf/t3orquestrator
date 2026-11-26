import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatePrefix, gatePriorityError } from '../lib/gate-priority.mjs';
import { defaultRun } from '../lib/gate.mjs';
import { setConfigValue } from '../lib/config.mjs';

test('gatePrefix: ionice + nice on Linux, taskpolicy -b on macOS, only the tools that exist; false is off; a list is used as is', () => {
  const all = () => true;
  assert.deepEqual(gatePrefix(undefined, { platform: 'linux', has: all }), ['ionice', '-c2', '-n7', 'nice', '-n10']);
  assert.deepEqual(gatePrefix(undefined, { platform: 'linux', has: (c) => c === 'nice' }), ['nice', '-n10']);
  assert.deepEqual(gatePrefix(undefined, { platform: 'darwin', has: all }), ['taskpolicy', '-b']);
  assert.deepEqual(gatePrefix(undefined, { platform: 'darwin', has: () => false }), []);
  assert.deepEqual(gatePrefix(undefined, { platform: 'win32', has: all }), []);
  assert.deepEqual(gatePrefix(false, { platform: 'linux', has: all }), []);
  assert.deepEqual(gatePrefix(['nice', '-n5'], { platform: 'linux', has: () => false }), ['nice', '-n5']);
});

test('gatePriority config: false or a list of strings', () => {
  assert.equal(gatePriorityError(undefined), null);
  assert.equal(gatePriorityError(false), null);
  assert.equal(gatePriorityError(['nice', '-n10']), null);
  assert.match(gatePriorityError(true), /false or a non-empty list/);
  assert.match(gatePriorityError([]), /non-empty/);
  assert.match(gatePriorityError(['nice', 3]), /strings/);
  assert.equal(setConfigValue({}, 'gatePriority', 'false', 'machine').gatePriority, false);
  assert.deepEqual(setConfigValue({}, 'gatePriority', '["nice","-n15"]', 'machine').gatePriority, ['nice', '-n15']);
  assert.equal(setConfigValue({ gatePriority: false }, 'gatePriority', 'null', 'machine').gatePriority, undefined);
  assert.equal(setConfigValue({}, 'gateCap', '3', 'machine').gateCap, 3);
  assert.throws(() => setConfigValue({}, 'gateCap', '0', 'machine'), /positive integer/);
  assert.equal(setConfigValue({}, 'depCache', 'false', 'machine').depCache, false);
  assert.throws(() => setConfigValue({}, 'depCache', '"no"', 'machine'), /true or false/);
});

test('defaultRun runs a step under the prefix, at the lower priority, and still kills its whole group on a timeout', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-prio-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // the prefix wraps the step's shell (a CI runner may not show niceness, so the wrapping itself is checked)
  const wrapped = await defaultRun('echo "$ORQ_PREFIXED" && echo ok', { cwd: dir, timeoutMs: 10_000, prefix: ['env', 'ORQ_PREFIXED=yes', 'nice', '-n10'] });
  assert.equal(wrapped.code, 0);
  assert.deepEqual(wrapped.output.trim().split('\n').map((l) => l.trim()), ['yes', 'ok']);
  const pidFile = path.join(dir, 'child.pid');
  const slow = await defaultRun(`sleep 30 & echo $! > ${pidFile}; wait`, { cwd: dir, timeoutMs: 300, prefix: ['nice', '-n10'] });
  assert.equal(slow.timedOut, true);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  await new Promise((r) => { setTimeout(r, 300); });
  assert.throws(() => process.kill(pid, 0), /ESRCH/); // the background child died with the step
  const plain = await defaultRun('exit 3', { cwd: dir, timeoutMs: 10_000, prefix: [] });
  assert.equal(plain.code, 3);
});
