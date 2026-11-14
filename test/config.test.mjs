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
    autonomy: null, questions: 'auto', base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null,
  });
  const c = await loadProjectConfig(await tmpFile('{"autonomy":"draft","checks":{"full":"make test"}}'));
  assert.equal(c.autonomy, 'draft');
  assert.deepEqual(c.checks, { setup: null, unit: null, full: 'make test' });
});

test('project config: validation', async () => {
  for (const [json, what] of [
    ['{"autonomy":"yolo"}', /autonomy/], ['{"base":""}', /base/], ['{"checks":{"unit":3}}', /checks\.unit/],
    ['{"slots":[]}', /slots/], ['{"t3":{"bin":"x"}}', /t3/], ['{"checks":[]}', /checks/],
    ['{"questions":"maybe"}', /questions/], ['{"orchestrator":{"instance":"a"}}', /orchestrator/], ['{"orchestrator":{"instance":"a","model":"m","threadId":3}}', /orchestrator/],
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
  assert.equal(setConfigValue(base, 'questions', 'user', 'project').questions, 'user');
  assert.equal(setConfigValue(base, 'questions', 'auto', 'project').questions, 'auto');
  assert.throws(() => setConfigValue(base, 'questions', 'never', 'project'), /questions must be one of auto, user/);
});

test('project config: questions defaults to auto; the orchestrator model is {instance, model} when recorded', async () => {
  assert.equal((await loadProjectConfig(await tmpFile('{"questions":null}'))).questions, 'auto');
  const c = await loadProjectConfig(await tmpFile('{"orchestrator":{"instance":"pa","model":"m4"}}'));
  assert.deepEqual(c.orchestrator, { instance: 'pa', model: 'm4' });
});

test('setConfigValue: machine keys and unknown keys', () => {
  assert.deepEqual(setConfigValue({ perInstanceLimit: 2 }, 'cap', '4', 'machine'), { perInstanceLimit: 2, cap: 4 });
  assert.deepEqual(setConfigValue({ cap: 4, perInstanceLimit: 2 }, 'cap', 'null', 'machine'), { perInstanceLimit: 2 });
  assert.equal(setConfigValue({ perInstanceLimit: 2 }, 'perInstanceLimit', '3', 'machine').perInstanceLimit, 3);
  assert.throws(() => setConfigValue({}, 'cap', 'x', 'machine'), /positive integer/);
  assert.throws(() => setConfigValue({}, 'nope', '1', 'machine'), /valid keys: cap, perInstanceLimit/);
  assert.throws(() => setConfigValue({}, 'perInstanceLimit', '1', 'project'), /valid keys: autonomy, base, cap, checks\.setup, checks\.unit, checks\.full/);
});

test('project cap: optional, a positive integer, cleared with null; the machine cap is a separate key', async () => {
  assert.deepEqual(setConfigValue({ base: 'main' }, 'cap', '2', 'project'), { base: 'main', cap: 2 });
  assert.deepEqual(setConfigValue({ base: 'main', cap: 2 }, 'cap', 'null', 'project'), { base: 'main' });
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => setConfigValue({}, 'cap', bad, 'project'), /cap must be a positive integer/);
  assert.equal((await loadProjectConfig(await tmpFile('{}'))).cap, undefined);
  assert.equal((await loadProjectConfig(await tmpFile('{"cap":3}'))).cap, 3);
  await assert.rejects(loadProjectConfig(await tmpFile('{"cap":0}')), /cap must be a positive integer/);
});

test('project config: scheduler keys are positive integers, settable and validated', async () => {
  const c = await loadProjectConfig(await tmpFile('{"pollSeconds":5,"leaseTtlMinutes":10}'));
  assert.equal(c.pollSeconds, 5);
  assert.equal(c.leaseTtlMinutes, 10);
  await assert.rejects(loadProjectConfig(await tmpFile('{"gateConcurrency":0}')), /gateConcurrency must be a positive integer/);
  await assert.rejects(loadProjectConfig(await tmpFile('{"stallMinutes":"x"}')), /stallMinutes must be a positive integer/);
  const base = { autonomy: null, base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null };
  for (const k of ['pollSeconds', 'stallMinutes', 'gateConcurrency', 'leaseTtlMinutes']) {
    assert.equal(setConfigValue(base, k, '7', 'project')[k], 7);
  }
  assert.throws(() => setConfigValue(base, 'pollSeconds', '0', 'project'), /positive integer/);
});

test('pollSeconds has a floor of 5: set refuses less, a file with less reads as 5', async () => {
  const base = { autonomy: null, base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null };
  assert.throws(() => setConfigValue(base, 'pollSeconds', '1', 'project'),
    /^Error: pollSeconds must be at least 5 \(every poll runs t3 once, plus once per running thread\), got 1$/);
  assert.equal(setConfigValue(base, 'pollSeconds', '5', 'project').pollSeconds, 5);
  assert.equal((await loadProjectConfig(await tmpFile('{"pollSeconds":1}'))).pollSeconds, 5);
  assert.equal((await loadProjectConfig(await tmpFile('{"pollSeconds":30}'))).pollSeconds, 30);
  assert.equal((await loadProjectConfig(await tmpFile('{}'))).pollSeconds, undefined); // the default stays where it lives
});

test('share: a list of repository-relative directories, set as a comma list, null turns it off', async () => {
  const base = { autonomy: null, base: 'main', checks: { setup: null, unit: null, full: null }, slots: {}, t3: null };
  assert.deepEqual(setConfigValue(base, 'share', 'node_modules, apps/shop/node_modules', 'project').share, ['node_modules', 'apps/shop/node_modules']);
  assert.equal(setConfigValue(base, 'share', 'null', 'project').share, null);
  assert.throws(() => setConfigValue(base, 'share', 'node_modules,../x', 'project'), /share: "\.\.\/x" must be a relative path inside the repository \(not \.git or \.orq\)/);
  assert.equal((await loadProjectConfig(await tmpFile('{"share":["node_modules"]}'))).share[0], 'node_modules');
  assert.equal((await loadProjectConfig(await tmpFile('{}'))).share, undefined); // unset: init detects it
  await assert.rejects(loadProjectConfig(await tmpFile('{"share":["/abs"]}')), /share must be null or a list of relative paths/);
  await assert.rejects(loadProjectConfig(await tmpFile('{"share":".orq"}')), /share must be null or a list of relative paths/);
});

test('project goal: one clean line of at most 500 characters, cleared with null', async () => {
  assert.deepEqual(setConfigValue({ base: 'main' }, 'goal', '  build\n\tthe   product\u0007  ', 'project'), { base: 'main', goal: 'build the product' });
  assert.deepEqual(setConfigValue({ base: 'main', goal: 'x' }, 'goal', 'null', 'project'), { base: 'main' });
  assert.equal(setConfigValue({}, 'goal', 'a'.repeat(500), 'project').goal.length, 500);
  assert.throws(() => setConfigValue({}, 'goal', 'a'.repeat(501), 'project'), /goal must be at most 500 characters/);
  for (const bad of ['', '   ', '\n\t']) assert.throws(() => setConfigValue({}, 'goal', bad, 'project'), /goal must not be empty/);
  assert.throws(() => setConfigValue({}, 'goal', 'x', 'machine'), /unknown machine config key "goal"/);
  assert.equal((await loadProjectConfig(await tmpFile('{}'))).goal, undefined);
  assert.equal((await loadProjectConfig(await tmpFile('{"goal":"ship it"}'))).goal, 'ship it');
  for (const bad of ['""', '"a\\nb"', '3', 'null', `"${'a'.repeat(501)}"`]) {
    await assert.rejects(loadProjectConfig(await tmpFile(`{"goal":${bad}}`)), /goal must be/);
  }
});
