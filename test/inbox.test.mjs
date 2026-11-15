import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../lib/cli.mjs';
import { makeProject, unitSpec } from './support/project.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const ISO = new Date(NOW).toISOString();
const GIB = 1024 ** 3;
const HEAD = 'message: from the user, through orq inbox; read it and follow it before anything else';

async function orq(args, p, { stdin = '', now = NOW } = {}) {
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (x) => out.push(x) }, stderr: { write: (x) => err.push(x) }, env: p.env, cwd: p.repo, now: () => now, stdin: async () => stdin,
    deps: {
      readMachine: () => ({ cores: 8, availableMemBytes: 16 * GIB, load1: 0 }),
      exec: (_bin, args) => ({ code: 0, stdout: args[1] === 'list' ? '[]' : '{}', stderr: '' }), // never a real t3
    },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const orqPath = (p, ...f) => path.join(p.repo, '.orq', ...f);
const exists = (f) => fs.stat(f).then(() => true, () => false);

test('inbox appends a timestamped message per call, from args or stdin', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
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
