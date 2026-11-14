import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit, defaultExec } from '../lib/git.mjs';
import {
  validSharePath, detectShares, eligibleShares, linkShares, shareLine, syncShareExclude,
} from '../lib/share.mjs';
import { sh } from './support/project.mjs';

const git = createGit({ exec: defaultExec });

// A repo whose main checkout has installed dependencies; the commit holds the manifests.
async function repo(t, { gitignore = 'node_modules/\n.venv/\n', lock = 'pnpm-lock.yaml' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-share-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  await fs.mkdir(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(dir, '.gitignore'), gitignore);
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x"}\n');
  if (lock) await fs.writeFile(path.join(dir, lock), 'lockfileVersion: 1\n');
  await fs.mkdir(path.join(dir, 'apps', 'shop'), { recursive: true });
  await fs.writeFile(path.join(dir, 'apps', 'shop', 'package.json'), '{"name":"shop"}\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  for (const d of ['node_modules/x', 'node_modules/x/node_modules/y', 'apps/shop/node_modules/z', '.venv/bin', 'vendor/v']) {
    await fs.mkdir(path.join(dir, d), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'y.js'), 'module.exports = 1;\n');
  return { root, dir, sha: sh(dir, 'rev-parse', 'HEAD') };
}

test('validSharePath: relative, inside the repository, not .git or .orq', () => {
  for (const ok of ['node_modules', 'apps/shop/node_modules', '.venv']) assert.equal(validSharePath(ok), true, ok);
  for (const bad of ['', '/abs/node_modules', '../x', 'a/../../x', '.git', '.git/x', '.orq', '.orq/gate', '~/x', 'a\\b']) {
    assert.equal(validSharePath(bad), false, bad);
  }
});

test('detectShares: ignored node_modules at any depth (not inside another) whose lockfile is pnpm\'s or bun\'s', async (t) => {
  const r = await repo(t);
  // .venv and vendor are never detected (their installers are untested); an explicit `share` can still list them
  assert.deepEqual(detectShares(r.dir, git), { paths: ['apps/shop/node_modules', 'node_modules'], why: null });
});

test('eligibleShares: only when the target exists and the governing manifests match the commit', async (t) => {
  const r = await repo(t);
  const paths = ['node_modules', 'apps/shop/node_modules', '.venv', 'missing/node_modules'];
  const unit = { id: 'u', paths: ['src/**'] };
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: r.sha, paths, unit, git,
  }), ['node_modules', 'apps/shop/node_modules', '.venv']);
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: r.sha, paths, unit: { ...unit, share: false }, git,
  }), []);
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: r.sha, paths, unit: { id: 'u', paths: ['package-lock.json', 'src/**'] }, git,
  }), []); // a unit that changes dependencies gets its own copy of every one
  await fs.writeFile(path.join(r.dir, 'pnpm-lock.yaml'), 'lockfileVersion: 2\n'); // the main checkout moved on
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: r.sha, paths, unit, git,
  }), ['.venv']); // the root lock governs every node_modules
});

test('linkShares: a symlink only where git ignores the path (its exclude entry is made first); never replaces', async (t) => {
  const r = await repo(t, { gitignore: 'node_modules/\n' });
  const wt = path.join(r.root, 'wt');
  sh(r.dir, 'worktree', 'add', '-q', '--detach', wt, r.sha);
  await fs.mkdir(path.join(wt, 'apps', 'shop', 'node_modules')); // something is already there
  // `node_modules/` (directories only) does not ignore a symlink: linkShares adds the anchored entry itself (S3)
  assert.deepEqual(linkShares({
    dir: wt, cwd: r.dir, paths: ['node_modules', 'apps/shop/node_modules', 'gone/node_modules'], git,
  }), ['node_modules']);
  assert.equal(fsSync.readlinkSync(path.join(wt, 'node_modules')), path.join(r.dir, 'node_modules'));
  assert.equal(fsSync.lstatSync(path.join(wt, 'apps', 'shop', 'node_modules')).isSymbolicLink(), false);
  assert.equal(sh(wt, 'status', '--porcelain', '--untracked-files=all'), ''); // the link can never be committed
  assert.equal(shareLine(['node_modules']), 'Dependencies: node_modules are linked from the main checkout. Do not install, delete or modify them; if you must change dependencies, report NEEDS_CONTEXT.');
});

test('S1: orq manages its exclude entries in a marked block: only ignored, untracked paths; rewritten, never touching other lines', async (t) => {
  const r = await repo(t);
  await fs.writeFile(path.join(r.dir, 'vendor', 'v', 'kept.txt'), 'tracked\n');
  sh(r.dir, 'add', '-f', 'vendor/v/kept.txt');
  sh(r.dir, 'commit', '-q', '-m', 'tracked vendor');
  const file = path.join(r.dir, '.git', 'info', 'exclude');
  await fs.writeFile(file, '# mine\n/build\n');
  syncShareExclude(r.dir, ['node_modules', 'apps/shop/node_modules', 'vendor', 'not/there'], git, { prune: true });
  assert.equal(await fs.readFile(file, 'utf8'), '# mine\n/build\n# orq share begin\n/node_modules\n/apps/shop/node_modules\n# orq share end\n');
  const before = fsSync.statSync(file).mtimeMs;
  await new Promise((res) => { setTimeout(res, 20); });
  syncShareExclude(r.dir, ['node_modules'], git); // linking time: adds what is missing, never removes
  assert.equal(fsSync.statSync(file).mtimeMs, before); // nothing to change: not written
  syncShareExclude(r.dir, ['node_modules'], git, { prune: true });
  assert.equal(await fs.readFile(file, 'utf8'), '# mine\n/build\n# orq share begin\n/node_modules\n# orq share end\n');
  syncShareExclude(r.dir, [], git, { prune: true });
  assert.equal(await fs.readFile(file, 'utf8'), '# mine\n/build\n');
});

test('S2: never through a symlinked parent, never a throw; the lockfile and manifest it relies on must exist', async (t) => {
  const r = await repo(t);
  // the commit makes `deps` a symlink to apps/shop: deps/node_modules lies beyond it
  await fs.symlink('apps/shop', path.join(r.dir, 'deps'));
  sh(r.dir, 'add', 'deps');
  sh(r.dir, 'commit', '-q', '-m', 'symlinked dir');
  const head = sh(r.dir, 'rev-parse', 'HEAD');
  await fs.mkdir(path.join(r.dir, 'apps', 'shop', '.venv'));
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: head, paths: ['deps/node_modules', 'deps/.venv', 'node_modules'], git,
  }), ['node_modules']); // deps/.venv has no governing files: only the symlink rule stops it
  const wt = path.join(r.root, 'wt');
  sh(r.dir, 'worktree', 'add', '-q', '--detach', wt, head);
  assert.deepEqual(linkShares({
    dir: wt, cwd: r.dir, paths: ['deps/node_modules'], git,
  }), []); // refused, not thrown (git check-ignore exits 128 "beyond a symbolic link" there)
  const broken = { ...git, ignored: () => { throw new Error('git check-ignore failed (exit 128)'); } };
  assert.deepEqual(linkShares({
    dir: wt, cwd: r.dir, paths: ['node_modules'], git: broken,
  }), []);
  // no package.json next to the node_modules, in the commit or the main checkout: nothing says what it holds
  await fs.mkdir(path.join(r.dir, 'libs', 'x', 'node_modules'), { recursive: true });
  assert.deepEqual(eligibleShares({
    cwd: r.dir, commit: head, paths: ['libs/x/node_modules'], git,
  }), []);
});

test('removing a worktree or a gate directory with links never touches the shared directory', async (t) => {
  const r = await repo(t);
  const keep = path.join(r.dir, 'node_modules', 'x', 'y.js');
  const linked = (name) => {
    const wt = path.join(r.root, name);
    sh(r.dir, 'worktree', 'add', '-q', '--detach', wt, r.sha);
    assert.deepEqual(linkShares({
      dir: wt, cwd: r.dir, paths: ['node_modules'], git,
    }), ['node_modules']);
    return wt;
  };
  const archived = linked('wt1');
  assert.deepEqual(git.tryRemoveWorktree(r.dir, archived), { ok: true }); // archive: no --force, links do not make it dirty
  await fs.stat(keep);
  git.removeWorktree(r.dir, linked('wt2')); // the gate: --force
  await fs.stat(keep);
  const left = linked('wt3');
  sh(r.dir, 'worktree', 'prune');
  await fs.rm(left, { recursive: true, force: true }); // the R1 leftover cleanup
  await fs.stat(keep);
  assert.equal(fsSync.existsSync(left), false);
});

const { run } = await import('../lib/cli.mjs');
async function orqIn(dir, home, args) {
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { T3ORQ_HOME: home }, cwd: dir, now: () => 0,
    stdin: async () => '',
    deps: {
      exec: (bin, args2, opts) => (bin === 'git' ? defaultExec(bin, args2, opts) : { code: 0, stdout: 't3 v1\n', stderr: '' }),
      which: () => null, homedir: () => home, readMachine: () => ({ cores: 8, availableMemBytes: 2 ** 34, load1: 0 }),
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('init detects share once, prints it and makes the links ignorable; config set changes it; null turns it off', async (t) => {
  const r = await repo(t);
  const home = path.join(r.root, 'home');
  await fs.mkdir(home);
  const first = await orqIn(r.dir, home, ['init']);
  assert.equal(first.code, 0, first.err);
  assert.ok(first.out.split('\n').includes('share: apps/shop/node_modules, node_modules'), first.out);
  const cfg = JSON.parse(await fs.readFile(path.join(r.dir, '.orq', 'config.json'), 'utf8'));
  assert.deepEqual(cfg.share, ['apps/shop/node_modules', 'node_modules']);
  const exclude = (await fs.readFile(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8')).split('\n');
  assert.ok(['/apps/shop/node_modules', '/node_modules'].every((l) => exclude.includes(l)));
  assert.equal((await orqIn(r.dir, home, ['config', 'set', 'share', 'node_modules'])).code, 0);
  assert.ok((await orqIn(r.dir, home, ['init'])).out.split('\n').includes('share: node_modules')); // set by you: not detected again
  assert.equal((await orqIn(r.dir, home, ['config', 'set', 'share', 'null'])).code, 0);
  assert.ok((await orqIn(r.dir, home, ['init'])).out.split('\n').includes('share: none'));
  assert.equal((await orqIn(r.dir, home, ['config', 'set', 'share', '.git'])).code, 1);
});

test('only node_modules governed by a pnpm or bun lockfile is shared: npm, yarn or no lockfile never, whatever share says', async (t) => {
  const cases = [
    ['pnpm-lock.yaml', ['node_modules'], null],
    ['bun.lock', ['node_modules'], null],
    ['bun.lockb', ['node_modules'], null],
    ['package-lock.json', [], 'npm projects are not shared: "npm ci" empties a linked node_modules'],
    ['npm-shrinkwrap.json', [], 'npm projects are not shared: "npm ci" empties a linked node_modules'],
    ['yarn.lock', [], 'yarn is untested'],
    [null, [], 'no lockfile'],
  ];
  for (const [lock, want, why] of cases) {
    const r = await repo(t, { lock });
    assert.deepEqual(eligibleShares({
      cwd: r.dir, commit: r.sha, paths: ['node_modules'], git,
    }), want, String(lock));
    assert.deepEqual(detectShares(r.dir, git), { paths: want.length ? ['apps/shop/node_modules', 'node_modules'] : [], why }, String(lock));
  }
  // a pnpm lockfile next to an npm one is still an npm project; the nested app uses the root lockfile
  const mixed = await repo(t);
  await fs.writeFile(path.join(mixed.dir, 'apps', 'shop', 'package-lock.json'), '{}\n');
  sh(mixed.dir, 'add', '-A');
  sh(mixed.dir, 'commit', '-q', '-m', 'npm in shop');
  const head = sh(mixed.dir, 'rev-parse', 'HEAD');
  assert.deepEqual(eligibleShares({
    cwd: mixed.dir, commit: head, paths: ['node_modules', 'apps/shop/node_modules', '.venv'], git,
  }), ['node_modules', '.venv']); // .venv: only because share lists it explicitly
});

test('init explains a node_modules it will not share', async (t) => {
  const r = await repo(t, { lock: 'package-lock.json' });
  const home = path.join(r.root, 'home');
  await fs.mkdir(home);
  const out = (await orqIn(r.dir, home, ['init'])).out.split('\n');
  assert.ok(out.includes('share: none (npm projects are not shared: "npm ci" empties a linked node_modules)'), out.join('\n'));
});

test('S1: config set share refuses a directory git tracks files under; init drops it with a note', async (t) => {
  const r = await repo(t);
  const home = path.join(r.root, 'home');
  await fs.mkdir(home);
  await fs.writeFile(path.join(r.dir, 'vendor', 'v', 'kept.txt'), 'tracked\n');
  sh(r.dir, 'add', 'vendor/v/kept.txt');
  sh(r.dir, 'commit', '-q', '-m', 'tracked vendor');
  const set = await orqIn(r.dir, home, ['config', 'set', 'share', 'node_modules,vendor']);
  assert.deepEqual([set.code, set.err], [1, 'orq: share: "vendor" has tracked files; only untracked, ignored directories can be shared\n']);
  const cfgFile = path.join(r.dir, '.orq', 'config.json');
  assert.equal(fsSync.existsSync(cfgFile), false); // refused before anything was written
  await fs.mkdir(path.dirname(cfgFile), { recursive: true });
  await fs.writeFile(cfgFile, JSON.stringify({ share: ['node_modules', 'vendor'] })); // written by hand
  const init = await orqIn(r.dir, home, ['init']);
  assert.ok(init.out.split('\n').includes('note: share: "vendor" has tracked files; only untracked, ignored directories can be shared'), init.out);
  assert.doesNotMatch(await fs.readFile(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8'), /\/vendor/);
});
