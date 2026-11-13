import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  resolveT3Bin, ownThreadId, createT3, defaultExec, isActive, isBlocked, isTerminal, needsShow,
} from '../lib/t3.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

function fake(stdout, code = 0, stderr = '') {
  const calls = [];
  const exec = (bin, args, opts) => { calls.push({ bin, args, input: opts.input }); return { code, stdout, stderr }; };
  return { calls, t3: createT3({ bin: 'T3', exec }) };
}

test('resolveT3Bin: env, home, PATH fallback', () => {
  const yes = () => true;
  assert.equal(resolveT3Bin({ env: { T3CODE_CLI_PATH: '/x/t3' }, homedir: '/h', exists: yes }), '/x/t3');
  assert.equal(resolveT3Bin({ env: { T3CODE_CLI_PATH: '/x/t3' }, homedir: '/h', exists: (p) => p === '/h/.t3/bin/t3' }), '/h/.t3/bin/t3');
  assert.equal(resolveT3Bin({ env: {}, homedir: '/h', exists: () => false }), 't3');
});

test('ownThreadId', () => {
  assert.equal(ownThreadId({ T3CODE_THREAD_ID: 'a' }), 'a');
  assert.equal(ownThreadId({}), null);
});

test('version strips the t3 prefix', () => {
  const { t3, calls } = fake('t3 v0.1.8\n');
  assert.equal(t3.version(), 'v0.1.8');
  assert.deepEqual(calls[0].args, ['--version']);
});

test('listThreads: argv and normalization', () => {
  const { t3, calls } = fake(fx('thread-list.json'));
  const rows = t3.listThreads({ project: 'p1' });
  assert.deepEqual(calls[0].args, ['thread', 'list', '--project', 'p1', '--json']);
  assert.equal(calls[0].bin, 'T3');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: 'thread-0001', projectId: 'project-0001', status: 'completed', instance: 'provider-c', model: 'model-large',
    itemCount: 128, updatedAt: Date.parse('2026-11-12T20:08:07.241Z'), pending: null, runCount: null,
    activeRunId: null, worktreePath: null, branch: null, title: 'Placeholder thread title',
  });
});

test('showThread: argv, pending and runCount', () => {
  const { t3, calls } = fake(fx('thread-show-waiting-question.json'));
  const r = t3.showThread('mcp:thread-0004', { messages: 3 });
  assert.deepEqual(calls[0].args, ['thread', 'show', 'mcp:thread-0004', '--messages', '3', '--json']);
  assert.equal(r.thread.pending, 1);
  assert.equal(r.thread.runCount, 1);
  assert.equal(r.thread.activeRunId, 'run:thread:mcp%3Athread-0004:ordinal:1');
  assert.equal(r.messages.length, 1);
  assert.equal(isBlocked(r.thread), true);
  assert.equal(isActive(r.thread), false);
});

test('showThread: default messages=1, completed is terminal', () => {
  const { t3, calls } = fake(fx('thread-show-completed.json'));
  const r = t3.showThread('x');
  assert.deepEqual(calls[0].args.slice(3, 5), ['--messages', '1']);
  assert.equal(isTerminal(r.thread), true);
  assert.equal(r.thread.instance, 'provider-a');
});

test('startThread: stdin message, provider/model, never --wait', () => {
  const { t3, calls } = fake(fx('thread-start-nowait.json'));
  const r = t3.startThread({
    project: 'p', message: 'do it', provider: 'prov', model: 'mod', worktree: 'main', branch: 'orq/a', title: 'T',
  });
  assert.deepEqual(calls[0].args, [
    'thread', 'start', 'p', '-', '--provider', 'prov', '--model', 'mod',
    '--worktree', 'main', '--branch', 'orq/a', '--title', 'T', '--json',
  ]);
  assert.equal(calls[0].input, 'do it');
  assert.ok(!calls[0].args.includes('--wait'));
  assert.deepEqual(r, { threadId: 'mcp:thread-0007', projectId: 'project-0002', runId: 'run:thread:mcp%3Athread-0007:ordinal:1' });
});

test('startThread: minimal argv and provider/model pairing', () => {
  const { t3, calls } = fake(fx('thread-start-nowait.json'));
  t3.startThread({ project: 'p', message: 'm' });
  assert.deepEqual(calls[0].args, ['thread', 'start', 'p', '-', '--json']);
  assert.throws(() => t3.startThread({ project: 'p', message: 'm', provider: 'a' }), /together/);
  assert.throws(() => t3.startThread({ project: 'p', message: 'm', model: 'a' }), /together/);
});

test('sendThread: argv, stdin, result', () => {
  const { t3, calls } = fake(fx('thread-send-queued.json'));
  const r = t3.sendThread('id1', 'hello');
  assert.deepEqual(calls[0].args, ['thread', 'send', 'id1', '-', '--json']);
  assert.equal(calls[0].input, 'hello');
  assert.equal(r.status, 'queued');
  assert.equal(r.delivery, 'queued');
  assert.equal(r.threadId, 'mcp:thread-0007');
});

test('errors: non-zero exit carries code and truncated text', () => {
  const { t3 } = fake('', 3, 'x'.repeat(500));
  assert.throws(() => t3.listThreads({ project: 'p' }), (e) => e.code === 3 && /thread list/.test(e.message) && e.message.length < 400);
});

test('errors: invalid JSON names the command', () => {
  const { t3 } = fake('not json'.repeat(50));
  assert.throws(() => t3.sendThread('i', 'm'), (e) => /thread send: invalid JSON: not json/.test(e.message) && e.message.length < 300);
});

test('errors: missing fields name command and field', () => {
  assert.throws(() => fake('{"threadId":"a"}').t3.startThread({ project: 'p', message: 'm' }), /thread start.*projectId/);
  assert.throws(() => fake('{"threadId":"a","runId":"r"}').t3.sendThread('a', 'm'), /thread send.*status/);
  assert.throws(() => fake('{}').t3.showThread('a'), /thread show.*messages/);
  assert.throws(() => fake('{"messages":[],"thread":{"threadId":"a","updatedAt":"2026-01-01T00:00:00Z"}}').t3.showThread('a'), /thread show.*projectId/);
  assert.throws(() => fake('{}').t3.listThreads({ project: 'p' }), /thread list.*array/);
});

test('errors: unknown status names the status', () => {
  const body = JSON.parse(fx('thread-show-completed.json'));
  body.thread.status = 'weird';
  assert.throws(() => fake(JSON.stringify(body)).t3.showThread('a'), /unknown thread status: weird/);
  assert.throws(() => isActive({ status: 'weird', pending: 0 }), /weird/);
  assert.throws(() => isBlocked({ status: 'weird', pending: 0 }), /weird/);
  assert.throws(() => isTerminal({ status: 'weird', pending: 0 }), /weird/);
});

test('predicates cover every status', () => {
  for (const s of ['queued', 'preparing', 'starting', 'running']) {
    assert.equal(isActive({ status: s, pending: 0 }), true);
    assert.equal(isBlocked({ status: s, pending: 2 }), true);
    assert.equal(isTerminal({ status: s, pending: 0 }), false);
  }
  for (const s of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(isTerminal({ status: s, pending: 0 }), true);
    assert.equal(isActive({ status: s, pending: 0 }), false);
  }
});

test('defaultExec runs a real process', () => {
  const r = defaultExec(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(0,"utf8"))'], { input: 'hi' });
  assert.deepEqual(r, { code: 0, stdout: 'hi', stderr: '' });
  assert.throws(() => defaultExec('/nonexistent/bin', []), /failed to run/);
});

test('pending unknown from list: predicates throw, needsShow true, terminal unaffected', () => {
  const body = JSON.parse(fx('thread-list.json'));
  body[0].status = 'running';
  const rows = fake(JSON.stringify(body)).t3.listThreads({ project: 'p' });
  assert.equal(rows[0].pending, null);
  assert.equal(needsShow(rows[0]), true);
  assert.throws(() => isActive(rows[0]), /pending unknown for thread thread-0001; call showThread first/);
  assert.throws(() => isBlocked(rows[0]), /pending unknown for thread thread-0001/);
  assert.equal(needsShow(rows[1]), false);
  assert.equal(isTerminal(rows[1]), true);
  const shown = fake(fx('thread-show-waiting-question.json')).t3.showThread('x').thread;
  assert.equal(needsShow(shown), false);
  assert.equal(isBlocked(shown), true);
  assert.throws(() => needsShow({ id: 'a', status: 'weird', pending: null }), /weird/);
});

test('defaultExec passes cwd', () => {
  const r = defaultExec(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: '/' });
  assert.equal(r.stdout, '/');
});

test('defaultExec takes a reply over 1 MB (a worker pasting a diff must not wedge wait)', () => {
  const r = defaultExec(process.execPath, ['-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.length, 3 * 1024 * 1024);
});
