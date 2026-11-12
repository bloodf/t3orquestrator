import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadCatalog, resolveSlots, defaultWhich, detectChecks, SLOTS,
} from '../lib/detect.mjs';

const kit = JSON.parse(fs.readFileSync(new URL('../playbook/tools.json', import.meta.url), 'utf8')).tools;
const entry = (slot, name, detect, use = 'use it') => ({ slot, name, detect, use });

test('kit catalog loads and covers every slot', () => {
  const cat = loadCatalog({ kitCatalog: kit, userCatalog: [] });
  for (const s of SLOTS) assert.ok(cat.some((e) => e.slot === s), s);
  assert.ok(cat.every((e) => e.use && e.name));
});

test('loadCatalog: user first, de-duplicated by slot+name', () => {
  const user = [entry('judge', 'laya', { command: 'mine' }), entry('judge', 'own', { command: 'own' })];
  const cat = loadCatalog({ kitCatalog: kit, userCatalog: user });
  assert.deepEqual(cat.slice(0, 2).map((e) => e.name), ['laya', 'own']);
  assert.equal(cat.filter((e) => e.slot === 'judge' && e.name === 'laya').length, 1);
  assert.equal(cat[0].detect.command, 'mine');
});

test('loadCatalog validates', () => {
  const bad = (e, re) => assert.throws(() => loadCatalog({ kitCatalog: [e], userCatalog: [] }), re);
  bad(entry('nope', 'x', { command: 'x' }), /slot/);
  bad(entry('judge', '', { command: 'x' }), /name/);
  bad(entry('judge', 'x', {}), /detect/);
  bad(entry('judge', 'x', { mcpTool: '(' }), /regex/);
  bad({ slot: 'judge', name: 'x', detect: { command: 'x' } }, /use/);
  assert.throws(() => loadCatalog({ kitCatalog: 'x', userCatalog: [] }), /array/);
});

test('resolveSlots: chains end in the builtin, catalog order kept', () => {
  const cat = loadCatalog({ kitCatalog: kit, userCatalog: [] });
  const none = resolveSlots({ catalog: cat, which: () => null, toolNames: [] });
  assert.deepEqual(none.judge, [{ name: 'self', kind: 'builtin', use: 'Decide it yourself.' }]);
  assert.equal(none.memory[0].name, 'file');
  assert.equal(none['code-index'][0].name, 'search');
  assert.deepEqual(none['git-host'], [{ name: 'local', kind: 'builtin', use: 'Keep the integration branch local and report it.' }]);
  const some = resolveSlots({
    catalog: cat, which: (c) => ({ semble: '/b/semble', graphify: '/b/graphify', gh: '/b/gh' })[c] ?? null,
    toolNames: ['mcp__x__jev_classify', 'mcp__h__hindsight_recall'],
  });
  assert.deepEqual(some['code-index'].map((p) => p.name), ['graphify', 'semble', 'search']);
  assert.deepEqual(some.judge.map((p) => `${p.name}:${p.kind}`), ['jev:mcp', 'self:builtin']);
  assert.deepEqual(some.memory.map((p) => p.name), ['hindsight', 'file']);
  assert.deepEqual(some['git-host'].map((p) => p.name), ['gh', 'local']);
  assert.equal(some['code-index'][0].kind, 'command');
  assert.ok(some['code-index'][0].use);
});

test('resolveSlots: keep retains earlier mcp detections', () => {
  const cat = loadCatalog({ kitCatalog: kit, userCatalog: [] });
  const r = resolveSlots({ catalog: cat, which: () => null, toolNames: [], keep: ['jev'] });
  assert.deepEqual(r.judge.map((p) => p.name), ['jev', 'self']);
  const c = resolveSlots({ catalog: cat, which: () => null, toolNames: [], keep: ['graphify'] });
  assert.deepEqual(c['code-index'].map((p) => p.name), ['search']);
});

test('defaultWhich scans PATH for executables', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'orq-which-'));
  fs.writeFileSync(path.join(dir, 'tool-x'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tool-y'), 'x', { mode: 0o644 });
  assert.equal(defaultWhich('tool-x', dir), path.join(dir, 'tool-x'));
  assert.equal(defaultWhich('tool-y', dir), null);
  assert.equal(defaultWhich('tool-z', `${dir}${path.delimiter}/nonexistent`), null);
});

function checks(files) {
  return detectChecks({ exists: (f) => f in files, readFile: (f) => files[f] });
}
const pkg = (scripts) => JSON.stringify({ scripts });

test('detectChecks: node package managers', () => {
  const s = { lint: 'x', test: 'y', build: 'z', other: 'w' };
  assert.deepEqual(checks({ 'package.json': pkg(s), 'pnpm-lock.yaml': '' }), {
    setup: 'pnpm install --frozen-lockfile', unit: null, full: 'pnpm run lint && pnpm run test && pnpm run build',
  });
  assert.equal(checks({ 'package.json': pkg(s), 'yarn.lock': '' }).setup, 'yarn install --immutable');
  assert.equal(checks({ 'package.json': pkg(s), 'bun.lockb': '' }).setup, 'bun install --frozen-lockfile');
  assert.equal(checks({ 'package.json': pkg(s), 'bun.lock': '' }).setup, 'bun install --frozen-lockfile');
  assert.equal(checks({ 'package.json': pkg(s), 'package-lock.json': '' }).setup, 'npm ci');
  const bare = checks({ 'package.json': pkg({ typecheck: 'x', test: 'y' }) });
  assert.deepEqual(bare, { setup: null, unit: null, full: 'npm run typecheck && npm run test' });
  assert.equal(checks({ 'package.json': pkg({}) }).full, null);
  assert.equal(checks({ 'package.json': '{}' }).full, null);
});

test('detectChecks: other ecosystems, first match wins, nothing', () => {
  assert.deepEqual(checks({ 'Cargo.toml': '' }), { setup: null, unit: null, full: 'cargo test' });
  assert.equal(checks({ 'go.mod': '' }).full, 'go test ./...');
  assert.equal(checks({ Makefile: 'all:\n\techo\ntest:\n\techo' }).full, 'make test');
  assert.equal(checks({ Makefile: 'all:\n\techo' }).full, null);
  assert.equal(checks({ 'pyproject.toml': '[tool.pytest.ini_options]' }).full, 'python -m pytest');
  assert.equal(checks({ 'pyproject.toml': '[project]' }).full, null);
  assert.equal(checks({ 'package.json': pkg({ test: 'x' }), 'Cargo.toml': '' }).full, 'npm run test');
  assert.deepEqual(checks({}), { setup: null, unit: null, full: null });
});

test('detectChecks: malformed package.json names the file', () => {
  assert.throws(() => checks({ 'package.json': '{nope' }), /package\.json/);
});

test('defaultWhich skips empty and relative PATH entries', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'orq-which-'));
  fs.writeFileSync(path.join(dir, 'tool-rel'), '#!/bin/sh\n', { mode: 0o755 });
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(defaultWhich('tool-rel', `${path.delimiter}.`), null);
    assert.equal(defaultWhich('tool-rel', `${path.delimiter}${dir}`), path.join(dir, 'tool-rel'));
  } finally {
    process.chdir(cwd);
  }
});
