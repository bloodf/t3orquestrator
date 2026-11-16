import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { run } from '../lib/cli.mjs';
import { commit } from '../lib/ledger.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

// Account usage end to end: a fake CLIProxyAPI serving the redacted real auth-files response.
const FILES = JSON.parse(readFileSync(new URL('./fixtures/cliproxy-auth-files.json', import.meta.url), 'utf8')).files;
const NOW = Date.parse('2026-11-16T15:00:00Z');
const GIB = 1024 ** 3;
const A = 'a'.repeat(40);
const iso = (s) => new Date(s * 1000).toISOString();
const USAGE = {
  url: 'http://127.0.0.1:8317', keyEnv: 'ORQ_CLIPROXY_KEY', accounts: { pa: 'codex-c.json', pb: 'codex-b@example.invalid' },
};

async function orq(args, p, { fetch, stdin = '' } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) },
    stderr: { write: (x) => err.push(x) },
    env: { ...p.env, ORQ_CLIPROXY_KEY: 'test-key' },
    cwd: p.repo,
    now: () => NOW,
    stdin: async () => stdin,
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
      exec: () => ({ code: 0, stdout: '[]', stderr: '' }),
      which: () => null,
      fetch: fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({ files: FILES }) })),
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

async function project(t, usage = USAGE) {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.writeFile(path.join(p.home, 'config.json'), JSON.stringify({ cap: 2, ...(usage ? { usage } : {}) }));
  await commit(p.repo, () => [{
    type: 'plan-started', unit: null, at: NOW, planId: 'p1', baseSha: A, integrationBranch: 'orq/p1/integration',
  }]);
  return p;
}

const usageLine = `usage: pa 95% resets ${iso(1795277460)}; pb 6% resets ${iso(1795277242)}`;

test('status: usage and reset per instance; an instance at its limit cools until its reset', async (t) => {
  const p = await project(t);
  const r = await orq(['status'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.ok(lines.includes('providers: 1 usable (pb); 0 disabled in T3; 0 disabled by you; 1 cooling (pa)'), r.out);
  assert.ok(lines.includes(usageLine), r.out);
  assert.ok(lines.includes(`cooling: pa until ${iso(1795277460)}`), r.out);
});

test('route: the exhausted instance is skipped and the rest carry their headroom', async (t) => {
  const p = await project(t);
  const r = await orq(['route', '--job', 'implement'], p);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.ok(lines.every((l) => / pb /.test(l)), r.out);
  assert.match(lines[0], / headroom=94%/);
});

test('sync fetches fresh usage and prints it', async (t) => {
  const p = await project(t);
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ files: FILES }) }; };
  await orq(['status'], p, { fetch });
  const caps = JSON.stringify({ providers: ['pa', 'pb'].map((id) => ({ providerInstanceId: id, models: ['m2'], constraints: [] })) });
  const r = await orq(['sync'], p, { fetch, stdin: caps });
  assert.equal(r.code, 0, r.err);
  assert.equal(calls, 2); // sync ignores the cache status just wrote
  assert.ok(r.out.split('\n').includes(usageLine), r.out);
});

test('proxy down: the last known usage stays, and status says the fetch failed', async (t) => {
  const p = await project(t);
  await orq(['sync'], p, { stdin: JSON.stringify({ providers: [{ providerInstanceId: 'pa', models: ['m2'] }, { providerInstanceId: 'pb', models: ['m2'] }] }) });
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await fs.writeFile(path.join(p.home, 'usage.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(path.join(p.home, 'usage.json'), 'utf8')), fetchedAt: 0 }));
  const r = await orq(['status'], p, { fetch: down });
  assert.ok(r.out.includes(`usage (last fetch failed: fetch failed (ECONNREFUSED)): pa 95% resets ${iso(1795277460)}`), r.out);
  assert.match(r.out, /1 cooling \(pa\)/);
  await fs.rm(path.join(p.home, 'usage.json'));
  assert.match((await orq(['status'], p, { fetch: down })).out, /^usage \(last fetch failed: fetch failed \(ECONNREFUSED\)\): nothing read yet$/m);
});

test('no usage configured: no fetch, no usage line, no usage file', async (t) => {
  const p = await project(t, null);
  const fetch = async () => assert.fail('fetched without a usage config');
  const r = await orq(['status'], p, { fetch });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /usage/);
  assert.equal('usage' in JSON.parse((await orq(['status', '--json'], p, { fetch })).out), false);
  assert.match((await orq(['route', '--job', 'implement'], p, { fetch })).out, /^1 pa m2 /);
  assert.equal(existsSync(path.join(p.home, 'usage.json')), false);
});
