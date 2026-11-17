// orq ship: real git against a local bare remote, a fake gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { createGit, defaultExec } from '../lib/git.mjs';
import { commit, readState } from '../lib/ledger.mjs';
import { readLines } from '../lib/store.mjs';
import { staleBase, syncBase } from '../lib/commands/wait-sync.mjs';
import { mergeBase } from '../lib/integrate.mjs';
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
async function shipProject(t, config = {}, units = [unitSpec('a'), unitSpec('b'), unitSpec('c')]) {
  const p = await makeProject(t, units);
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
  assert.deepEqual([arg('--base'), arg('--head'), arg('--title')], ['main', 'orq/p1/ship-1', 'do a']); // no plan, ship or unit ids
  assert.equal(arg('--body'), `Final checks passed on ${p.X.slice(0, 12)}.`); // checks.full stays in the ledger
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
  assert.equal(create[create.indexOf('--title') + 1], 'do a');
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
  assert.equal(create[create.indexOf('--body') + 1], `Final checks passed on ${p.X.slice(0, 12)}.`);
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

test('ship --title --body-file: the orchestrator writes the title and summary; orq adds Closes lines and the checks line', async (t) => {
  const p = await shipProject(t, {}, [unitSpec('a', { title: '#12 #14: add a' }), unitSpec('b'), unitSpec('c')]);
  await fs.writeFile(path.join(p.repo, '.orq', 'body.md'), 'Shops can now export their catalogue.\n\nValidated with the export suite.\n');
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship', '--title', '  feat(shop): export the catalogue ', '--body-file', '.orq/body.md'], p, { ghExec: gh.exec }); // relative to the project
  assert.equal(r.code, 0, r.err);
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.equal(create[create.indexOf('--title') + 1], 'feat(shop): export the catalogue');
  assert.equal(create[create.indexOf('--body') + 1], `Shops can now export their catalogue.\n\nValidated with the export suite.\n\nCloses #12\nCloses #14\n\nFinal checks passed on ${p.X.slice(0, 12)}.`);
});

test('ship: a title or summary that breaks the rules ships nothing', async (t) => {
  const p = await shipProject(t);
  const summary = path.join(p.root, 'summary.md');
  await fs.writeFile(summary, 'Adds a.\n\n🤖 Generated with a tool\n');
  const cases = [
    [['--title', 'x'.repeat(73)], 'ship: --title must be one line of 1 to 72 characters; nothing was shipped'],
    [['--title', 'fix: a', '--body-file', summary], 'ship: --body-file credits a tool or model ("🤖"); write it as the maintainer; nothing was shipped'],
    [['--body-file', path.join(p.root, 'missing.md')], `ship: --body-file ${path.join(p.root, 'missing.md')} cannot be read; nothing was shipped`],
  ];
  for (const [args, err] of cases) {
    const gh = fakeGh({ remote: p.remote });
    const r = await orq(['ship', ...args], p, { ghExec: gh.exec });
    assert.deepEqual([r.code, r.err, gh.calls], [2, `orq: ${err}\n`, []]);
  }
  assert.equal(p.remoteSha('refs/heads/main'), p.baseSha);
});

test('ship: a default title that credits a tool or model ships nothing and asks for --title', async (t) => {
  const p = await shipProject(t, {}, [unitSpec('a', { title: '#3 Written by Claude: add a' }), unitSpec('b'), unitSpec('c')]);
  const gh = fakeGh({ remote: p.remote });
  const r = await orq(['ship'], p, { ghExec: gh.exec });
  assert.deepEqual([r.code, r.err, gh.calls], [2, 'orq: ship: the title made from the unit titles, "Written by Claude: add a", credits a tool or model ("Written by Claude"); pass --title; nothing was shipped\n', []]);
  assert.equal(p.remoteSha('refs/heads/main'), p.baseSha);
});

// orq wait merging origin's base: real git against the bare remote, called the way `orq wait` calls it
function syncRun(p, calls = [], at = { now: NOW }) {
  const timeouts = [];
  const exec = (cmd, args, opts) => {
    calls.push(args.includes('fetch') ? 'fetch' : (args.includes('--no-ff') && 'merge') || '');
    if (args.includes('fetch')) timeouts.push(opts.timeoutMs);
    return defaultExec(cmd, args, opts);
  };
  const run = { config: { base: 'main' }, fx: { git: createGit({ exec }) }, notes: [] };
  const ctx = { cwd: p.repo, now: () => at.now, deps: { gitExec: exec } };
  return {
    run, ctx, at, calls, timeouts, sync: () => syncBase(ctx, run),
  };
}

async function otherShip(p, files, from = 'main') {
  sh(p.repo, 'branch', '-f', 'other', from);
  const sha = await commitOn(p.repo, 'other', files, 'shipped by another machine');
  sh(p.repo, 'push', '-q', 'origin', `${sha}:refs/heads/main`);
  return sha;
}

test('sync: orq merges origin\'s new base into the integration branch, records it, and the merged head fast-forwards the base', async (t) => {
  const p = await shipProject(t);
  const O = await otherShip(p, { 'other.txt': 'o\n' });
  const s = syncRun(p);
  await s.sync();
  const st = await readState(p.repo);
  const H = st.plan.integrationHead;
  assert.equal(sh(p.repo, 'rev-parse', 'orq/p1/integration'), H);
  assert.deepEqual([sh(p.repo, 'rev-parse', `${H}^1`), sh(p.repo, 'rev-parse', `${H}^2`)], [p.Y, O]); // a merge commit, never a rewrite
  assert.deepEqual(st.plan.synced, {
    from: p.Y, to: H, base: O, at: NOW,
  });
  assert.deepEqual(st.plan.integrations.at(-1), { unit: null, head: H });
  assert.deepEqual(s.run.notes, [`note: merged origin/main (${O.slice(0, 12)}) into the integration branch at ${H.slice(0, 12)}; the final checks run on it`]);
  assert.deepEqual(staleBase(s.ctx, s.run.config, st.plan), { base: 'main', synced: true, files: [] }); // X is behind, the head is not
  assert.match((await orq(['status'], p)).out, new RegExp(`synced=${O.slice(0, 12)}->${H.slice(0, 12)}`));
  // the merged head waits for its final verdict: no fetch, no merge meanwhile
  await s.sync();
  s.at.now += 6 * 60_000;
  await s.sync();
  assert.deepEqual(s.calls.filter(Boolean), ['fetch', 'merge']);
  assert.equal((await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'synced').length, 1);
  // the merged head ships by fast-forward once its final checks pass
  await append(p, passed(H));
  const r = await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec });
  assert.equal(r.code, 0, r.err);
  assert.equal(p.remoteSha('refs/heads/main'), H);
});

test('sync: a conflicting base is aborted cleanly, recorded once per origin sha, and tried again when origin moves', async (t) => {
  const p = await shipProject(t);
  const O = await otherShip(p, { 'a.txt': 'not a\n' });
  const s = syncRun(p);
  await s.sync();
  let st = await readState(p.repo);
  assert.equal(st.plan.integrationHead, p.Y);
  assert.deepEqual(st.plan.syncConflict, { base: O, files: ['a.txt'], at: NOW });
  assert.equal(sh(path.join(p.repo, '.orq', 'integration'), 'status', '--porcelain'), '');
  assert.equal(sh(p.repo, 'rev-parse', 'orq/p1/integration'), p.Y);
  assert.deepEqual(staleBase(s.ctx, s.run.config, st.plan), { base: 'main', synced: false, files: ['a.txt'] });
  s.at.now += 6 * 60_000;
  await s.sync();
  assert.deepEqual(s.calls.filter(Boolean), ['fetch', 'merge', 'fetch']); // the same sha is not merged again
  const O2 = await otherShip(p, { 'more.txt': 'm\n' }, O);
  s.at.now += 6 * 60_000;
  await s.sync();
  st = await readState(p.repo);
  assert.deepEqual(st.plan.syncConflict.base, O2);
  assert.equal((await readLines(path.join(p.repo, '.orq', 'ledger.jsonl'))).filter((e) => e.type === 'sync-conflicted').length, 2);
  // `orq ship` still refuses the stale head itself
  assert.equal((await orq(['ship'], p, { ghExec: fakeGh({ remote: p.remote }).exec })).code, 4);
});

test('sync: nothing to ship means nothing to merge, and no fetch', async (t) => {
  const p = await shipProject(t);
  await append(p, passed(p.Y), { type: 'shipped', unit: null, head: p.Y, pr: URL1, n: 1 });
  await otherShip(p, { 'other.txt': 'o\n' });
  const s = syncRun(p);
  await s.sync();
  assert.deepEqual(s.calls.filter(Boolean), []);
  assert.equal((await readState(p.repo)).plan.integrationHead, p.Y);
});

test('sync: no new merge while the final checks of a merged head have no verdict; after it, origin is merged again', async (t) => {
  const p = await shipProject(t);
  const O = await otherShip(p, { 'other.txt': 'o\n' });
  const s = syncRun(p);
  await s.sync();
  const H = (await readState(p.repo)).plan.integrationHead;
  const O2 = await otherShip(p, { 'more.txt': 'm\n' }, O);
  s.at.now += 6 * 60_000;
  await s.sync(); // the final gate has not started on H yet
  await append(p, {
    type: 'gate-started', unit: 'integration', attempt: 1, headSha: H, pid: 1,
  });
  s.at.now += 6 * 60_000;
  await s.sync(); // it runs on H
  assert.equal((await readState(p.repo)).plan.integrationHead, H);
  await append(p, passed(H));
  await s.sync();
  const st = await readState(p.repo);
  assert.deepEqual([st.plan.synced.from, st.plan.synced.base], [H, O2]);
});

test('sync: the fetch time is kept across orq wait calls, and the fetch gives up after 60 s', async (t) => {
  const p = await shipProject(t);
  const calls = [];
  const first = syncRun(p, calls);
  await first.sync();
  const second = syncRun(p, calls, { now: NOW + 60_000 }); // the next `orq wait`
  await second.sync();
  assert.deepEqual(calls.filter((c) => c === 'fetch'), ['fetch']);
  await syncRun(p, calls, { now: NOW + 6 * 60_000 }).sync();
  assert.deepEqual(calls.filter((c) => c === 'fetch'), ['fetch', 'fetch']);
  assert.deepEqual(first.timeouts, [60_000]);
});

test('sync: merges the fetched sha itself, and a merged head that fails its check is reset', async (t) => {
  const p = await shipProject(t);
  const O = await otherShip(p, { 'other.txt': 'o\n' });
  sh(p.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const dir = path.join(p.repo, '.orq', 'integration');
  const real = createGit({ exec: defaultExec });
  const args = {
    repo: p.repo, dir, branch: 'orq/p1/integration', baseSha: p.baseSha, sha: O,
  };
  assert.throws(() => mergeBase({ ...args, git: { ...real, isAncestor: () => false } }), /does not contain/);
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), p.Y); // put back where it was
  assert.equal(sh(dir, 'status', '--porcelain'), '');
  const r = mergeBase({ ...args, git: real });
  assert.equal(sh(dir, 'log', '-1', '--format=%s', r.head), `Merge commit '${O}' into orq/p1/integration`);
});

test('sync: conflict files are named only while origin is still at the sha that conflicted', async (t) => {
  const p = await shipProject(t);
  const O = await otherShip(p, { 'a.txt': 'not a\n' });
  const s = syncRun(p);
  await s.sync();
  let st = await readState(p.repo);
  assert.deepEqual(staleBase(s.ctx, s.run.config, st.plan).files, ['a.txt']);
  sh(p.repo, 'branch', '-f', 'other', O);
  const O2 = await commitOn(p.repo, 'other', { 'z.txt': 'z\n' });
  sh(p.repo, 'update-ref', 'refs/remotes/origin/main', O2); // fetched, not merged yet
  st = await readState(p.repo);
  assert.deepEqual(staleBase(s.ctx, s.run.config, st.plan), { base: 'main', synced: false, files: [] });
});
