import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGit, defaultExec } from '../lib/git.mjs';
import { repairShares } from '../lib/share-repair.mjs';
import { writeLease } from '../lib/leases.mjs';
import { run } from '../lib/cli.mjs';
import { sh } from './support/project.mjs';

const git = createGit({ exec: defaultExec });
const ESLINT = '.pnpm/eslint@9/node_modules/eslint';
const SCOPED = '.pnpm/@s+a@1/node_modules/@s/a';

// What pnpm did in a worktree whose node_modules linked the main one: a link written into the main directory,
// relative from there to the entry as seen through the worktree's own path.
function through(nm, at, checkout, entry, share = 'node_modules') {
  const file = path.join(nm, at);
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.symlinkSync(path.relative(path.dirname(file), path.join(checkout, share, entry)), file);
  return file;
}

// A pnpm project; T3-style worktrees on orq/* branches beside each other: `live` (its own node_modules) stays,
// `gone` (linked to the main node_modules) is removed after pnpm wrote through it.
async function world(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-repair-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.orq/\n');
  await fs.writeFile(path.join(repo, 'package.json'), '{}\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  const nm = path.join(repo, 'node_modules');
  for (const d of [ESLINT, SCOPED]) {
    await fs.mkdir(path.join(nm, d), { recursive: true });
    await fs.writeFile(path.join(nm, d, 'index.js'), 'ok\n');
  }
  const wts = path.join(root, 'worktrees');
  const live = path.join(wts, 'orq-live');
  const gone = path.join(wts, 'orq-gone');
  sh(repo, 'worktree', 'add', '-q', '-b', 'orq/p/live', live);
  sh(repo, 'worktree', 'add', '-q', '-b', 'orq/p/gone', gone);
  await fs.mkdir(path.join(live, 'node_modules', 'bar'), { recursive: true }); // its own install
  await fs.symlink(nm, path.join(gone, 'node_modules'));
  const gate = path.join(repo, '.orq', 'gate', 'u');
  return {
    root, repo, nm, live, gone, gate, worktrees: () => git.listWorktrees(repo).filter((w) => w.branch?.startsWith('refs/heads/orq/')).map((w) => w.path),
  };
}

const removeGone = async (w) => {
  sh(w.repo, 'worktree', 'remove', '--force', w.gone);
};

test('share repair: links into a removed worktree or gate point back inside the main checkout; dry run changes nothing', async (t) => {
  const w = await world(t);
  await fs.mkdir(w.gate, { recursive: true });
  await fs.symlink(w.nm, path.join(w.gate, 'node_modules'));
  const bad = [
    through(w.nm, 'eslint', w.gone, ESLINT),
    through(w.nm, '.pnpm/node_modules/@s/a', w.gone, SCOPED),
    through(w.nm, '.pnpm/node_modules/eslint', w.gate, ESLINT),
  ];
  const worktrees = w.worktrees();
  await removeGone(w);
  await fs.rm(w.gate, { recursive: true });
  assert.equal(fsSync.existsSync(path.join(w.nm, 'eslint', 'index.js')), false); // the reported failure
  const dry = repairShares({
    cwd: w.repo, paths: ['node_modules'], worktrees: w.worktrees(), dryRun: true,
  });
  assert.equal(dry.repaired.length, 3);
  assert.equal(fsSync.existsSync(bad[0]), false);
  const r = repairShares({ cwd: w.repo, paths: ['node_modules'], worktrees });
  assert.deepEqual(r.repaired.map((x) => x.link).sort(), bad.map((b) => path.relative(w.repo, b)).sort());
  for (const b of bad) assert.equal(path.isAbsolute(fsSync.readlinkSync(b)), false);
  assert.equal(await fs.readFile(path.join(w.nm, 'eslint', 'index.js'), 'utf8'), 'ok\n');
  assert.equal(await fs.readFile(path.join(w.nm, '.pnpm/node_modules/@s/a/index.js'), 'utf8'), 'ok\n');
  assert.equal(repairShares({ cwd: w.repo, paths: ['node_modules'], worktrees }).repaired.length, 0);
});

test('finding 1: a shared directory reached through a symlink out of the project is never walked', async (t) => {
  const w = await world(t);
  const outside = path.join(w.root, 'outside');
  await fs.mkdir(path.join(outside, 'node_modules'), { recursive: true });
  const ext = through(path.join(outside, 'node_modules'), 'eslint', w.gone, ESLINT);
  const before = fsSync.readlinkSync(ext);
  await fs.symlink(outside, path.join(w.repo, 'ext'));
  await fs.symlink(path.join(outside, 'node_modules'), path.join(w.repo, 'nm2'));
  const worktrees = w.worktrees();
  await removeGone(w);
  const r = repairShares({ cwd: w.repo, paths: ['ext/node_modules', 'nm2'], worktrees });
  assert.deepEqual(r.refused, ['ext/node_modules: not a plain directory inside the project', 'nm2: not a plain directory inside the project']);
  assert.equal(fsSync.readlinkSync(ext), before);
});

test('finding 2: only links into a known orq checkout that linked the main directory; no self or cyclic target', async (t) => {
  const w = await world(t);
  await fs.mkdir(path.join(w.repo, 'other', 'node_modules', 'foo'), { recursive: true });
  await fs.mkdir(path.join(w.nm, 'foo'), { recursive: true }); // same name in the main directory: must not matter
  const keep = {
    [path.join(w.nm, 'dep-in-project')]: '../other/node_modules/foo', // an unrelated dependency inside the project
    [path.join(w.nm, 'bar')]: path.relative(w.nm, path.join(w.live, 'node_modules', 'bar')), // a checkout with its own install
    [path.join(w.nm, 'nowhere')]: '/nonexistent/x/node_modules/eslint', // not a known orq checkout
  };
  for (const [at, to] of Object.entries(keep)) await fs.symlink(to, at);
  const self = through(w.nm, '.pnpm/node_modules/self', w.gone, '.pnpm/node_modules/self');
  const cyc = through(w.nm, 'cyc', w.gone, 'cyc-b');
  await fs.symlink('cyc', path.join(w.nm, 'cyc-b')); // cyc-b -> cyc -> (through the worktree) cyc-b
  const worktrees = w.worktrees();
  await removeGone(w);
  const r = repairShares({ cwd: w.repo, paths: ['node_modules'], worktrees });
  assert.deepEqual(r.repaired, []);
  for (const [at, to] of Object.entries(keep)) assert.equal(fsSync.readlinkSync(at), to);
  assert.ok(fsSync.readlinkSync(self).includes('orq-gone'));
  assert.ok(fsSync.readlinkSync(cyc).includes('orq-gone'));
  assert.equal(r.skipped['that checkout has its own dependencies'], 1);
  assert.equal(r.skipped['would point at itself'], 1);
  assert.equal(r.skipped['no such entry in the main checkout'], 1); // the cycle does not resolve
});

test('finding 3: a link changed between the read and the swap is left as it is now', async (t) => {
  const w = await world(t);
  const link = through(w.nm, 'eslint', w.gone, ESLINT);
  const worktrees = w.worktrees();
  await removeGone(w);
  const r = repairShares({
    cwd: w.repo,
    paths: ['node_modules'],
    worktrees,
    beforeSwap: (at) => { fsSync.rmSync(at); fsSync.writeFileSync(at, 'written by pnpm meanwhile\n'); },
  });
  assert.deepEqual(r.repaired, []);
  assert.equal(r.skipped['changed while repairing'], 1);
  assert.equal(fsSync.readFileSync(link, 'utf8'), 'written by pnpm meanwhile\n');
});

test('finding 4: the temporary link never replaces an existing file', async (t) => {
  const w = await world(t);
  through(w.nm, 'eslint', w.gone, ESLINT);
  const old = path.join(w.nm, `eslint.orq-repair-${process.pid}`); // the old fixed name
  await fs.writeFile(old, 'mine\n');
  const worktrees = w.worktrees();
  await removeGone(w);
  assert.equal(repairShares({ cwd: w.repo, paths: ['node_modules'], worktrees }).repaired.length, 1);
  assert.equal(await fs.readFile(old, 'utf8'), 'mine\n');
  assert.deepEqual((await fs.readdir(w.nm)).filter((n) => n.includes('.orq-repair-')), [path.basename(old)]);
});

async function orq(w, home, args, deps = {}) {
  const out = []; const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { T3ORQ_HOME: home }, cwd: w.repo, now: () => 1000,
    stdin: async () => '', deps: { exec: () => ({ code: 0, stdout: '', stderr: '' }), isAlive: () => false, ...deps },
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('finding 5: orq share repair runs only on demand and refuses while a thread of the project runs', async (t) => {
  const w = await world(t);
  const home = path.join(w.root, 'home');
  await fs.mkdir(path.join(w.repo, '.orq'), { recursive: true });
  await fs.writeFile(path.join(w.repo, '.orq', 'config.json'), JSON.stringify({ share: ['node_modules'] }));
  const link = through(w.nm, 'eslint', w.gone, ESLINT);
  sh(w.repo, 'worktree', 'remove', '--force', w.gone); // `live` stays registered: its directory names the others
  await writeLease(path.join(home, 'leases'), {
    threadId: 'th1', project: w.repo, unit: 'a', instance: 'i', model: 'm', startedAt: 1000, heartbeatAt: 1000,
  });
  const busy = await orq(w, home, ['share', 'repair']);
  assert.equal(busy.code, 1, busy.out);
  assert.match(busy.err, /refused: 1 threads and 0 gates of this project are running/);
  assert.equal(fsSync.existsSync(link), false);
  const dry = await orq(w, home, ['share', 'repair', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.ok(dry.out.startsWith('would repair 1 links\n  node_modules/eslint -> '), dry.out);
  await fs.rm(path.join(home, 'leases'), { recursive: true });
  // the check and the repair run under the machine lock every thread and gate reservation takes: none starts meanwhile
  const held = [];
  const done = await orq(w, home, ['share', 'repair'], { beforeSwap: () => held.push(fsSync.existsSync(path.join(home, 'lock'))) });
  assert.deepEqual(held, [true]);
  assert.equal(done.code, 0, done.err);
  assert.ok(done.out.startsWith('repaired 1 links'), done.out);
  assert.equal(await fs.readFile(path.join(link, 'index.js'), 'utf8'), 'ok\n');
});
