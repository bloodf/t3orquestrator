// Notes, never stops: threads in the project that orq did not start, and files under .orq/ the kit did not write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { strayFiles, strayNotes, strayThreads } from '../lib/strays.mjs';
import { run } from '../lib/cli.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const th = (id, status = 'running', branch = null) => ({ id, status, branch });

test('strayThreads: threads at work with no lease, on no orq branch, other than the orchestrator', () => {
  const threads = [
    th('leased'), th('worker', 'running', 'orq/p1/a-a1'), th('orch'), th('self'), th('done', 'completed'),
    th('hand-1'), th('hand-2', 'starting', 'feature/x'),
  ];
  assert.deepEqual(strayThreads(threads, [{ threadId: 'leased' }], ['orch', 'self', null]), ['hand-1', 'hand-2']);
  assert.deepEqual(strayThreads([], []), []);
});

test('strayFiles: entries of .orq/ the kit does not write; temp files and lock guards are not named', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  const dir = path.join(p.repo, '.orq');
  for (const f of ['merge_gate.py', 'authority-1-readback.json', '.plan.json.123.abc.tmp', 'lock.takeover', 'memory.md', 'capabilities.json']) {
    await fs.writeFile(path.join(dir, f), 'x');
  }
  await fs.mkdir(path.join(dir, 'orders'), { recursive: true });
  assert.deepEqual(await strayFiles(p.repo), ['authority-1-readback.json', 'merge_gate.py']);
  assert.deepEqual(await strayFiles(path.join(p.root, 'nowhere')), []);
});

test('strayNotes: one note per kind, naming at most five', () => {
  assert.deepEqual(strayNotes([], []), []);
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.deepEqual(strayNotes(['t1'], files), [
    'note: 1 thread(s) in this project run without an orq lease (started outside orq): t1; start work only as orq units',
    'note: .orq/ holds 7 file(s) orq did not write: a, b, c, d, e and 2 more; orq status and the ledger are the record',
  ]);
});

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const row = (id, status, branch = null) => ({
  threadId: id, projectId: 'p', status, updatedAt: new Date(NOW).toISOString(), itemCount: 1, branch,
});

test('status and wait name a hand-started thread and a stray .orq/ file in notes, and go on', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  await fs.writeFile(path.join(p.repo, '.orq', 'merge_gate.py'), 'x');
  const rows = [row('mcp:hand', 'running', 'feature/x'), row('mcp:old', 'completed')];
  const exec = (_bin, args) => ({ code: 0, stdout: args[1] === 'list' ? JSON.stringify(rows) : '{}', stderr: '' });
  const orq = async (args) => {
    const out = [];
    const code = await run(args, {
      stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, env: p.env, cwd: p.repo, now: () => NOW, stdin: async () => '', sleep: async () => {},
      deps: { readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }), exec },
    });
    return { code, out: out.join('') };
  };
  const threadNote = 'note: 1 thread(s) in this project run without an orq lease (started outside orq): mcp:hand; start work only as orq units';
  const fileNote = 'note: .orq/ holds 1 file(s) orq did not write: merge_gate.py; orq status and the ledger are the record';
  const s = await orq(['status']);
  assert.equal(s.code, 0);
  assert.ok(s.out.includes(threadNote) && s.out.includes(fileNote), s.out);
  const w = await orq(['wait', '--max-seconds', '1']);
  assert.equal(w.code, 0);
  assert.ok(w.out.includes(threadNote) && w.out.includes(fileNote), w.out);
});
