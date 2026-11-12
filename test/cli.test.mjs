import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/cli.mjs';

const GIB = 1024 ** 3;
const machine = () => ({ cores: 10, availableMemBytes: 12.3 * GIB, load1: 2.1 });

async function invoke(args, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-cli-'));
  const out = [];
  const err = [];
  const code = await run(args, {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    env: { T3ORQ_HOME: dir },
    cwd: dir,
    readMachine: machine,
    ...extra,
  });
  await fs.rm(dir, { recursive: true, force: true });
  return { code, out: out.join(''), err: err.join('') };
}

test('probe prints summary line and reasons', async () => {
  const r = await invoke(['probe']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'cap=5 cores=10 mem_gb=12.3 load1=2.10 reasons="cpu: 10 cores allow 5"\n');
  assert.equal(r.err, '');
});

test('probe --json prints one JSON object', async () => {
  const r = await invoke(['probe', '--json']);
  assert.equal(r.code, 0);
  const obj = JSON.parse(r.out);
  assert.equal(obj.cap, 5);
  assert.equal(obj.cores, 10);
  assert.ok(Array.isArray(obj.reasons));
  assert.equal(r.out.trim().split('\n').length, 1);
});

test('probe honours cap override from machine config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-cli-'));
  await fs.writeFile(path.join(dir, 'config.json'), '{"cap": 2}');
  const out = [];
  const code = await run(['probe'], {
    stdout: { write: (s) => out.push(s) }, stderr: { write() {} },
    env: { T3ORQ_HOME: dir }, cwd: dir, readMachine: machine,
  });
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.match(out.join(''), /^cap=2 /);
  assert.match(out.join(''), /reasons="override"/);
});

test('probe rejects unknown flags with exit 2', async () => {
  const r = await invoke(['probe', '--bogus']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.equal(r.err.trim().split('\n').length, 1);
  assert.match(r.err, /--bogus/);
});

test('probe includes machine notes in reasons', async () => {
  const r = await invoke(['probe'], { readMachine: () => ({ ...machine(), notes: ['mem: fallback to os.freemem (x)'] }) });
  assert.match(r.out, /reasons="cpu: 10 cores allow 5; mem: fallback to os\.freemem \(x\)"/);
});

test('help, --help and no args list commands', async () => {
  for (const args of [['help'], ['--help'], []]) {
    const r = await invoke(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /probe/);
    assert.match(r.out, /help/);
  }
});

test('--version prints package version', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const r = await invoke(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), pkg.version);
});

test('unknown command exits 2 with one-line stderr listing commands', async () => {
  const r = await invoke(['frobnicate']);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.equal(r.err.trim().split('\n').length, 1);
  assert.match(r.err, /unknown command "frobnicate"/);
  assert.match(r.err, /probe/);
});

test('thrown errors become "orq: message" with exit 1', async () => {
  const r = await invoke(['probe'], { readMachine: () => { throw new Error('boom'); } });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'orq: boom\n');
});

test('smoke: bin/orq.mjs --version', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/orq.mjs', import.meta.url)), '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});
