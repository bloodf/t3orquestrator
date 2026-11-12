import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withLock } from '../lib/lock.mjs';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', ...args], { stdio: 'inherit' });
  p.on('error', reject);
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited ${c}`))));
});

async function exitedPid() {
  const p = spawn(process.execPath, ['-e', '0']);
  const pid = p.pid;
  await new Promise((r) => p.on('exit', r));
  return pid;
}

const deadPid = 424242;
const isAlive = (pid) => pid === process.pid;
const clock = () => {
  let t = Date.now();
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
const owner = (file, o) => fs.writeFile(file, JSON.stringify(o));
const ago = async (file, ms) => {
  const d = new Date(Date.now() - ms);
  await fs.utimes(file, d, d);
};

test('withLock returns fn result, releases, leaves no files', async (t) => {
  const dir = await tmp(t);
  assert.equal(await withLock(path.join(dir, 'l.lock'), async () => 7), 7);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('withLock releases when fn throws and the original error surfaces', async (t) => {
  const dir = await tmp(t);
  await assert.rejects(withLock(path.join(dir, 'l.lock'), async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('withLock does not take over a live holder however old the lock', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: process.pid, token: 'a' });
  await ago(lock, 3600000);
  await assert.rejects(
    withLock(lock, async () => 1, { timeoutMs: 100, ...clock() }),
    new RegExp(`lock busy: .*l\\.lock \\(held by pid ${process.pid}; if that process is not orq, delete the file\\)`),
  );
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'a');
});

test('withLock takes over a dead owner immediately', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  const sleep = async () => { throw new Error('must not wait'); };
  assert.equal(await withLock(lock, async () => 'ok', { isAlive, sleep }), 'ok');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('two concurrent takers of one dead lock never overlap', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  let inside = 0;
  let peak = 0;
  let entered = 0;
  const job = () => withLock(lock, async () => {
    inside += 1;
    entered += 1;
    peak = Math.max(peak, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside -= 1;
  }, { isAlive });
  await Promise.all([job(), job(), job()]);
  assert.equal(peak, 1);
  assert.equal(entered, 3);
});

test('release throws "lock lost" when the lock was replaced', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await assert.rejects(
    withLock(lock, async () => {
      await fs.rm(lock);
      await owner(lock, { pid: process.pid, token: 'other' });
    }),
    new RegExp('lock lost: .*l\\.lock'),
  );
});

test('original error survives a failed release', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await assert.rejects(
    withLock(lock, async () => { await fs.rm(lock); throw new Error('boom'); }),
    (e) => e.message === 'boom' && /lock lost/.test(e.suppressed.message),
  );
});

test('unreadable owner record counts as held while fresh, stale once older than 5s', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await fs.writeFile(lock, 'garbage');
  await assert.rejects(withLock(lock, async () => 1, { timeoutMs: 100, ...clock() }), /held by pid unknown/);
  await ago(lock, 10000);
  assert.equal(await withLock(lock, async () => 'ok'), 'ok');
});


test('a takeover guard held by a dead owner is cleared however fresh', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  await owner(`${lock}.takeover`, { pid: deadPid, token: 'g' });
  assert.equal(await withLock(lock, async () => 'ok', { isAlive }), 'ok');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('a takeover guard held by a live owner is never cleared by age', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  await owner(`${lock}.takeover`, { pid: process.pid, token: 'g' });
  await ago(`${lock}.takeover`, 3600000);
  await assert.rejects(withLock(lock, async () => 1, { isAlive, timeoutMs: 100, ...clock() }), /lock busy/);
  await fs.stat(`${lock}.takeover`);
});

test('an unparseable takeover guard is cleared once older than 5s', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  await fs.writeFile(`${lock}.takeover`, 'garbage');
  await assert.rejects(withLock(lock, async () => 1, { isAlive, timeoutMs: 100, ...clock() }), /lock busy/);
  await ago(`${lock}.takeover`, 10000);
  assert.equal(await withLock(lock, async () => 'ok', { isAlive }), 'ok');
});

test('owner records need a positive integer pid and a non-empty token', async (t) => {
  const bad = [{ pid: 0, token: 'a' }, { pid: -3, token: 'a' }, { pid: '5', token: 'a' }, { pid: 1.5, token: 'a' }, { pid: 7, token: '' }, { pid: 7 }];
  for (const rec of bad) {
    const dir = await tmp(t);
    const lock = path.join(dir, 'l.lock');
    await owner(lock, rec);
    await assert.rejects(withLock(lock, async () => 1, { isAlive: () => false, timeoutMs: 100, ...clock() }), /held by pid unknown/);
    await ago(lock, 10000);
    assert.equal(await withLock(lock, async () => 'ok', { isAlive: () => false }), 'ok');
  }
});

test('takeover is serialized by the guard: a second taker waits out the first', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  const events = [];
  let aSlept;
  const aSleptP = new Promise((r) => { aSlept = r; });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let second;
  const first = withLock(lock, async () => { events.push('first-in'); }, {
    isAlive,
    onBeforeTakeover: async () => {
      events.push('seam');
      second = withLock(lock, async () => { events.push('second-in'); }, {
        isAlive,
        sleep: async (ms) => { aSlept(); await delay(ms); },
      });
      await Promise.race([aSleptP, delay(300)]);
      events.push('seam-end');
    },
  });
  await first;
  await second;
  assert.ok(events.indexOf('second-in') > events.indexOf('seam-end'), events.join(','));
  assert.deepEqual(events.filter((e) => e.endsWith('-in')), ['first-in', 'second-in']);
});

test('takeover leaves a lock that was replaced by a live owner after the stale read', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'l.lock');
  await owner(lock, { pid: deadPid, token: 'x' });
  let entered = false;
  await assert.rejects(withLock(lock, async () => { entered = true; }, {
    isAlive,
    timeoutMs: 100,
    ...clock(),
    onBeforeTakeover: async () => {
      await fs.rm(lock);
      await owner(lock, { pid: process.pid, token: 'live' });
    },
  }), /lock busy/);
  assert.equal(entered, false);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'live');
});

test('cross-process: four children taking over one dead lock lose no updates', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'c.lock');
  const counter = path.join(dir, 'counter');
  await fs.writeFile(counter, '0');
  await owner(lock, { pid: await exitedPid(), token: 'dead' });
  const code = `
    const { withLock } = await import(process.argv[1]);
    const fs = await import('node:fs');
    for (let i = 0; i < 25; i += 1) {
      await withLock(process.argv[2], async () => {
        const n = Number(fs.readFileSync(process.argv[3], 'utf8'));
        await new Promise((r) => setImmediate(r));
        fs.writeFileSync(process.argv[3], String(n + 1));
      });
    }`;
  const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  await Promise.all([0, 1, 2, 3].map(() => run([code, lockUrl, lock, counter])));
  assert.equal(await fs.readFile(counter, 'utf8'), '100');
});

test('cross-process: two children incrementing a shared counter lose no updates', async (t) => {
  const dir = await tmp(t);
  const lock = path.join(dir, 'c.lock');
  const counter = path.join(dir, 'counter');
  await fs.writeFile(counter, '0');
  const code = `
    const { withLock } = await import(process.argv[1]);
    const fs = await import('node:fs');
    for (let i = 0; i < 50; i += 1) {
      await withLock(process.argv[2], async () => {
        const n = Number(fs.readFileSync(process.argv[3], 'utf8'));
        await new Promise((r) => setImmediate(r));
        fs.writeFileSync(process.argv[3], String(n + 1));
      });
    }`;
  const lockUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  await Promise.all([run([code, lockUrl, lock, counter]), run([code, lockUrl, lock, counter])]);
  assert.equal(await fs.readFile(counter, 'utf8'), '100');
});
