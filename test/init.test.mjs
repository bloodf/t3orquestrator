import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { withLock } from '../lib/lock.mjs';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-12T12:00:00Z');

async function setup({ git = false, files = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-init-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'proj');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(cwd, git ? '.git/info' : ''), { recursive: true });
  for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(cwd, f), c);
  return { root, home, cwd, git };
}

async function orq(args, s, { env = {}, deps = {}, stdin = '' } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) },
    stderr: { write: (x) => err.push(x) },
    env: { T3ORQ_HOME: s.home, ...env },
    cwd: s.cwd,
    now: () => NOW,
    stdin: async () => stdin,
    deps: {
      exec: (bin) => {
        if (bin !== 'git') return { code: 0, stdout: 't3 v1.2.3\n', stderr: '' };
        return s.git ? { code: 0, stdout: '.git\n', stderr: '' } : { code: 128, stdout: '', stderr: 'not a repo' };
      },
      which: (c) => (c === 'gh' ? '/bin/gh' : null),
      readMachine: () => ({ cores: 10, availableMemBytes: 12 * GIB, load1: 1 }),
      homedir: () => path.join(s.root, 'nohome'),
      ...deps,
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

test('init: prints facts, writes config, hints at sync', async () => {
  const s = await setup({ files: { 'package.json': '{"scripts":{"test":"x"}}', 'pnpm-lock.yaml': '' } });
  const r = await orq(['init'], s);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines[0], 't3=v1.2.3 cap=5');
  assert.equal(lines[1], 'slots: judge=self memory=file code-index=search git-host=gh');
  assert.equal(lines[2], 'checks: setup=pnpm install --frozen-lockfile full=pnpm run test');
  assert.equal(lines[3], 'autonomy=unset');
  assert.equal(lines[4], 'registry: 0 instances, 0 models, synced never');
  assert.equal(lines[5], 'next: pipe orchestrator_capabilities JSON to "orq sync"');
  const cfg = await read(path.join(s.cwd, '.orq/config.json'));
  assert.deepEqual(cfg.t3, { bin: 't3', version: 'v1.2.3' });
  assert.equal(cfg.checks.full, 'pnpm run test');
  assert.equal(cfg.slots['git-host'][0].name, 'gh');
});

test('init: idempotent, exclude line written once, existing values kept', async () => {
  const s = await setup({ git: true, files: { 'Cargo.toml': '' } });
  await orq(['init'], s);
  const cfgPath = path.join(s.cwd, '.orq/config.json');
  const cfg = await read(cfgPath);
  await fs.writeFile(cfgPath, JSON.stringify({ ...cfg, autonomy: 'draft', checks: { ...cfg.checks, full: 'my test' } }));
  const first = await fs.readFile(cfgPath, 'utf8');
  const r = await orq(['init'], s);
  assert.match(r.out, /autonomy=draft/);
  assert.match(r.out, /full=my test/);
  assert.deepEqual(await read(cfgPath), JSON.parse(first));
  const exclude = await fs.readFile(path.join(s.cwd, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '.orq/').length, 1);
});

test('init: linked worktree writes the exclude into the common git dir', async () => {
  const s = await setup({ files: { '.git': 'gitdir: /elsewhere\n' } });
  const common = path.join(s.root, 'main/.git');
  await fs.mkdir(path.join(common, 'info'), { recursive: true });
  await fs.writeFile(path.join(common, 'info/exclude'), '# x');
  const calls = [];
  const exec = (bin, a, o) => { calls.push([bin, a, o?.cwd]); return bin === 'git' ? { code: 0, stdout: `${common}\n`, stderr: '' } : { code: 0, stdout: 'v\n', stderr: '' }; };
  const r = await orq(['init'], s, { deps: { exec } });
  assert.equal(r.code, 0, r.err);
  assert.equal(await fs.readFile(path.join(common, 'info/exclude'), 'utf8'), '# x\n.orq/\n');
  await orq(['init'], s, { deps: { exec } });
  assert.equal((await fs.readFile(path.join(common, 'info/exclude'), 'utf8')).match(/\.orq\//g).length, 1);
  assert.deepEqual(calls.find((c) => c[0] === 'git').slice(1), [['rev-parse', '--git-common-dir'], s.cwd]);
});

test('init: git missing or not a repository skips the exclude step silently', async () => {
  const s = await setup();
  const throwing = await orq(['init'], s, { deps: { exec: (bin) => { if (bin === 'git') throw new Error('ENOENT'); return { code: 0, stdout: 'v\n', stderr: '' }; } } });
  assert.equal(throwing.code, 0, throwing.err);
  assert.equal((await orq(['init'], s)).code, 0);
});

test('init: a check the user cleared stays cleared', async () => {
  const s = await setup({ files: { 'Cargo.toml': '' } });
  assert.equal((await orq(['config', 'set', 'checks.full', 'null'], s)).code, 0);
  const r = await orq(['init'], s);
  assert.match(r.out, /^checks: setup=none full=none$/m);
  assert.equal((await read(path.join(s.cwd, '.orq/config.json'))).checks.full, null);
  const fresh = await setup({ files: { 'Cargo.toml': '' } });
  assert.match((await orq(['init'], fresh)).out, /full=cargo test/);
});

test('init: unreadable package.json degrades to a note', async () => {
  const s = await setup({ files: { 'package.json': '{nope' } });
  const r = await orq(['init'], s);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^checks: setup=none full=none$/m);
  assert.match(r.out, /^note: checks not detected \(.*package\.json.*\)$/m);
});

test('project config mutations wait for the project lock', async () => {
  const s = await setup();
  await orq(['init'], s);
  const lock = path.join(s.cwd, '.orq/lock');
  const cases = [
    ['init', []],
    ['config', ['set', 'base', 'trunk']],
    ['sync', []],
  ];
  for (const [cmd, extra] of cases) {
    const stdin = cmd === 'sync' ? JSON.stringify({ capabilities: { providers: [{ providerInstanceId: 'a', models: [] }] }, tools: [] }) : '';
    let release;
    const held = new Promise((r) => { release = r; });
    let started;
    const ready = new Promise((r) => { started = r; });
    const holder = withLock(lock, async () => { started(); await held; });
    await ready;
    const p = orq([cmd, ...extra], s, { stdin });
    const state = await Promise.race([p.then(() => 'done'), new Promise((r) => setTimeout(() => r('blocked'), 300))]);
    assert.equal(state, 'blocked', `${cmd} did not wait for the project lock`);
    release();
    await holder;
    assert.equal((await p).code, 0, cmd);
  }
});

test('init: worker guard when the thread has a lease', async () => {
  const s = await setup();
  await fs.mkdir(path.join(s.home, 'leases'), { recursive: true });
  await fs.writeFile(path.join(s.home, 'leases/thr-1.json'), '{}');
  const r = await orq(['init'], s, { env: { T3CODE_THREAD_ID: 'thr-1' } });
  assert.equal(r.code, 3);
  assert.equal(r.err, 'orq: this thread is a worker started by orq; follow your work order\n');
  await assert.rejects(fs.stat(path.join(s.cwd, '.orq/config.json')));
  const other = await orq(['init'], s, { env: { T3CODE_THREAD_ID: 'someone-else' } });
  assert.equal(other.code, 0);
});

test('init: no usable t3 records null and is not an error', async () => {
  const s = await setup();
  const r = await orq(['init'], s, { deps: { exec: () => ({ code: 1, stdout: '', stderr: 'nope' }) } });
  assert.equal(r.code, 0);
  assert.match(r.out, /^t3=missing cap=5/);
  assert.equal((await read(path.join(s.cwd, '.orq/config.json'))).t3, null);
  const thrown = await orq(['init'], s, { deps: { exec: () => { throw new Error('failed to run t3'); } } });
  assert.match(thrown.out, /^t3=missing/);
});

test('init: tries the next t3 candidate when the first fails', async () => {
  const s = await setup();
  const calls = [];
  const exec = (bin) => { calls.push(bin); return bin === '/env/t3' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: 'v9\n', stderr: '' }; };
  const r = await orq(['init'], s, { env: { T3CODE_CLI_PATH: '/env/t3' }, deps: { exec, exists: (f) => f === '/env/t3' } });
  assert.match(r.out, /^t3=v9 /);
  assert.equal(calls[0], '/env/t3');
  assert.equal((await read(path.join(s.cwd, '.orq/config.json'))).t3.bin, 't3');
});

test('init: keeps earlier mcp slot detections, reports stale registry', async () => {
  const s = await setup();
  await orq(['init'], s);
  const cfgPath = path.join(s.cwd, '.orq/config.json');
  const cfg = await read(cfgPath);
  cfg.slots.judge = [{ name: 'jev', kind: 'mcp', use: 'x' }, ...cfg.slots.judge];
  await fs.writeFile(cfgPath, JSON.stringify(cfg));
  await fs.writeFile(path.join(s.home, 'registry.json'), JSON.stringify({
    version: 1, syncedAt: NOW - 13 * 3600_000, instances: { a: {} }, models: { 'a::m': {}, 'a::n': {} },
  }));
  const r = await orq(['init'], s);
  assert.match(r.out, /judge=jev/);
  assert.match(r.out, /registry: 1 instances, 2 models, synced 13h ago/);
  assert.match(r.out, /next: pipe/);
});

test('init: fresh registry has no hint', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.home, 'registry.json'), JSON.stringify({ version: 1, syncedAt: NOW - 3600_000, instances: {}, models: {} }));
  const r = await orq(['init'], s);
  assert.match(r.out, /synced 1h ago/);
  assert.doesNotMatch(r.out, /next:/);
});
