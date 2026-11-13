import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import {
  emptyRegistry, mergeCapabilities, setInstanceDisabled, routable,
} from '../lib/registry.mjs';
import { route } from '../lib/route.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const rules = JSON.parse(await fs.readFile(new URL('../playbook/routing.json', import.meta.url), 'utf8'));
const suggestions = JSON.parse(await fs.readFile(new URL('../playbook/suggestions.json', import.meta.url), 'utf8'));
const prov = (id, models, constraints = []) => ({ providerInstanceId: id, driverKind: 'k', displayName: id, models, constraints });
const caps = (...p) => ({ providers: p });
const merge = (reg, c, now = 1) => mergeCapabilities(reg, c, { now, suggestions }).registry;
const two = () => merge(emptyRegistry(), caps(prov('a', ['x-pro']), prov('b', ['y-pro'])));
const go = (registry, over = {}) => route({ registry, rules, job: 'implement', now: NOW, ...over });

test('setInstanceDisabled: sets, clears, throws, does not mutate', () => {
  const reg = Object.freeze(two());
  const off = setInstanceDisabled(reg, 'a', true);
  assert.equal(off.instances.a.userDisabled, true);
  assert.equal(reg.instances.a.userDisabled, undefined);
  assert.equal(setInstanceDisabled(off, 'a', false).instances.a.userDisabled, false);
  assert.throws(() => setInstanceDisabled(reg, 'zz', true), /unknown instance zz/);
  assert.equal(routable({ enabled: true }), true);
  assert.equal(routable({ enabled: true, userDisabled: true }), false);
  assert.equal(routable({ enabled: false }), false);
});

test('route: a user-disabled instance gets nothing and does not satisfy tier existence', () => {
  const off = setInstanceDisabled(two(), 'a', true);
  assert.deepEqual(go(off).candidates.map((c) => c.instance), ['b']);
  const only = setInstanceDisabled(merge(emptyRegistry(), caps(prov('a', ['x-opus']), prov('b', ['y-mini']))), 'a', true);
  const r = go(only, { job: 'plan' });
  assert.equal(r.reason, 'no model at tier 4; using best available');
  assert.deepEqual(r.candidates.map((c) => c.instance), ['b']);
  const all = setInstanceDisabled(off, 'b', true);
  assert.deepEqual([go(all).blocked, go(all).candidates], ['empty', []]);
});

test('merge keeps userDisabled across syncs and a disappear/reappear cycle; enable restores', () => {
  let reg = setInstanceDisabled(two(), 'a', true);
  reg = merge(reg, caps(prov('a', ['x-pro']), prov('b', ['y-pro'])), 2);
  assert.equal(reg.instances.a.userDisabled, true);
  reg = merge(reg, caps(prov('b', ['y-pro'])), 3);
  assert.equal(reg.instances.a.userDisabled, true);
  reg = merge(reg, caps(prov('a', ['x-pro']), prov('b', ['y-pro'])), 4);
  assert.equal(reg.instances.a.userDisabled, true);
  assert.equal(reg.instances.a.enabled, true);
  assert.deepEqual(go(reg).candidates.map((c) => c.instance), ['b']);
  reg = setInstanceDisabled(reg, 'a', false);
  assert.deepEqual(go(reg).candidates.map((c) => c.instance), ['a', 'b']);
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-inst-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  return { home, cwd: root };
}
async function orq(args, s, stdin = '') {
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { T3ORQ_HOME: s.home }, cwd: s.cwd,
    now: () => NOW, stdin: async () => stdin, deps: { exec: () => ({ code: 1, stdout: '', stderr: '' }), which: () => null, readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }) },
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('instance list/disable/enable and the sync line', async () => {
  const s = await setup();
  const payload = JSON.stringify(caps(prov('a', ['x-pro', 'x-mini']), prov('b', ['y-pro']), prov('c', ['z-pro'], ['Provider instance is disabled.'])));
  await orq(['sync'], s, payload);
  const file = path.join(s.home, 'registry.json');
  const reg = JSON.parse(await fs.readFile(file, 'utf8'));
  reg.instances.b.cooldownUntil = NOW + 60_000;
  await fs.writeFile(file, JSON.stringify(reg));
  assert.equal((await orq(['instance', 'disable', 'a'], s)).out, 'instance a: disabled by user\n');
  const list = await orq(['instance', 'list'], s);
  assert.equal(list.out, `a off-user models=2\nb on models=1 cooldown_until=${new Date(NOW + 60_000).toISOString()}\nc off-t3 models=1\n`);
  const resync = await orq(['sync'], s, payload);
  assert.match(resync.out, /^synced: .*\nuser-disabled: a$/m);
  assert.equal((await orq(['instance', 'enable', 'a'], s)).out, 'instance a: enabled\n');
  assert.match((await orq(['instance', 'list'], s)).out, /^a on models=2$/m);
  assert.doesNotMatch((await orq(['sync'], s, payload)).out, /user-disabled/);
  const bad = await orq(['instance', 'disable', 'zz'], s);
  assert.equal(bad.code, 4);
  assert.match(bad.err, /unknown instance zz/);
  assert.equal((await orq(['instance', 'frob'], s)).code, 2);
  assert.equal((await orq(['instance', 'disable'], s)).code, 2);
});
