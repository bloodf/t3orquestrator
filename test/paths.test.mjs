import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  homeDir, projectDir, registryPath, leasesDir,
  machineConfigPath, projectConfigPath, ledgerPath,
} from '../lib/paths.mjs';

test('homeDir uses T3ORQ_HOME when set', () => {
  assert.equal(homeDir({ T3ORQ_HOME: '/x/y' }), '/x/y');
});

test('homeDir defaults to ~/.t3orq', () => {
  assert.equal(homeDir({}), path.join(os.homedir(), '.t3orq'));
});

test('homeDir ignores empty T3ORQ_HOME', () => {
  assert.equal(homeDir({ T3ORQ_HOME: '' }), path.join(os.homedir(), '.t3orq'));
});

test('homeDir rejects a relative T3ORQ_HOME', () => {
  assert.throws(() => homeDir({ T3ORQ_HOME: 'rel/dir' }), /T3ORQ_HOME must be an absolute path/);
});

test('projectDir is <cwd>/.orq', () => {
  assert.equal(projectDir('/p'), path.join('/p', '.orq'));
});

test('machine-level helpers live under home', () => {
  const env = { T3ORQ_HOME: '/h' };
  assert.equal(registryPath(env), path.join('/h', 'registry.json'));
  assert.equal(leasesDir(env), path.join('/h', 'leases'));
  assert.equal(machineConfigPath(env), path.join('/h', 'config.json'));
});

test('project-level helpers live under .orq', () => {
  assert.equal(projectConfigPath('/p'), path.join('/p', '.orq', 'config.json'));
  assert.equal(ledgerPath('/p'), path.join('/p', '.orq', 'ledger.jsonl'));
});
