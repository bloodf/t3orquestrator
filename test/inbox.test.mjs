import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { defaultExec as gitExec } from '../lib/git.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const ISO = new Date(NOW).toISOString();
const GIB = 1024 ** 3;
const HEAD = 'message: from the user, through orq inbox; read it and follow it before anything else';

async function orq(args, p, {
  stdin = '', now = NOW, exec, env = {},
} = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: { ...p.env, ...env }, cwd: p.repo, now: () => now, stdin: async () => stdin,
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
      exec: exec ?? ((_bin, args) => ({ code: 0, stdout: args[1] === 'list' ? '[]' : '{}', stderr: '' })), // never a real t3
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const orqPath = (p, ...f) => path.join(p.repo, '.orq', ...f);
const exists = (f) => fs.stat(f).then(() => true, () => false);

// an `orq wait` holds the runner lock while it runs: this test process stands in for it
const waitRuns = (p) => fs.writeFile(orqPath(p, 'runner.lock'), JSON.stringify({ pid: process.pid, token: 't' }));

test('inbox appends a timestamped message per call, from args or stdin', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await waitRuns(p);
  assert.deepEqual(await orq(['inbox', 'switch', 'to', 'draft'], p), { code: 0, out: 'inbox: queued for the next "orq wait"\n', err: '' });
  assert.equal((await orq(['inbox', '-'], p, { stdin: 'line one\nline two\n', now: NOW + 1000 })).code, 0);
  assert.equal(await fs.readFile(orqPath(p, 'inbox.md'), 'utf8'),
    `## ${ISO}\nswitch to draft\n## ${new Date(NOW + 1000).toISOString()}\nline one\nline two\n`);
  const empty = await orq(['inbox'], p);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /inbox: usage/);
  assert.equal((await orq(['inbox', '-'], p, { stdin: '  \n' })).code, 2);
});

test('wait delivers the inbox once, moves it to inbox-read, and works without a plan', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.rm(orqPath(p, 'plan.json'));
  await orq(['inbox', 'use review-fix now'], p);
  const r = await orq(['wait'], p);
  assert.deepEqual(r, { code: 0, out: `${HEAD}\n## ${ISO}\nuse review-fix now\n`, err: '' });
  assert.equal(await exists(orqPath(p, 'inbox.md')), false);
  assert.equal(await fs.readFile(orqPath(p, 'inbox-read', `${ISO}.md`), 'utf8'), `## ${ISO}\nuse review-fix now\n`);
  const again = await orq(['wait'], p); // delivered once: the next call goes on as before
  assert.equal(again.code, 4);
  assert.equal(again.err, 'orq: no valid plan; run "orq plan check"\n');
  await orq(['inbox', 'second'], p); // same clock: the earlier read file is not overwritten
  assert.equal((await orq(['wait'], p)).code, 0);
  assert.deepEqual((await fs.readdir(orqPath(p, 'inbox-read'))).sort(), [`${ISO}-2.md`, `${ISO}.md`]);
});

test('wait caps a long message at 60 lines and names the file with the rest', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await orq(['inbox', '-'], p, { stdin: Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n') });
  const lines = (await orq(['wait'], p)).out.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 61);
  assert.equal(lines[0], HEAD);
  assert.equal(lines[1], `## ${ISO}`);
  assert.equal(lines[59], 'l58');
  assert.equal(lines[60], `… 42 more lines in .orq/inbox-read/${ISO}.md`);
});

test('status says how many inbox messages are waiting, with or without a plan', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  assert.doesNotMatch((await orq(['status'], p)).out, /inbox:/);
  await orq(['inbox', 'one'], p);
  await orq(['inbox', '-'], p, { stdin: '## not a header\ntwo\n' });
  assert.match((await orq(['status'], p)).out, /^inbox: 2 message\(s\) waiting$/m);
  await fs.rm(orqPath(p, 'plan.json'));
  assert.match((await orq(['status'], p)).out, /^inbox: 2 message\(s\) waiting$/m);
});

test('plan archive leaves the inbox and the read messages in place', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await orq(['inbox', 'read me'], p);
  await fs.rm(orqPath(p, 'plan.json'));
  await orq(['wait'], p);
  await fs.writeFile(orqPath(p, 'plan.json'), JSON.stringify({ goal: 'g', units: [unitSpec('a')] }));
  await orq(['inbox', 'unread'], p);
  const r = await orq(['plan', 'archive'], p);
  assert.equal(r.code, 0, r.err);
  assert.equal(await exists(orqPath(p, 'plan.json')), false);
  assert.equal(await exists(orqPath(p, 'inbox.md')), true);
  assert.equal(await exists(orqPath(p, 'inbox-read', `${ISO}.md`)), true);
});

test('two waits at once: one delivers the message, the other goes on as if there were none', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.rm(orqPath(p, 'plan.json'));
  await orq(['inbox', 'once'], p);
  const both = await Promise.all([orq(['wait'], p), orq(['wait'], p)]);
  assert.deepEqual(both.map((r) => r.code).sort(), [0, 4]);
  assert.equal(both.find((r) => r.code === 0).out, `${HEAD}\n## ${ISO}\nonce\n`);
  assert.equal(both.find((r) => r.code === 4).err, 'orq: no valid plan; run "orq plan check"\n');
});

test('an inbox tracked by git is not delivered: a note says so and the file stays', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await orq(['inbox', 'from a commit'], p);
  await fs.rm(orqPath(p, 'plan.json'));
  await fs.writeFile(orqPath(p, 'plan.json'), '{}'); // invalid: wait stops right after the inbox check
  const before = await fs.readFile(orqPath(p, 'inbox.md'), 'utf8');
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['add', '-f', '.orq/inbox.md'], { cwd: p.repo }).status, 0);
  const r = await orq(['wait'], p);
  assert.equal(r.code, 4);
  assert.equal(r.err, 'orq: no valid plan; run "orq plan check"\nnote: .orq/inbox.md is tracked by git, so it may not come from the user; not delivered\n');
  assert.equal(await fs.readFile(orqPath(p, 'inbox.md'), 'utf8'), before);
  assert.equal(await exists(orqPath(p, 'inbox-read')), false);
});

test('inbox keeps .orq/ out of git like the other writers', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const exclude = path.join(p.repo, '.git', 'info', 'exclude');
  await fs.writeFile(exclude, '');
  assert.equal((await orq(['inbox', 'hi'], p, { exec: gitExec })).code, 0);
  assert.equal(await fs.readFile(exclude, 'utf8'), '.orq/\n');
});

const NOT_DELIVERED = 'not delivered: no orq wait is running; queued for the next "orq wait"';
const ORCH = 'mcp:orch-1';
const withOrchestrator = async (p) => {
  const file = orqPath(p, 'config.json');
  const c = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...c, orchestrator: { instance: 'codex', model: 'sol', threadId: ORCH } }));
};
// a t3 whose orchestrator thread has the given status; every call is recorded
function fakeT3(status, { sendFails = false } = {}) {
  const calls = [];
  const exec = (_bin, args, opts) => {
    if (args[0] === 'thread') calls.push([args.slice(0, 3).join(' '), opts?.input ?? null]);
    if (args[1] === 'show') {
      return {
        code: 0, stdout: JSON.stringify({ thread: { threadId: ORCH, projectId: 'p', status, updatedAt: ISO, itemCount: 3 }, messages: [] }), stderr: '',
      };
    }
    if (args[1] === 'send') {
      return sendFails ? { code: 1, stdout: '', stderr: 'thread not found' } : { code: 0, stdout: JSON.stringify({ threadId: ORCH, runId: 'r', status: 'running', delivery: 'started' }), stderr: '' };
    }
    return { code: 0, stdout: '[]', stderr: '' };
  };
  return { exec, calls };
}

test('inbox with no orq wait running: says not delivered, keeps the message, and wakes an idle orchestrator thread', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const none = await orq(['inbox', 'first'], p);
  assert.deepEqual(none, {
    code: 0, out: `${NOT_DELIVERED}\nnote: no orchestrator thread is recorded ("orq sync" from it records it); tell it to run "orq wait"\n`, err: '',
  });
  await withOrchestrator(p);
  const idle = fakeT3('completed');
  const woke = await orq(['inbox', 'second'], p, { exec: idle.exec });
  assert.equal(woke.out, `${NOT_DELIVERED}\nwoke orchestrator thread ${ORCH} to run "orq wait"\n`);
  assert.deepEqual(idle.calls.map(([c]) => c), [`thread show ${ORCH}`, `thread send ${ORCH}`]);
  assert.match(idle.calls[1][1], /Run "orq wait" now/);
  // both messages wait for the next orq wait, which delivers them
  assert.match(await fs.readFile(orqPath(p, 'inbox.md'), 'utf8'), /first\n## .*\nsecond\n$/);
  assert.equal((await orq(['wait'], p)).out.split('\n')[0], HEAD);
});

test('inbox does not send to an orchestrator thread at work, nor from the orchestrator itself; a failed wake is a note', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await withOrchestrator(p);
  const busy = fakeT3('running');
  assert.equal((await orq(['inbox', 'x'], p, { exec: busy.exec })).out,
    `${NOT_DELIVERED}\nnote: orchestrator thread ${ORCH} is at work; it reads the message at its next "orq wait"\n`);
  assert.deepEqual(busy.calls.map(([c]) => c), [`thread show ${ORCH}`]);
  const self = fakeT3('completed');
  assert.equal((await orq(['inbox', 'x'], p, { exec: self.exec, env: { T3CODE_THREAD_ID: ORCH } })).out, `${NOT_DELIVERED}\n`);
  assert.deepEqual(self.calls, []);
  const broken = fakeT3('completed', { sendFails: true });
  const r = await orq(['inbox', 'x'], p, { exec: broken.exec });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`^note: could not wake orchestrator thread ${ORCH}: thread send failed \\(exit 1\\): thread not found$`, 'm'));
});

test('inbox while an orq wait runs: queued for it, no thread is woken', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await withOrchestrator(p);
  await waitRuns(p);
  const t3 = fakeT3('completed');
  assert.equal((await orq(['inbox', 'x'], p, { exec: t3.exec })).out, 'inbox: queued for the next "orq wait"\n');
  assert.deepEqual(t3.calls, []);
  // a lock left by a dead process is no running wait
  await fs.writeFile(orqPath(p, 'runner.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 't' }));
  assert.match((await orq(['inbox', 'y'], p, { exec: t3.exec })).out, /^not delivered: /);
});
