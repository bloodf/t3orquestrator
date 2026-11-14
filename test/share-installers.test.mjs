// What real package managers do to a node_modules that is a link to the main checkout's directory. These are
// facts the gate's and the docs' rules rest on. Each test is skipped when its tool is not on PATH. No network:
// the only dependency is a `file:` package inside the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sh } from './support/project.mjs';

const version = (tool) => {
  const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').at(-1) : null;
};
const runIn = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 120_000 });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
};

// A main checkout installed with `tool`, the install committed with its lockfile, then a marker and a fake package
// added to the main checkout's node_modules; and a worktree of that commit whose node_modules is a link to it.
async function fixture(t, tool, install) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `orq-${tool}-`)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  await fs.mkdir(path.join(main, 'pkgs', 'dep'), { recursive: true });
  sh(main, 'init', '-q', '-b', 'main');
  sh(main, 'config', 'user.name', 'Test User');
  sh(main, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(main, 'pkgs', 'dep', 'package.json'), '{"name":"dep","version":"1.0.0"}\n');
  await fs.writeFile(path.join(main, 'pkgs', 'dep', 'index.js'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(main, 'package.json'), '{"name":"app","version":"1.0.0","dependencies":{"dep":"file:./pkgs/dep"}}\n');
  await fs.writeFile(path.join(main, '.gitignore'), 'node_modules\n');
  runIn(main, tool, install);
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'deps');
  await fs.writeFile(path.join(main, 'node_modules', '.orq-marker'), '');
  await fs.mkdir(path.join(main, 'node_modules', 'x'));
  await fs.writeFile(path.join(main, 'node_modules', 'x', 'y.js'), '1\n');
  const wt = path.join(root, 'wt');
  sh(main, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  await fs.symlink(path.join(main, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
  return { main, wt };
}

const intact = (main) => fsSync.existsSync(path.join(main, 'node_modules', '.orq-marker'))
  && fsSync.existsSync(path.join(main, 'node_modules', 'x', 'y.js'));
const isLink = (p) => fsSync.lstatSync(p).isSymbolicLink();

const NPM = version('npm');
test(`npm ${NPM ?? '(not installed)'}: npm ci empties the linked directory, then replaces the link with its own`, { skip: !NPM }, async (t) => {
  const { main, wt } = await fixture(t, 'npm', ['install', '--offline', '--no-audit', '--no-fund']);
  runIn(wt, 'npm', ['ci', '--offline', '--no-audit', '--no-fund']);
  assert.equal(isLink(path.join(wt, 'node_modules')), false);
  assert.equal(intact(main), false); // destructive: this is why the gate never links when a setup step runs
  assert.deepEqual(fsSync.readdirSync(path.join(main, 'node_modules')), []);
});

test(`npm ${NPM ?? '(not installed)'}: npm install replaces the link with its own directory and leaves the main one alone`, { skip: !NPM }, async (t) => {
  const { main, wt } = await fixture(t, 'npm', ['install', '--offline', '--no-audit', '--no-fund']);
  runIn(wt, 'npm', ['install', '--offline', '--no-audit', '--no-fund']);
  assert.equal(isLink(path.join(wt, 'node_modules')), false);
  assert.equal(intact(main), true);
});

const PNPM = version('pnpm');
for (const args of [['install', '--frozen-lockfile', '--offline'], ['install', '--offline']]) {
  test(`pnpm ${PNPM ?? '(not installed)'}: pnpm ${args.join(' ')} keeps the link and writes through it, keeping what is there`, { skip: !PNPM }, async (t) => {
    const { main, wt } = await fixture(t, 'pnpm', ['install', '--offline']);
    runIn(wt, 'pnpm', args);
    assert.equal(isLink(path.join(wt, 'node_modules')), true);
    assert.equal(intact(main), true);
  });
}

test(`pnpm ${PNPM ?? '(not installed)'}: a modules directory recorded for another store or layout is not purged through the link`, { skip: !PNPM }, async (t) => {
  for (const change of [(j) => ({ ...j, storeDir: '/nonexistent/other-store/v11' }), (j) => ({ ...j, layoutVersion: 1 })]) {
    const { main, wt } = await fixture(t, 'pnpm', ['install', '--offline']);
    const file = path.join(main, 'node_modules', '.modules.yaml');
    await fs.writeFile(file, JSON.stringify(change(JSON.parse(await fs.readFile(file, 'utf8')))));
    runIn(wt, 'pnpm', ['install', '--frozen-lockfile', '--offline']);
    assert.equal(intact(main), true);
  }
});

const BUN = version('bun');
for (const args of [['install'], ['install', '--frozen-lockfile']]) {
  test(`bun ${BUN ?? '(not installed)'}: bun ${args.join(' ')} keeps the link and leaves the main directory's files`, { skip: !BUN }, async (t) => {
    const { main, wt } = await fixture(t, 'bun', ['install']);
    runIn(wt, 'bun', args);
    assert.equal(isLink(path.join(wt, 'node_modules')), true);
    assert.equal(intact(main), true);
  });
}
