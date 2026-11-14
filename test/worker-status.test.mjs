import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerStatus } from '../lib/worker-status.mjs';

test('parseWorkerStatus reads only the first non-empty line', () => {
  const table = [
    ['NEEDS_CONTEXT\nThe order says 41, the gate wants 42.', { status: 'NEEDS_CONTEXT', detail: 'The order says 41, the gate wants 42.' }],
    ['\n\n  **BLOCKED**:  \n\n  cannot reach the db  ', { status: 'BLOCKED', detail: 'cannot reach the db' }],
    ['## `needs_context`.\nwhich file?', { status: 'NEEDS_CONTEXT', detail: 'which file?' }],
    ['blocked:', { status: 'BLOCKED', detail: '' }],
    ['DONE\nall good', { status: 'DONE', detail: 'all good' }],
    ['Done_with_concerns!', { status: 'DONE_WITH_CONCERNS', detail: '' }],
    ['I finished.\nNEEDS_CONTEXT', { status: 'I FINISHED', detail: 'NEEDS_CONTEXT' }],
    ['', { status: '', detail: '' }],
    [null, { status: '', detail: '' }],
  ];
  for (const [text, want] of table) assert.deepEqual(parseWorkerStatus(text), want, JSON.stringify(text));
  assert.equal(parseWorkerStatus(`BLOCKED\n${'y'.repeat(300)}`).detail.length, 160);
});

test('parseWorkerStatus takes a reason given on the status line itself', () => {
  assert.deepEqual(parseWorkerStatus('Blocked: need the API key\nmore'), { status: 'BLOCKED', detail: 'need the API key' });
  assert.deepEqual(parseWorkerStatus('NEEDS_CONTEXT - which file?'), { status: 'NEEDS_CONTEXT', detail: 'which file?' });
  // A sentence that merely starts with the word is not a status line.
  assert.equal(parseWorkerStatus('Blocked tests are fixed now').status, 'BLOCKED TESTS ARE FIXED NOW');
});

test('parseWorkerStatus strips control characters from what it returns', () => {
  const got = parseWorkerStatus('BLOCKED\n\u001b[31mred\u001b[0m\u0007 text');
  assert.equal(got.status, 'BLOCKED');
  assert.equal(/[\u0000-\u001f\u007f]/.test(got.detail), false);
  assert.match(got.detail, /red.*text/);
});

test('parseStatusLine: any status set, the same tolerance, and the lines after the status', async () => {
  const { parseStatusLine } = await import('../lib/worker-status.mjs');
  const S = ['ANSWER', 'ESCALATE'];
  assert.deepEqual(parseStatusLine('**Answer** — use port 8080\n\nbecause the config says so\n- and the docs', S),
    { status: 'ANSWER', detail: 'use port 8080', rest: ['because the config says so', '- and the docs'] });
  assert.deepEqual(parseStatusLine('## `escalate`\nWhich account pays?\nwhy', S), { status: 'ESCALATE', detail: 'Which account pays?', rest: ['why'] });
  assert.equal(parseStatusLine('I think yes', S).status, 'I THINK YES');
  assert.equal(parseStatusLine(`ANSWER: ${'x'.repeat(600)}`, S, 400).detail.length, 400);
});

test('hidden characters in a worker report are replaced; ordinary text is unchanged', () => {
  assert.deepEqual(parseWorkerStatus('DONE: all\u202egood\u200bdone'), { status: 'DONE', detail: 'all good done' });
  assert.deepEqual(parseWorkerStatus('DONE: ça va – ok'), { status: 'DONE', detail: 'ça va – ok' });
});
