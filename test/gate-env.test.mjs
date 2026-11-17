// What a gate tells its commands: the env and the changed-file lists (gate-env.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gateEnv } from '../lib/gate-env.mjs';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

async function dir(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-env-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, '.orq', 'units', 'a'), { recursive: true });
  return cwd;
}
const git = (files) => ({ changedFiles: () => (files instanceof Error ? (() => { throw files; })() : files) });
const env = (cwd, files, over = {}) => gateEnv({
  git: git(files), cwd, id: 'a', attempt: 1, baseSha: BASE, headSha: HEAD, job: 'implement', ...over,
});
const read = (f) => fs.readFile(f, 'utf8');

test('gateEnv: changed and deleted lists from the diff; a rename lists its old path as deleted', async (t) => {
  const cwd = await dir(t);
  const e = await env(cwd, [{ status: 'M', path: 'a.ts' }, { status: 'R', path: 'new.ts' }, { status: 'D', path: 'old.ts' }, { status: 'A', path: 'b.ts' }, { status: 'D', path: 'gone.ts' }]);
  assert.deepEqual([e.ORQ_GATE, e.ORQ_BASE_SHA, e.ORQ_UNIT_JOB], ['unit', BASE, 'implement']);
  assert.equal(await read(e.ORQ_CHANGED_FILES), 'a.ts\nnew.ts\nb.ts\n');
  assert.equal(await read(e.ORQ_DELETED_FILES), 'old.ts\ngone.ts\n');
});

test('gateEnv: no lists when they would mislead: a fix unit, a git error, a path with a newline, a list it cannot write', async (t) => {
  const cwd = await dir(t);
  const bare = { ORQ_GATE: 'unit', ORQ_BASE_SHA: BASE };
  assert.deepEqual(await env(cwd, [{ status: 'M', path: 'a.ts' }], { job: 'fix' }), { ...bare, ORQ_UNIT_JOB: 'fix' });
  assert.deepEqual(await env(cwd, new Error('git diff failed')), { ...bare, ORQ_UNIT_JOB: 'implement' });
  assert.deepEqual(await env(cwd, [{ status: 'M', path: 'a\nb.ts' }]), { ...bare, ORQ_UNIT_JOB: 'implement' });
  assert.deepEqual(await env(path.join(cwd, 'missing'), [{ status: 'M', path: 'a.ts' }]), { ...bare, ORQ_UNIT_JOB: 'implement' });
  assert.deepEqual(await env(cwd, [], { final: true }), { ORQ_GATE: 'final' });
});
