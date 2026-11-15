import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { provenProject } from '../lib/archive-move.mjs';

async function project(t, archives) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-proven-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(archives)) {
    const dir = path.join(cwd, '.orq', 'archive', name);
    await fs.mkdir(dir, { recursive: true });
    if (lines !== null) await fs.writeFile(path.join(dir, 'ledger.jsonl'), lines.map((e) => JSON.stringify(e)).join('\n'));
  }
  return cwd;
}

test('provenProject: only an archived plan that integrated a unit proves the setup', async (t) => {
  const started = { type: 'plan-started', planId: 'p1' };
  assert.equal(await provenProject(await project(t, {})), false); // no archive directory at all
  assert.equal(await provenProject(await project(t, { p1: [started, { type: 'needs-judgment', unit: 'a' }] })), false); // every unit failed
  assert.equal(await provenProject(await project(t, { 'unstarted-abc': null })), false); // archived before it started
  assert.equal(await provenProject(await project(t, { '.p2.tmp': [started, { type: 'integrated', unit: 'a' }] })), false); // staging, not an archive
  assert.equal(await provenProject(await project(t, { p1: [started], p2: [started, { type: 'integrated', unit: 'a', head: 'h' }] })), true);
});

test('provenProject: an archive path that is a file counts as not proven, without throwing', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-proven-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, '.orq'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.orq', 'archive'), 'not a directory');
  assert.equal(await provenProject(cwd), false);
});
