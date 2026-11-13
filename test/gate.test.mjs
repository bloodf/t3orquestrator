import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGit, defaultExec } from '../lib/git.mjs';
import { runGate, defaultRun } from '../lib/gate.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const unit = (over = {}) => ({ id: 'u1', paths: ['lib/**', 'test/**'], forbidden: [], evidence: 'ev', ...over });

function fakeGit(over = {}) {
  const calls = [];
  const git = {
    calls,
    commitsAhead: (...a) => { calls.push(['commitsAhead', ...a]); return 1; },
    changedFiles: () => [{ status: 'A', path: 'lib/a.mjs' }],
    addedLines: () => [],
    removedLines: () => [],
    addDetachedWorktree: (...a) => { calls.push(['add', ...a]); },
    removeWorktree: (...a) => { calls.push(['remove', ...a]); },
    ...over,
  };
  return git;
}

// scripted run: results keyed by command, consumed in order
function fakeRun(script) {
  const calls = [];
  const run = async (command, opts) => {
    calls.push({ command, ...opts });
    const q = script[command] || [{ code: 0, output: '' }];
    const next = q.length > 1 ? q.shift() : q[0];
    return { timedOut: false, ...next };
  };
  return { run, calls };
}

const WORKDIR = path.join(os.tmpdir(), 'orq-gate-never-exists');

const gate = async (over = {}) => {
  const f = fakeRun(over.script || {});
  const git = over.git || fakeGit();
  const r = await runGate({
    repo: '/repo', baseSha: BASE, headSha: HEAD, workDir: WORKDIR,
    unit: unit(), checks: { setup: null, unit: null }, run: f.run, now: () => 0, ...over, git,
  });
  return { ...r, calls: f.calls, gitCalls: git.calls };
};

test('in-path unit with passing evidence passes, runs in the fresh worktree', async () => {
  const r = await gate();
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.failures, []);
  assert.equal(r.headSha, HEAD);
  assert.deepEqual(r.calls.map((c) => c.command), ['ev']);
  assert.equal(r.calls[0].cwd, WORKDIR);
  assert.deepEqual(r.gitCalls.filter((c) => c[0] !== 'commitsAhead'), [['add', '/repo', WORKDIR, HEAD], ['remove', '/repo', WORKDIR]]);
  assert.deepEqual(r.gitCalls[0], ['commitsAhead', '/repo', BASE, HEAD]);
});

test('shas must be full 40-hex ids', async () => {
  await assert.rejects(gate({ baseSha: 'main' }), /baseSha must be a full commit SHA/);
  await assert.rejects(gate({ headSha: 'b'.repeat(39) }), /headSha must be a full commit SHA/);
  await assert.rejects(gate({ headSha: 'B'.repeat(40) }), /headSha must be a full commit SHA/);
});

test('zero commits ahead fails and stops before anything else', async () => {
  const git = fakeGit({ commitsAhead: () => 0 });
  const r = await gate({ git });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.failures, ['no commits on top of aaaaaaaaaaaa']);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.steps, []);
  assert.equal(r.headSha, HEAD);
});

test('files outside writable paths fail, listing at most 5', async () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => ({ status: 'A', path: `x/${n}` }));
  const r = await gate({ git: fakeGit({ changedFiles: () => files }) });
  assert.deepEqual(r.failures, ['outside writable paths: x/a, x/b, x/c, x/d, x/e +2 more']);
});

test('forbidden globs fail even inside writable paths', async () => {
  const r = await gate({
    unit: unit({ forbidden: ['lib/secret/**'] }),
    git: fakeGit({ changedFiles: () => [{ status: 'M', path: 'lib/secret/k.mjs' }, { status: 'M', path: 'lib/ok.mjs' }] }),
  });
  assert.deepEqual(r.failures, ['outside writable paths: lib/secret/k.mjs']);
});

test('a rename needs both old and new path allowed', async () => {
  const r = await gate({
    git: fakeGit({ changedFiles: () => [{ status: 'R', path: 'lib/new.mjs' }, { status: 'D', path: 'docs/old.md' }] }),
  });
  assert.deepEqual(r.failures, ['outside writable paths: docs/old.md']);
});

test('path failures skip the worktree and all commands but keep scan flags', async () => {
  const r = await gate({
    checks: { setup: 'setup', unit: 'chk' },
    git: fakeGit({
      changedFiles: () => [{ status: 'A', path: 'x/a' }],
      addedLines: () => [{ path: 'x/a', line: '// TODO' }],
    }),
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.steps, []);
  assert.deepEqual(r.gitCalls.map((c) => c[0]), ['commitsAhead']);
  assert.match(r.failures[0], /outside writable paths/);
  assert.deepEqual(r.flags.map((f) => f.kind), ['placeholder']);
});

test('scan flags (including weakened tests and evidence targets) never fail the gate', async () => {
  const r = await gate({
    unit: unit({ evidence: 'node --test test/a.mjs' }),
    git: fakeGit({
      changedFiles: () => [{ status: 'M', path: 'test/a.mjs' }],
      addedLines: () => [{ path: 'test/a.mjs', line: '// TODO' }],
      removedLines: () => [{ path: 'test/a.mjs', line: 'assert.ok(1)' }],
    }),
  });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.flags.map((f) => f.kind).sort(), ['evidence-target-changed', 'placeholder', 'test-weakened']);
});

test('setup failing twice stops before evidence, is marked as a setup failure, and still removes the worktree', async () => {
  const r = await gate({ checks: { setup: 'setup', unit: 'chk' }, script: { setup: [{ code: 5, output: 'x' }, { code: 5, output: 'npm ERR! network\n\u001b[31mETIMEDOUT\n' }] } });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.setupFailed, true);
  assert.deepEqual(r.failures, ['setup failed (exit 5): [31mETIMEDOUT']); // the last line, control characters removed
  assert.deepEqual(r.calls.map((c) => c.command), ['setup', 'setup']);
  assert.equal(r.gitCalls.at(-1)[0], 'remove');
});

test('setup passing on retry adds a flaky flag and continues; other failures are not setup failures', async () => {
  const r = await gate({ checks: { setup: 'setup', unit: null }, script: { setup: [{ code: 1, output: '' }, { code: 0, output: '' }] } });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.setupFailed, undefined);
  assert.deepEqual(r.flags, [{ kind: 'flaky', path: '', detail: 'setup passed on retry' }]);
  assert.deepEqual(r.calls.map((c) => c.command), ['setup', 'setup', 'ev']);
  const ev = await gate({ checks: { setup: 'setup', unit: null }, script: { ev: [{ code: 1, output: '' }] } });
  assert.deepEqual([ev.verdict, ev.setupFailed], ['fail', undefined]);
});

test('evidence passing on retry adds a flaky flag and continues', async () => {
  const r = await gate({
    checks: { setup: null, unit: 'chk' },
    script: { ev: [{ code: 1, output: '' }, { code: 0, output: '' }] },
  });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.flags, [{ kind: 'flaky', path: '', detail: 'evidence passed on retry' }]);
  assert.deepEqual(r.calls.map((c) => c.command), ['ev', 'ev', 'chk']);
});

test('evidence failing twice fails and skips later commands', async () => {
  const r = await gate({
    checks: { setup: null, unit: 'chk' },
    script: { ev: [{ code: 1, output: '' }, { code: 2, output: '' }] },
  });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.failures, ['evidence failed (exit 2)']);
  assert.deepEqual(r.calls.map((c) => c.command), ['ev', 'ev']);
});

test('evidence timeout fails without retry', async () => {
  const r = await gate({ script: { ev: [{ code: 1, output: '', timedOut: true }] } });
  assert.deepEqual(r.failures, ['evidence timed out']);
  assert.equal(r.calls.length, 1);
});

test('checks.unit follows the same retry rule', async () => {
  const r = await gate({
    unit: unit({ evidence: null }),
    checks: { setup: null, unit: 'chk' },
    script: { chk: [{ code: 1, output: '' }, { code: 3, output: '' }] },
  });
  assert.deepEqual(r.failures, ['checks failed (exit 3)']);
  const ok = await gate({
    unit: unit({ evidence: null }),
    checks: { setup: null, unit: 'chk' },
    script: { chk: [{ code: 1, output: '' }, { code: 0, output: '' }] },
  });
  assert.equal(ok.verdict, 'pass');
  assert.equal(ok.flags[0].kind, 'flaky');
});

test('no-evidence when nothing proves the unit; no worktree is made when nothing would run', async () => {
  const r = await gate({ unit: unit({ evidence: null }) });
  assert.equal(r.verdict, 'no-evidence');
  assert.deepEqual(r.gitCalls.map((c) => c[0]), ['commitsAhead']);
  const setupOnly = await gate({ unit: unit({ evidence: null }), checks: { setup: 'setup', unit: null } });
  assert.equal(setupOnly.verdict, 'no-evidence');
  const f = await gate({ unit: unit({ evidence: null }), git: fakeGit({ commitsAhead: () => 0 }) });
  assert.equal(f.verdict, 'fail');
});

test('the worktree is removed when a command throws, and the error surfaces', async () => {
  const git = fakeGit();
  const run = async () => { throw new Error('spawn exploded'); };
  await assert.rejects(runGate({
    repo: '/repo', baseSha: BASE, headSha: HEAD, workDir: WORKDIR, unit: unit(), checks: { setup: null, unit: null }, git, run,
  }), /spawn exploded/);
  assert.equal(git.calls.at(-1)[0], 'remove');
});

test('a removal failure surfaces when the run itself succeeded', async () => {
  const git = fakeGit({ removeWorktree: () => { throw new Error('cannot remove'); } });
  await assert.rejects(gate({ git }), /cannot remove/);
});

test('steps record name, code, duration from the injected clock and a 15-line tail', async () => {
  let t = 1000;
  const now = () => { t += 50; return t; };
  const output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const r = await gate({ now, script: { ev: [{ code: 0, output }] } });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].name, 'evidence');
  assert.equal(r.steps[0].code, 0);
  assert.equal(r.steps[0].durationMs, 50);
  const tail = r.steps[0].tail.split('\n');
  assert.equal(tail.length, 15);
  assert.equal(tail.at(-1), 'line 30');
  assert.equal(tail[0], 'line 16');
});

test('timeoutMs is passed to run', async () => {
  const r = await gate({ timeoutMs: 1234 });
  assert.equal(r.calls[0].timeoutMs, 1234);
});

test('defaultRun merges output, caps it, reports exit code and timeout', async () => {
  const opts = { cwd: os.tmpdir(), timeoutMs: 10000 };
  const ok = await defaultRun('echo out; echo err 1>&2', opts);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  assert.equal((await defaultRun('exit 7', opts)).code, 7);
  const long = await defaultRun('i=0; while [ $i -lt 300 ]; do echo l$i; i=$((i+1)); done', opts);
  const lines = long.output.trim().split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines.at(-1), 'l299');
  const slow = await defaultRun('sleep 30', { ...opts, timeoutMs: 2000 });
  assert.equal(slow.timedOut, true);
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

test('defaultRun kills the whole process group on timeout', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-run-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const running = defaultRun(`sleep 30 & echo $! > ${pidFile}; wait`, { cwd: dir, timeoutMs: 2000 });
  let text = '';
  const until = Date.now() + 5000;
  while (text.trim() === '' && Date.now() < until) {
    text = await fs.readFile(pidFile, 'utf8').catch(() => '');
    if (text.trim() === '') await new Promise((res) => setTimeout(res, 20));
  }
  const r = await running;
  assert.equal(r.timedOut, true);
  const pid = Number(text.trim());
  assert.ok(pid > 0, 'pid file was never written');
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.equal(alive(pid), false);
});

test('defaultRun kills a background process left by a step that succeeded', { skip: process.platform === 'win32' }, async (t) => {
  const r = await defaultRun('sleep 30 >/dev/null 2>&1 & echo $!', { cwd: os.tmpdir(), timeoutMs: 10000 });
  const pid = Number(r.output.trim());
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(r.code, 0);
  assert.ok(pid > 0, `no pid in output: ${r.output}`);
  const deadline = Date.now() + 1000; // reaping by init is not instant
  while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
  assert.equal(alive(pid), false);
});

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function realWork(t, committed, untracked = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-gate-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repo, 'README.md'), 'hi\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  const baseSha = sh(repo, 'rev-parse', 'HEAD');
  const git = createGit({ exec: defaultExec });
  const wt = path.join(root, 'wt');
  git.ensureWorktree(repo, wt, 'unit-1', baseSha);
  const put = async (files) => {
    for (const [name, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(wt, name)), { recursive: true });
      await fs.writeFile(path.join(wt, name), body);
    }
  };
  await put(committed);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-m', 'work');
  const headSha = sh(wt, 'rev-parse', 'HEAD');
  await put(untracked);
  return { git, repo, baseSha, headSha, workDir: path.join(root, 'gate-wd'), wt };
}

const real = (w, evidence, over = {}) => runGate({
  repo: w.repo, baseSha: w.baseSha, headSha: w.headSha, workDir: w.workDir, unit: unit({ evidence }),
  checks: { setup: null, unit: null }, git: w.git, run: defaultRun, ...over,
});

test('end to end: real commit with real evidence passes and the workDir is removed', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'export default 1;\n' });
  const r = await real(w, 'test -f lib/a.mjs && node -e "process.exit(0)"');
  assert.equal(r.verdict, 'pass');
  assert.equal(r.headSha, w.headSha);
  await assert.rejects(fs.stat(w.workDir));
});

test('end to end: a file that exists only uncommitted cannot satisfy the evidence', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n' }, { 'lib/never-committed.txt': 'secret' });
  const r = await real(w, 'test -f lib/never-committed.txt');
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.failures, ['evidence failed (exit 1)']);
  await assert.rejects(fs.stat(w.workDir));
});

test('end to end: a gitignored file cannot satisfy the evidence either', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n', '.gitignore': 'lib/ignored.txt\n' }, { 'lib/ignored.txt': 'x' });
  const r = await real(w, 'test -f lib/ignored.txt');
  assert.equal(r.verdict, 'fail');
});

test('end to end: a change outside writable paths fails without running evidence', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n', 'docs/n.md': 'y\n' });
  const r = await real(w, 'node -e "process.exit(0)"');
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.failures, ['outside writable paths: docs/n.md']);
  assert.deepEqual(r.steps, []);
});

const gitAt = (w, ...args) => sh(w.repo, ...args);

test('a registration left behind by a crashed gate (directory gone) does not block the next gate', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n' });
  gitAt(w, 'worktree', 'add', '--detach', w.workDir, w.headSha);
  await fs.rm(w.workDir, { recursive: true, force: true });
  const r = await real(w, 'test -f lib/a.mjs');
  assert.equal(r.verdict, 'pass');
  await assert.rejects(fs.stat(w.workDir));
});

test('a registered worktree left behind by a crashed gate does not block the next gate', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n' });
  gitAt(w, 'worktree', 'add', '--detach', w.workDir, w.headSha);
  await fs.writeFile(path.join(w.workDir, 'stray.txt'), 'junk');
  const r = await real(w, 'test -f lib/a.mjs && test ! -f stray.txt');
  assert.equal(r.verdict, 'pass');
  await assert.rejects(fs.stat(w.workDir));
});

test('an unrelated plain directory at workDir is refused and left alone', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n' });
  await fs.mkdir(w.workDir);
  await fs.writeFile(path.join(w.workDir, 'keep.txt'), 'mine');
  await assert.rejects(real(w, 'true'), (e) => e.message === `workDir exists and is not a worktree: ${w.workDir}`);
  await fs.stat(path.join(w.workDir, 'keep.txt'));
});

async function plantHooks(repo, root) {
  await fs.writeFile(path.join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${root}/hook-marker"\n`, { mode: 0o755 });
  const fsm = path.join(root, 'fsm.sh');
  await fs.writeFile(fsm, `#!/bin/sh\ntouch "${root}/fsmonitor-marker"\nexit 0\n`, { mode: 0o755 });
  sh(repo, 'config', 'core.fsmonitor', fsm);
}

test('worker-planted hooks and fsmonitor never run during the gate', async (t) => {
  const w = await realWork(t, { 'lib/a.mjs': 'x\n' });
  const root = path.dirname(w.workDir);
  await plantHooks(w.repo, root);
  const r = await real(w, 'test -f lib/a.mjs');
  assert.equal(r.verdict, 'pass');
  await assert.rejects(fs.stat(path.join(root, 'hook-marker')));
  await assert.rejects(fs.stat(path.join(root, 'fsmonitor-marker')));
});

test('defaultRun sweeps children left behind by a command that exited', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-sweep-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  const r = await defaultRun(`sleep 30 & echo $! > ${pidFile}; exit 0`, { cwd: dir, timeoutMs: 10000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.equal(alive(pid), false);
});

test('a unit without a forbidden list is gated as if the list were empty', async () => {
  const { forbidden, ...bare } = unit();
  const r = await gate({ unit: bare });
  assert.equal(r.verdict, 'pass');
});
