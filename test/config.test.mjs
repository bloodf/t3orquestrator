import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMachineConfig, loadProjectConfig, setConfigValue } from '../lib/config.mjs';

async function tmpFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-config-'));
  const file = path.join(dir, 'config.json');
  if (content !== undefined) await fs.writeFile(file, content);
  return file;
}

test('machine config: defaults and values', async () => {
  assert.deepEqual(await loadMachineConfig(await tmpFile()), { perInstanceLimit: 2 });
  assert.deepEqual(await loadMachineConfig(await tmpFile('{"cap":3}')), { cap: 3, perInstanceLimit: 2 });
});

test('machine config: invalid values name the file', async () => {
  const f = await tmpFile('{"cap":0}');
  await assert.rejects(loadMachineConfig(f), new RegExp(`invalid config ${f.replace(/[/.]/g, '\\$&')}: cap`));
  await assert.rejects(loadMachineConfig(await tmpFile('{"perInstanceLimit":1.5}')), /perInstanceLimit/);
  await assert.rejects(loadMachineConfig(await tmpFile('[]')), /invalid config .*: expected an object/);
});

test('project config: defaults merged', async () => {
  assert.deepEqual(await loadProjectConfig(await tmpFile()), {
    autonomy: null, base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null,
  });
  const c = await loadProjectConfig(await tmpFile('{"autonomy":"draft","checks":{"full":"make test"}}'));
  assert.equal(c.autonomy, 'draft');
  assert.deepEqual(c.checks, { setup: null, unit: null, full: 'make test' });
});

test('project config: validation', async () => {
  for (const [json, what] of [
    ['{"autonomy":"yolo"}', /autonomy/], ['{"base":""}', /base/], ['{"checks":{"unit":3}}', /checks\.unit/],
    ['{"slots":[]}', /slots/], ['{"t3":{"bin":"x"}}', /t3/], ['{"checks":[]}', /checks/],
  ]) {
    await assert.rejects(loadProjectConfig(await tmpFile(json)), (e) => /^invalid config /.test(e.message) && what.test(e.message));
  }
});

test('setConfigValue: project keys, immutability, null clears', () => {
  const base = Object.freeze({
    autonomy: null, base: 'main', checks: Object.freeze({ setup: 'a', unit: null, full: null }), slots: {}, t3: null,
  });
  assert.equal(setConfigValue(base, 'autonomy', 'review-fix', 'project').autonomy, 'review-fix');
  assert.equal(setConfigValue(base, 'base', 'trunk', 'project').base, 'trunk');
  assert.equal(setConfigValue(base, 'checks.unit', 'npm test', 'project').checks.unit, 'npm test');
  assert.equal(setConfigValue(base, 'checks.setup', 'null', 'project').checks.setup, null);
  assert.equal(setConfigValue({ ...base, autonomy: 'draft' }, 'autonomy', 'null', 'project').autonomy, null);
  assert.equal(base.checks.setup, 'a');
  assert.throws(() => setConfigValue(base, 'autonomy', 'bogus', 'project'), /autonomy/);
  assert.throws(() => setConfigValue(base, 'base', 'null', 'project'), /base/);
});

test('setConfigValue: machine keys and unknown keys', () => {
  assert.deepEqual(setConfigValue({ perInstanceLimit: 2 }, 'cap', '4', 'machine'), { perInstanceLimit: 2, cap: 4 });
  assert.deepEqual(setConfigValue({ cap: 4, perInstanceLimit: 2 }, 'cap', 'null', 'machine'), { perInstanceLimit: 2 });
  assert.equal(setConfigValue({ perInstanceLimit: 2 }, 'perInstanceLimit', '3', 'machine').perInstanceLimit, 3);
  assert.throws(() => setConfigValue({}, 'cap', 'x', 'machine'), /positive integer/);
  assert.throws(() => setConfigValue({}, 'nope', '1', 'machine'), /valid keys: cap, perInstanceLimit/);
  assert.throws(() => setConfigValue({}, 'cap', '1', 'project'), /valid keys: autonomy, base, checks\.setup, checks\.unit, checks\.full/);
});
