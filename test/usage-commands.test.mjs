import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { run } from '../lib/cli.mjs';
import { commit } from '../lib/ledger.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

// Account usage end to end: T3's provider status caches, as T3 writes them, under a fake T3CODE_HOME.
const cache = (id) => readFileSync(new URL(`./fixtures/t3-caches/${id}.json`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-16T20:10:00Z');
const GIB = 1024 ** 3;
const A = 'a'.repeat(40);

async function orq(args, p, { stdin = '', t3home = p.t3home } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) },
    stderr: { write: (x) => err.push(x) },
    env: { ...p.env, ...(t3home ? { T3CODE_HOME: t3home } : {}) },
    cwd: p.repo,
    now: () => NOW,
    stdin: async () => stdin,
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
      exec: () => ({ code: 0, stdout: '[]', stderr: '' }),
      which: () => null,
      homedir: () => path.join(p.root, 'nohome'),
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

// pa runs on the exhausted codex account, pb on the healthy one (codex-2 is signed out: use the claude cache)
async function project(t) {
  const p = await makeProject(t, [unitSpec('a')]);
  const t3home = path.join(p.root, 't3');
  await fs.mkdir(path.join(t3home, 'caches'), { recursive: true });
  await fs.writeFile(path.join(t3home, 'caches', 'pa.json'), cache('codex'));
  await fs.writeFile(path.join(t3home, 'caches', 'pb.json'), cache('claudeAgent'));
  await commit(p.repo, () => [{
    type: 'plan-started', unit: null, at: NOW, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration',
  }]);
  return { ...p, t3home };
}

const usageLine = 'usage: pa 100% primary resets 2026-11-19T19:38:58.000Z; pb 66% seven_day_fable resets 2026-11-17T07:00:00.032Z';

test('status: usage per instance; a model at its limit cools until its reset', async (t) => {
  const p = await project(t);
  const r = await orq(['status'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines.includes(usageLine), r.out);
  assert.ok(lines.includes('providers: 2 usable (pa, pb); 0 disabled in T3; 0 disabled by you; 0 cooling'), r.out);
  const json = JSON.parse((await orq(['status', '--json'], p)).out);
  assert.equal(json.usage.pa.windows[0].used, 100);
});

test('route: the exhausted model is skipped and the rest carry their headroom', async (t) => {
  const p = await project(t);
  const r = await orq(['route', '--job', 'implement'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.ok(lines.every((l) => / pb /.test(l)), r.out);
  assert.match(lines[0], / headroom=34%/);
});

test('sync records T3CODE_HOME as the machine t3Home, which later commands read without it', async (t) => {
  const p = await project(t);
  const caps = JSON.stringify({ providers: ['pa', 'pb'].map((id) => ({ providerInstanceId: id, models: ['m2'], constraints: [] })) });
  assert.equal((await orq(['sync'], p, { stdin: caps })).code, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(p.home, 'config.json'), 'utf8')).t3Home, p.t3home);
  const bare = { ...p, env: { T3ORQ_HOME: p.home } };
  assert.ok((await orq(['status'], bare, { t3home: null })).out.split('\n').includes(usageLine));
});

test('status --json lists only instances with something to say', async (t) => {
  const p = await project(t);
  await fs.writeFile(path.join(p.t3home, 'caches', 'pb.json'), cache('kimi'));
  assert.deepEqual(Object.keys(JSON.parse((await orq(['status', '--json'], p)).out).usage), ['pa']);
});

test('sync prints the usage line', async (t) => {
  const p = await project(t);
  const caps = JSON.stringify({ providers: ['pa', 'pb'].map((id) => ({ providerInstanceId: id, models: ['m2'], constraints: [] })) });
  const r = await orq(['sync'], p, { stdin: caps });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').includes(usageLine), r.out);
});

test('a signed-out instance is down; no plan still shows usage', async (t) => {
  const p = await project(t);
  await fs.writeFile(path.join(p.t3home, 'caches', 'pb.json'), cache('codex-2'));
  await fs.rm(path.join(p.repo, '.orq', 'plan.json'));
  const r = await orq(['status'], p);
  assert.match(r.out, /^usage: pa 100% primary resets [^;]+; pb down$/m);
  assert.equal(JSON.parse((await orq(['status', '--json'], p)).out).usage.pb.down, true);
  assert.equal((await orq(['route', '--job', 'implement'], p)).code, 4);
});

test('no T3 usage: the searched directory is named, no usage key, routing as before', async (t) => {
  const p = await project(t);
  const none = { t3home: path.join(p.root, 'empty') };
  const r = await orq(['status'], p, none);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.split('\n').includes(`usage: no T3 provider cache in ${path.join(p.root, 'empty', 'caches')}`), r.out);
  assert.equal('usage' in JSON.parse((await orq(['status', '--json'], p, none)).out), false);
  assert.match((await orq(['route', '--job', 'implement'], p, none)).out, /^1 pa m2 tier=2 family=f unconfirmed\n/);
});
