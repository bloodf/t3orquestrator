import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cacheKey, createDepCache, defaultClone, findModules, onlyPnpmInstalls, realKeyOf,
} from '../lib/dep-cache.mjs';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-depcache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const copy = (src, dst) => { fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); return true; };

test('onlyPnpmInstalls: only a setup that is nothing but pnpm installs may be skipped', () => {
  for (const ok of ['pnpm install', 'pnpm i --frozen-lockfile', 'CI=1 pnpm install --frozen-lockfile --prefer-offline',
    'pnpm install && pnpm -C website install', 'pnpm install --frozen-lockfile && cd tests && pnpm install', 'pnpm --dir cli install']) {
    assert.equal(onlyPnpmInstalls(ok), true, ok);
  }
  for (const no of [null, '', 'npm ci', 'pnpm install && pnpm build', 'pnpm install; rm -rf /', 'pnpm install | tee x', 'cd x',
    'pnpm install $(evil)', 'bun install', 'pnpm install --filter a', 'pnpm add left-pad']) {
    assert.equal(onlyPnpmInstalls(no), false, String(no));
  }
});

const TREE = [
  '100644 blob 1111111111111111111111111111111111111111\tREADME.md',
  '100644 blob 2222222222222222222222222222222222222222\tpackage.json',
  '100644 blob 3333333333333333333333333333333333333333\tpnpm-lock.yaml',
  '100644 blob 4444444444444444444444444444444444444444\tsrc/index.ts',
  '100644 blob 5555555555555555555555555555555555555555\tpackages/a/package.json',
  '100644 blob 6666666666666666666666666666666666666666\tpatches/x@1.patch',
].join('\n');

test('cacheKey changes with every install input and with nothing else', () => {
  const base = {
    lsTree: TREE, setup: 'pnpm install', node: 'v24.1.0', pnpm: '12.1.0', platform: 'linux', arch: 'x64',
  };
  const k = cacheKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(cacheKey({ ...base, lsTree: TREE.replace('1111', '9999').replace('4444', '8888') }), k); // README, source
  for (const [field, value] of [['lsTree', TREE.replace('3333', '7777')], ['lsTree', TREE.replace('5555', '7777')], ['lsTree', TREE.replace('6666', '7777')],
    ['setup', 'pnpm install --frozen-lockfile'], ['node', 'v24.2.0'], ['pnpm', '12.2.0'], ['platform', 'darwin'], ['arch', 'arm64'], ['nodeEnv', 'production']]) {
    assert.notEqual(cacheKey({ ...base, [field]: value }), k, `${field} must change the key`);
  }
});

test('findModules: every top node_modules, none inside another, none under .git or .orq', (t) => {
  const dir = tmp(t);
  for (const f of ['node_modules/a/index.js', 'node_modules/a/node_modules/b/i.js', 'packages/p/node_modules/c/i.js', '.git/node_modules/x', '.orq/gate/node_modules/y', 'src/a.ts']) write(path.join(dir, f));
  assert.deepEqual(findModules(dir), ['node_modules', 'packages/p/node_modules']);
});

function checkout(root, name) {
  const dir = path.join(root, name);
  write(path.join(dir, 'package.json'), '{}');
  write(path.join(dir, 'packages/p/package.json'), '{}');
  return dir;
}

test('createDepCache: a miss publishes the installed node_modules; a hit restores a private copy with symlinks intact', (t) => {
  const root = tmp(t);
  const cacheRoot = path.join(root, 'cache');
  const keys = [];
  const mk = (key = 'a'.repeat(64)) => createDepCache({
    root: cacheRoot, keyOf: (d) => { keys.push(d); return key; }, clone: copy, now: () => 1000,
  });
  const first = checkout(root, 'gate-1');
  assert.equal(mk().restore(first), false); // empty cache
  write(path.join(first, 'node_modules/.pnpm/a@1/node_modules/a/index.js'), 'a1');
  fs.symlinkSync('.pnpm/a@1/node_modules/a', path.join(first, 'node_modules/a'));
  write(path.join(first, 'packages/p/node_modules/.bin/a'), '#!/bin/sh');
  const c = mk();
  assert.equal(c.publish(first), true);
  assert.equal(c.publish(first), false); // already there
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheRoot, 'a'.repeat(64), 'manifest.json'), 'utf8')).dirs, ['node_modules', 'packages/p/node_modules']);
  const second = checkout(root, 'gate-2');
  assert.equal(mk().restore(second), true);
  assert.equal(fs.readFileSync(path.join(second, 'node_modules/a/index.js'), 'utf8'), 'a1'); // through the relative link
  assert.equal(fs.readlinkSync(path.join(second, 'node_modules/a')), '.pnpm/a@1/node_modules/a');
  fs.writeFileSync(path.join(second, 'node_modules/.pnpm/a@1/node_modules/a/index.js'), 'changed by a gate');
  const third = checkout(root, 'gate-3');
  assert.equal(mk().restore(third), true);
  assert.equal(fs.readFileSync(path.join(third, 'node_modules/a/index.js'), 'utf8'), 'a1'); // private copies
  assert.equal(mk('b'.repeat(64)).restore(checkout(root, 'gate-4')), false); // another key: setup runs
});

test('createDepCache never uses the cache when it cannot clone, cannot key, or a clone fails half way', (t) => {
  const root = tmp(t);
  const cacheRoot = path.join(root, 'cache');
  const dir = checkout(root, 'gate-1');
  write(path.join(dir, 'node_modules/a/i.js'));
  write(path.join(dir, 'packages/p/node_modules/b/i.js'));
  assert.equal(createDepCache({ root: cacheRoot, keyOf: () => 'a'.repeat(64), clone: null }).publish(dir), false);
  assert.equal(createDepCache({ root: cacheRoot, keyOf: () => null, clone: copy }).publish(dir), false);
  const logs = [];
  let n = 0;
  const flaky = (s, d) => { n += 1; return n === 2 ? false : copy(s, d); };
  assert.equal(createDepCache({
    root: cacheRoot, keyOf: () => 'a'.repeat(64), clone: flaky, log: (l) => logs.push(l),
  }).publish(dir), false);
  assert.deepEqual(fs.readdirSync(cacheRoot), []); // the half-made entry is gone
  assert.match(logs[0], /install cache not written: clone of packages\/p\/node_modules failed/);
  assert.equal(createDepCache({ root: cacheRoot, keyOf: () => 'a'.repeat(64), clone: copy }).publish(dir), true);
  const next = checkout(root, 'gate-2');
  n = 0;
  assert.equal(createDepCache({
    root: cacheRoot, keyOf: () => 'a'.repeat(64), clone: flaky, log: (l) => logs.push(l),
  }).restore(next), false);
  assert.equal(fs.existsSync(path.join(next, 'node_modules')), false); // what was placed is removed: setup installs it all
  fs.mkdirSync(path.join(next, 'node_modules')); // something already there: never overwritten
  assert.equal(createDepCache({ root: cacheRoot, keyOf: () => 'a'.repeat(64), clone: copy }).restore(next), false);
});

test('createDepCache keeps the newest entries and drops older ones past the limit', (t) => {
  const root = tmp(t);
  const cacheRoot = path.join(root, 'cache');
  const old = Date.now() / 1000 - 3 * 86400;
  for (let i = 0; i < 6; i += 1) {
    write(path.join(cacheRoot, String(i).repeat(64), 'manifest.json'), '{"dirs":["node_modules"]}');
    fs.utimesSync(path.join(cacheRoot, String(i).repeat(64)), old + i, old + i);
  }
  write(path.join(cacheRoot, '.tmp-dead-1-x', 'f'));
  fs.utimesSync(path.join(cacheRoot, '.tmp-dead-1-x'), old, old);
  const dir = checkout(root, 'gate');
  write(path.join(dir, 'node_modules/a/i.js'));
  assert.equal(createDepCache({ root: cacheRoot, keyOf: () => 'f'.repeat(64), clone: copy }).publish(dir), true);
  assert.deepEqual(fs.readdirSync(cacheRoot).sort(), ['3', '4', '5', 'f'].map((c) => c.repeat(64)));
});

test('defaultClone: cp -c on macOS, cp --reflink=always on Linux, none elsewhere; it really clones here', (t) => {
  assert.equal(defaultClone('win32'), null);
  const clone = defaultClone();
  if (!clone) return;
  const root = tmp(t);
  write(path.join(root, 'src/a/b.txt'), 'hello');
  const ok = clone(path.join(root, 'src'), path.join(root, 'dst'));
  if (!ok) return t.skip('this filesystem cannot clone (the cache is off here)');
  assert.equal(fs.readFileSync(path.join(root, 'dst/a/b.txt'), 'utf8'), 'hello');
  return undefined;
});

test('realKeyOf: keys from git ls-tree and the node and pnpm the step would run; no pnpm means no key', () => {
  const git = { raw: (repo, args) => { assert.deepEqual(args, ['ls-tree', '-r', '--full-tree', 'c'.repeat(40)]); return TREE; } };
  const exec = (cmd) => ({ node: 'v24.1.0\n', pnpm: '12.1.0\n' })[cmd];
  const keyOf = realKeyOf({
    git, repo: '/r', sha: 'c'.repeat(40), setup: 'pnpm install', env: {}, exec,
  });
  assert.equal(keyOf('/gate'), cacheKey({
    lsTree: TREE, setup: 'pnpm install', node: 'v24.1.0', pnpm: '12.1.0',
  }));
  const none = realKeyOf({
    git, repo: '/r', sha: 'c'.repeat(40), setup: 'pnpm install', env: {}, exec: () => { throw new Error('ENOENT'); },
  });
  assert.equal(none('/gate'), null);
});
