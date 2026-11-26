// Plan claims: validated in the plan, published by `orq peers --self`, warned about (never refused) by `orq plan check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import {
  claimsError, cleanClaims, overlapWarnings, repoOf,
} from '../lib/claims.mjs';
import { cleanStatus } from '../lib/peers.mjs';
import { makeProject, sh, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const GIB = 1024 ** 3;

async function orq(args, p, { cwd = p.repo, ssh } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd, now: () => NOW, stdin: async () => '',
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }), exec: () => ({ code: 1, stdout: '', stderr: '' }), ...(ssh ? { ssh } : {}),
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const setClaims = async (repo, claims) => {
  const file = path.join(repo, '.orq', 'plan.json');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), claims }));
};

test('claims: numbers only; the repository from origin, or the folder name without one', () => {
  assert.equal(claimsError(undefined), null);
  assert.equal(claimsError([12, 7]), null);
  assert.match(claimsError(['#12']), /claims must be a list/);
  assert.match(claimsError([0]), /claims must be a list/);
  const fake = (url) => () => ({ code: 0, stdout: `${url}\n` });
  assert.equal(repoOf('/x', fake('git@github.com:acme/widgets.git')), 'acme/widgets');
  assert.equal(repoOf('/x', fake('https://github.com/acme/widgets')), 'acme/widgets');
  assert.equal(repoOf('/x/my proj', () => ({ code: 2, stdout: '' })), 'local/my-proj');
});

test('claims: a peer\'s list keeps only claim-shaped strings', () => {
  assert.deepEqual(cleanClaims(['acme/w#1', 'acme/w#x', 'rm -rf /', 3, 'a/b#0']), ['acme/w#1']);
  assert.deepEqual(cleanClaims('acme/w#1'), []);
  const status = {
    at: NOW, cores: 8, load: 0.1, cap: 4, active: 0, free: 4, held: false, protect: {}, claims: ['acme/w#4', '<b>'],
  };
  assert.deepEqual(cleanStatus(status).claims, ['acme/w#4']);
});

test('overlapWarnings: another project here or a peer holding the same claim; never this project itself', () => {
  const peers = [{ host: 'storm', ok: true, status: { claims: ['acme/w#5'] } }, { host: 'down', ok: false }];
  const local = [{ project: '/p/one', claim: 'acme/w#4' }, { project: '/p/two', claim: 'acme/w#4' }, { project: '/p/two', claim: 'acme/w#9' }];
  assert.deepEqual(overlapWarnings({
    cwd: '/p/one', repo: 'acme/w', claims: [4, 5, 6], local, peers,
  }), [
    'claim acme/w#4 is also claimed by the orchestrator in /p/two; check it is not the same work before it starts',
    'claim acme/w#5 is also claimed by an orchestrator on storm; check it is not the same work before it starts',
  ]);
});

test('plan check warns about a claim another checkout of the repo holds, and peers --self publishes both', async (t) => {
  const a = await makeProject(t, [unitSpec('a')]);
  sh(a.repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  // a second checkout of the same repository on this machine, sharing the machine home
  const b = await makeProject(t, [unitSpec('b')]);
  sh(b.repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const bOnA = { ...b, env: a.env };
  await setClaims(a.repo, [12, 30]);
  await setClaims(b.repo, [12]);
  const first = await orq(['plan', 'check'], a);
  assert.equal(first.code, 0);
  assert.doesNotMatch(first.out, /also claimed/); // b has not registered yet
  const second = await orq(['plan', 'check'], bOnA);
  assert.equal(second.code, 0);
  assert.match(second.out, new RegExp(`^warning: claim acme/widgets#12 is also claimed by the orchestrator in ${a.repo};`, 'm'));
  assert.match(second.out, /plan ok: 1 units/);
  const self = JSON.parse((await orq(['peers', '--self'], a)).out);
  assert.deepEqual(self.claims, ['acme/widgets#12', 'acme/widgets#30']);
  // the plan dropped its claims: nothing more is published or warned about
  await setClaims(a.repo, []);
  assert.deepEqual(JSON.parse((await orq(['peers', '--self'], a)).out).claims, ['acme/widgets#12']);
  assert.doesNotMatch((await orq(['plan', 'check'], bOnA)).out, /also claimed/);
  await setClaims(a.repo, ['12']);
  assert.match((await orq(['plan', 'check'], a)).out, /^error: claims must be a list of issue or pull request numbers$/m);
});

test('plan check asks the peers for their claims', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  sh(p.repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  await fs.writeFile(path.join(p.home, 'config.json'), JSON.stringify({ cap: 2, peers: [{ host: 'storm', ssh: 'storm' }] }));
  await setClaims(p.repo, [7]);
  const ssh = async () => ({
    code: 0,
    stdout: JSON.stringify({
      v: 1, host: 'storm', at: NOW, cores: 8, load: 0.1, cap: 4, active: 0, free: 4, held: false, protect: {}, claims: ['acme/widgets#7'],
    }),
  });
  assert.match((await orq(['plan', 'check'], p, { ssh })).out, /^warning: claim acme\/widgets#7 is also claimed by an orchestrator on storm;/m);
});
