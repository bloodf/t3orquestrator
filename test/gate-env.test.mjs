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

test('gateEnv: a final run lists what changed since the last green final head, or runs everything without one', async (t) => {
  const cwd = await dir(t);
  await fs.mkdir(path.join(cwd, '.orq', 'units', 'integration'), { recursive: true });
  const calls = [];
  const spy = { changedFiles: (_c, base, head) => { calls.push([base, head]); return [{ status: 'M', path: 'a.ts' }, { status: 'D', path: 'b.ts' }]; } };
  const fin = (over) => gateEnv({
    git: spy, cwd, id: 'integration', attempt: 1, baseSha: BASE, headSha: HEAD, final: true, ...over,
  });
  const green = 'd'.repeat(40);
  const e = await fin({ sinceSha: green });
  assert.deepEqual([e.ORQ_GATE, e.ORQ_BASE_SHA, calls], ['final', green, [[green, HEAD]]]);
  assert.equal(await read(e.ORQ_CHANGED_FILES), 'a.ts\n');
  assert.equal(await read(e.ORQ_DELETED_FILES), 'b.ts\n');
  assert.deepEqual(await fin({}), { ORQ_GATE: 'final' }); // no green head yet: everything
  assert.deepEqual(await fin({ sinceSha: HEAD }), { ORQ_GATE: 'final' }); // the head itself was green: a rerun runs everything
});
