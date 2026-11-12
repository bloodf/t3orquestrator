import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, writeJsonAtomic, appendLine, readLines } from '../lib/store.mjs';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('readJson returns fallback when missing', async (t) => {
  const dir = await tmp(t);
  assert.deepEqual(await readJson(path.join(dir, 'nope.json'), { a: 1 }), { a: 1 });
});

test('readJson throws naming the file on invalid JSON', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'bad.json');
  await fs.writeFile(file, '{oops');
  await assert.rejects(readJson(file, null), (e) => e.message.includes(file));
});

test('writeJsonAtomic round-trips, pretty prints, leaves no temp file', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'deep', 'a.json');
  await writeJsonAtomic(file, { x: [1, 2] });
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, '{\n  "x": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(await readJson(file, null), { x: [1, 2] });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['a.json']);
});

test('writeJsonAtomic overwrites existing file', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'a.json');
  await writeJsonAtomic(file, { v: 1 });
  await writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(await readJson(file, null), { v: 2 });
});

test('appendLine and readLines round-trip', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'sub', 'l.jsonl');
  await appendLine(file, { n: 1 });
  await appendLine(file, { n: 2 });
  assert.deepEqual(await readLines(file), [{ n: 1 }, { n: 2 }]);
});

test('readLines returns [] when missing and skips blank lines', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  assert.deepEqual(await readLines(file), []);
  await fs.writeFile(file, '{"a":1}\n\n{"a":2}\n');
  assert.deepEqual(await readLines(file), [{ a: 1 }, { a: 2 }]);
});

test('readLines names file and line number on corrupt line', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  await fs.writeFile(file, '{"a":1}\nnot json\n');
  await assert.rejects(readLines(file), (e) => e.message.includes(file) && e.message.includes('line 2'));
});

test('readLines ignores a torn final segment', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"a":');
  assert.deepEqual(await readLines(file), [{ a: 1 }]);
});

test('appendLine repairs a torn tail and reports it', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"a":');
  assert.deepEqual(await appendLine(file, { b: 2 }), { repaired: true });
  assert.deepEqual(await readLines(file), [{ a: 1 }, { b: 2 }]);
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'));
  await fs.writeFile(file, '{"a":');
  assert.deepEqual(await appendLine(file, { c: 3 }), { repaired: true });
  assert.deepEqual(await readLines(file), [{ c: 3 }]);
  assert.deepEqual(await appendLine(file, { d: 4 }), { repaired: false });
});

test('appendLine on a missing file does not repair', async (t) => {
  const dir = await tmp(t);
  assert.deepEqual(await appendLine(path.join(dir, 'n.jsonl'), { a: 1 }), { repaired: false });
});

test('appendLine and writeJsonAtomic reject non-serializable values', async (t) => {
  const dir = await tmp(t);
  await assert.rejects(appendLine(path.join(dir, 'a.jsonl'), undefined), /not JSON-serializable/);
  await assert.rejects(writeJsonAtomic(path.join(dir, 'a.json'), () => 1), /not JSON-serializable/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('readLines returns a valid final record that lacks a newline', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"b":2}');
  assert.deepEqual(await readLines(file), [{ a: 1 }, { b: 2 }]);
});

test('appendLine keeps a valid unterminated tail and adds the newline', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, 'l.jsonl');
  await fs.writeFile(file, '{"a":1}\n{"b":2}');
  assert.deepEqual(await appendLine(file, { c: 3 }), { repaired: false });
  assert.deepEqual(await readLines(file), [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
});

test('appendLine leaves no lock file behind', async (t) => {
  const dir = await tmp(t);
  await appendLine(path.join(dir, 'l.jsonl'), { a: 1 });
  assert.deepEqual(await fs.readdir(dir), ['l.jsonl']);
});

test('cross-process: concurrent appenders to a torn file lose no records', async (t) => {
  const code = `
    const { appendLine } = await import(process.argv[1]);
    for (let i = 0; i < 4; i += 1) await appendLine(process.argv[2], { c: process.argv[3], i });`;
  const storeUrl = new URL('../lib/store.mjs', import.meta.url).href;
  const child = (file, id) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, storeUrl, file, String(id)], { stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited ${c}`))));
  });
  for (let round = 0; round < 10; round += 1) {
    const dir = await tmp(t);
    const file = path.join(dir, 'l.jsonl');
    await fs.writeFile(file, '{"g":0}\n{"torn":');
    await Promise.all([0, 1, 2, 3].map((id) => child(file, id)));
    const lines = await readLines(file);
    assert.equal(lines.length, 17, `round ${round}`);
    assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'));
  }
});
