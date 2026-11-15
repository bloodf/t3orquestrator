// orq ship: real git against a local bare remote, a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { defaultExec } from '../lib/git.mjs';
import { commit, readState } from '../lib/ledger.mjs';
import {
  makeProject, unitSpec, commitOn, sh,
} from './support/project.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const GIB = 1024 ** 3;
const URL1 = 'https://example.invalid/o/r/pull/12';

// gh: no PR for any branch until one is created (or `prs` presets one); a branch's PR reports the oid the remote
// branch holds; `pr view <url>` answers `state`
function fakeGh({ state = 'MERGED', remote = null, prs = {} } = {}) {
  const gh = { calls: [], prs: { ...prs } };
  gh.exec = (bin, args) => {
    gh.calls.push(args);
    const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'pr' && args[1] === 'create') {
      gh.prs[args[args.indexOf('--head') + 1]] = { url: URL1, state: 'OPEN' };
      return ok(`${URL1}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'view' && args[2].startsWith('https://')) return ok(JSON.stringify({ state, mergedAt: null }));
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = gh.prs[args[2]];
      return pr ? ok(JSON.stringify({ ...pr, headRefOid: sh(remote, 'rev-parse', `refs/heads/${args[2]}`) })) : { code: 1, stdout: '', stderr: 'no pull requests found' };
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return gh;
}

async function orq(args, p, deps = {}, over = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => NOW, sleep: async () => {},
    deps: { readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }), ...deps }, ...over,
  });
  return { code, out: out.join(''), err: err.join('') };
}

const append = (p, ...events) => commit(p.repo, () => events.map((e) => ({ at: NOW, ...e })));
const through = (u, head) => [
  {
    type: 'launched', unit: u, attempt: 1, threadId: `t-${u}`, key: 'pa::m2', instance: 'pa', model: 'm2', branch: `orq/p1/${u}-a1`, baseSha: head, tier: 2,
  },
  { type: 'thread-ended', unit: u, status: 'completed' },
  { type: 'gate-started', unit: u, attempt: 1, headSha: head, pid: 1 },
  {
    type: 'gated', unit: u, attempt: 1, verdict: 'pass', failures: [], flags: [], headSha: head,
  },
  { type: 'integrated', unit: u, sha: head, head },
];
const passed = (head, verdict = 'pass') => ({
  type: 'final-gated', unit: null, verdict, failures: [], head, checks: verdict === 'pass' ? 'npm test' : null,
});

// a project in continuous mode with an `origin` bare remote; units a and b integrated (heads X, Y), X passed
async function shipProject(t, config = {}) {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('b'), unitSpec('c')]);
  const cfgFile = path.join(p.repo, '.orq', 'config.json');
  await fs.writeFile(cfgFile, JSON.stringify({ ...JSON.parse(await fs.readFile(cfgFile, 'utf8')), autonomy: 'continuous', ...config }));
  const remote = path.join(p.root, 'remote.git');
  sh(p.root, 'init', '-q', '--bare', remote);
  sh(p.repo, 'remote', 'add', 'origin', remote);
  sh(p.repo, 'push', '-q', 'origin', 'main');
  sh(p.repo, 'branch', 'orq/p1/integration');
  const X = await commitOn(p.repo, 'orq/p1/integration', { 'a.txt': 'a\n' }, 'a');
  const Y = await commitOn(p.repo, 'orq/p1/integration', { 'b.txt': 'b\n' }, 'b');
  await append(p, {
    type: 'plan-started', unit: null, planId: 'p1', baseSha: p.baseSha, integrationBranch: 'orq/p1/integration',
  }, ...through('a', X), ...through('b', Y), passed(X));
  const remoteSha = (ref) => sh(remote, 'rev-parse', ref);
  return {
    ...p, X, Y, remote, remoteSha,
  };
}

test('ship: refused outside continuous mode', async (t) => {
  const p = await shipProject(t, { autonomy: 'draft' });
  const r = await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec });
  assert.equal(r.code, 4);
  assert.equal(r.err, 'orq: ship: runs only in continuous mode (autonomy is draft); "orq config set autonomy continuous" turns it on\n');
});

test('ship: pushes the passed head as its own pull request, fast-forwards the base, records it; status shows it', async (t) => {
  const p = await shipProject(t, { base: 'origin/main', checks: { setup: null, unit: null, full: 'true' } });
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `shipped ${p.X.slice(0, 12)} as ${URL1}: 1 units\n`);
  assert.equal(p.remoteSha('refs/heads/main'), p.X);
  assert.equal(p.remoteSha('refs/heads/orq/p1/ship-1'), p.X);
  const create = gh.calls.find((a) => a[1] === 'create');
  const arg = (name) => create[create.indexOf(name) + 1];
  assert.deepEqual([arg('--base'), arg('--head'), arg('--title')], ['main', 'orq/p1/ship-1', 'p1 ship 1: a']);
  assert.match(arg('--body'), /- a: do a/);
  assert.match(arg('--body'), new RegExp(`final checks passed on ${p.X}`));
  assert.match(arg('--body'), /checks\.full: `npm test`/); // the command the green run used
  assert.ok(!gh.calls.some((a) => a[1] === 'merge')); // the host marked it merged on the push
  const s = await readState(p.repo);
  assert.deepEqual([s.plan.shipped, s.plan.ships], [p.X, 1]);
  const status = await orq(['status'], p);
  assert.ok(status.out.split('\n').includes(`ship: green=${p.X.slice(0, 12)} shipped=${p.X.slice(0, 12)} ships=1`), status.out);
  assert.equal((await orq(['ship'], p, { ghExec: gh.exec })).out, `nothing to ship: ${p.X.slice(0, 12)} is shipped; run "orq wait"\n`);
  // the next passed head ships as the next pull request, with only its own units
  await append(p, passed(p.Y));
  const second = await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec });
  assert.equal(second.out, `shipped ${p.Y.slice(0, 12)} as ${URL1}: 1 units\n`);
  assert.equal(p.remoteSha('refs/heads/main'), p.Y);
  assert.equal(p.remoteSha('refs/heads/orq/p1/ship-2'), p.Y);
});

test('ship: refused when the base moved on origin', async (t) => {
  const p = await shipProject(t);
  sh(p.repo, 'commit', '-q', '--allow-empty', '-m', 'upstream');
  sh(p.repo, 'push', '-q', 'origin', 'main');
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(r.code, 4);
  assert.equal(r.err, 'orq: ship: main moved on origin; append a fix unit that merges origin/main into the integration branch\n');
  assert.deepEqual(gh.calls, []);
  assert.equal((await readState(p.repo)).plan.shipped, undefined);
});

test('ship: never merges on the host; a pull request not yet marked merged after 30 s is shipped with a note', async (t) => {
  const p = await shipProject(t);
  const gh = fakeGh({ state: 'OPEN', remote: p.remote });
  const slept = [];
  const r = await orq(['ship'], p, { ghExec: gh.exec }, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `shipped ${p.X.slice(0, 12)} as ${URL1}: 1 units\nnote: ${URL1} is not marked merged yet; GitHub marks it once it sees the push, nothing to do\n`);
  assert.ok(!gh.calls.some((a) => a[1] === 'merge'));
  assert.equal(slept.reduce((a, b) => a + b, 0), 30_000);
  assert.ok(gh.calls.filter((a) => a[1] === 'view' && a[2] === URL1).length > 1); // polled
  assert.equal(p.remoteSha('refs/heads/main'), p.X); // no merge commit on the base
  assert.equal((await readState(p.repo)).plan.shipped, p.X);
});

test('ship: a failed base push names the open pull request; running it again reuses that pull request', async (t) => {
  const p = await shipProject(t);
  const gh = fakeGh({ remote: p.remote });
  const rejecting = (cmd, args, opts) => (args.includes(`${p.X}:refs/heads/main`)
    ? { code: 1, stdout: '', stderr: ' ! [rejected] main (non-fast-forward)' } : defaultExec(cmd, args, opts));
  const r = await orq(['ship'], p, { ghExec: gh.exec, gitExec: rejecting });
  assert.equal(r.code, 1);
  assert.equal(r.err, `orq: ship: ${URL1} is open, but pushing ${p.X.slice(0, 12)} to main failed: ! [rejected] main (non-fast-forward); fix that and run "orq ship" again (it reuses the pull request)\n`);
  assert.equal((await readState(p.repo)).plan.shipped, undefined);
  const again = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(again.code, 0, again.err);
  assert.equal(gh.calls.filter((a) => a[1] === 'create').length, 1);
  assert.equal(p.remoteSha('refs/heads/main'), p.X);
});

test('unit retry integration in continuous mode: counts the starts on the head the final gate ran on', async (t) => {
  const p = await shipProject(t);
  assert.equal((await orq(['unit', 'retry', 'integration'], p)).err, 'orq: the final gate is not stuck; nothing to retry\n');
  const lost = (head) => ({
    type: 'gate-started', unit: 'integration', attempt: 1, headSha: head, pid: 1,
  });
  await append(p, lost(p.X), lost(p.Y));
  assert.match((await orq(['unit', 'retry', 'integration'], p)).err, /not stuck/); // one lost run on each head
  await append(p, lost(p.Y));
  const r = await orq(['unit', 'retry', 'integration'], p);
  assert.equal(r.code, 0, r.err);
  const s = await readState(p.repo);
  assert.deepEqual([s.plan.finalHeadStarts, s.plan.green], [0, p.X]);
});

test('ship: a head whose final run proved nothing is not shipped', async (t) => {
  const p = await shipProject(t);
  await append(p, passed(p.Y, 'no-evidence'));
  const r = await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec });
  assert.equal(r.code, 4);
  assert.equal(r.err, `orq: ship: ${p.Y.slice(0, 12)} has no passing final checks (verdict no-evidence); set checks.full ("orq config set checks.full <cmd>"): only a head that passes it ships\n`);
});

test('ship: a ship branch that holds another head, or a merged pull request, is never reused', async (t) => {
  const p = await shipProject(t);
  sh(p.repo, 'push', '-q', 'origin', `${p.baseSha}:refs/heads/orq/p1/ship-1`);
  const gh = fakeGh({ remote: p.remote, prs: { 'orq/p1/ship-2': { url: 'https://example.invalid/o/r/pull/5', state: 'MERGED' } } });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(r.code, 0, r.err);
  assert.equal(p.remoteSha('refs/heads/orq/p1/ship-1'), p.baseSha); // untouched
  assert.equal(p.remoteSha('refs/heads/orq/p1/ship-2'), p.X);
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.equal(create[create.indexOf('--head') + 1], 'orq/p1/ship-2');
  assert.equal(create[create.indexOf('--title') + 1], 'p1 ship 2: a');
});

test('ship: refused while orq wait, an archive or another ship holds the runner lock', async (t) => {
  const p = await shipProject(t);
  await fs.writeFile(path.join(p.repo, '.orq', 'runner.lock'), JSON.stringify({ pid: process.pid, token: 'other' }));
  const r = await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec });
  assert.equal(r.code, 5);
  assert.equal(r.err, `orq: ship: orq wait, orq plan archive or another orq ship is running (pid ${process.pid}); run "orq ship" when it is done\n`);
});

test('ship: a ledger written before continuous mode (0.7.x events, mode switched mid-plan) ships and is recorded', async (t) => {
  const p = await shipProject(t, { autonomy: 'draft', checks: { setup: null, unit: null, full: 'true' } });
  // 0.7.x wrote final-gated without `checks`; the plan state is rebuilt from the events whatever the mode was
  const ledger = path.join(p.repo, '.orq', 'ledger.jsonl');
  const lines = (await fs.readFile(ledger, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  await fs.writeFile(ledger, `${lines.map(({ checks, ...e }) => JSON.stringify(e)).join('\n')}\n`);
  assert.equal((await orq(['config', 'set', 'autonomy', 'continuous'], p)).code, 0);
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `shipped ${p.X.slice(0, 12)} as ${URL1}: 1 units\n`);
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.match(create[create.indexOf('--body') + 1], /checks\.full: not recorded/);
  assert.equal((await readState(p.repo)).plan.shipped, p.X);
});

test('ship: a head not newer than the shipped one is refused before anything is pushed', async (t) => {
  const p = await shipProject(t);
  await append(p, { type: 'shipped', unit: null, head: p.Y, pr: URL1, n: 1 }, passed(p.X));
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.equal(r.code, 4);
  assert.equal(r.err, `orq: ship: ${p.X.slice(0, 12)} is not newer than the shipped head ${p.Y.slice(0, 12)}; nothing was shipped\n`);
  assert.deepEqual(gh.calls, []);
  assert.equal(p.remoteSha('refs/heads/main'), p.baseSha); // the base did not move
});
