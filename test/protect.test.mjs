import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkProtect, protectError, protectReasons, protectText, PROBE_EVERY_MS,
} from '../lib/protect.mjs';

const GATEWAY = { name: 'gateway', url: 'http://127.0.0.1:11434/v1/models', timeoutMs: 500 };

async function home(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-protect-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// answers: one per probe, in order; a number is an HTTP status, an Error is thrown
function context(dir, answers) {
  const ctx = { env: { T3ORQ_HOME: dir }, clock: 1_000_000, calls: [] };
  ctx.now = () => ctx.clock;
  ctx.deps = {
    fetch: async (url, opts) => {
      ctx.calls.push([url, Boolean(opts.signal)]);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return { status: a, body: { cancel: async () => {} } };
    },
  };
  return ctx;
}

test('no protected services: nothing is probed and nothing holds', async (t) => {
  const ctx = context(await home(t), []);
  assert.deepEqual(await checkProtect(ctx, []), {});
  assert.deepEqual(protectReasons({}), []);
  assert.equal(ctx.calls.length, 0);
});

test('a service is probed at most once a minute; the cached answer serves every poll in between', async (t) => {
  const ctx = context(await home(t), [200, 200]);
  const first = await checkProtect(ctx, [GATEWAY]);
  assert.equal(first.gateway.ok, true);
  assert.deepEqual(ctx.calls, [[GATEWAY.url, true]]);
  ctx.clock += PROBE_EVERY_MS - 1;
  await checkProtect(ctx, [GATEWAY]);
  assert.equal(ctx.calls.length, 1);
  ctx.clock += 1;
  await checkProtect(ctx, [GATEWAY]);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(protectReasons(first), []);
});

test('a failing or slow service holds, and releases after two good probes in a row', async (t) => {
  const slow = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const ctx = context(await home(t), [slow, 502, 200, 200]);
  const step = async () => {
    const s = await checkProtect(ctx, [GATEWAY]);
    ctx.clock += PROBE_EVERY_MS;
    return protectReasons(s);
  };
  assert.deepEqual(await step(), ['protected service gateway is failing (no answer in 500 ms)']);
  assert.deepEqual(await step(), ['protected service gateway is failing (HTTP 502)']);
  assert.deepEqual(await step(), ['protected service gateway is recovering (1 of 2 good probes)']);
  assert.deepEqual(await step(), []);
});

test('an answer below 500 counts as alive: the service decides who may ask, not orq', async (t) => {
  const ctx = context(await home(t), [401]);
  const s = await checkProtect(ctx, [GATEWAY]);
  assert.equal(s.gateway.ok, true);
  assert.equal(protectText(s), 'gateway ok');
});

test('an unreadable cache is probed again instead of failing the poll', async (t) => {
  const dir = await home(t);
  await fs.writeFile(path.join(dir, 'protect.json'), '{broken');
  const ctx = context(dir, [200]);
  assert.equal((await checkProtect(ctx, [GATEWAY])).gateway.ok, true);
  await fs.writeFile(path.join(dir, 'protect.json'), 'null');
  ctx.deps.fetch = async () => ({ status: 503, body: null });
  assert.equal((await checkProtect(ctx, [GATEWAY])).gateway.error, 'HTTP 503');
});

test('protectError checks a stored list', () => {
  assert.equal(protectError(undefined), null);
  assert.equal(protectError([GATEWAY, { name: 'db', url: 'https://db.internal/health' }]), null);
  assert.match(protectError({}), /protect must be a list/);
  assert.match(protectError([{ name: 'a b', url: GATEWAY.url }]), /name must be/);
  assert.match(protectError([{ name: 'x', url: 'file:///etc/passwd' }]), /url must be an http/);
  assert.match(protectError([{ name: 'x', url: GATEWAY.url, timeoutMs: 5 }]), /timeoutMs must be an integer from 100 to 30000/);
  assert.match(protectError([GATEWAY, GATEWAY]), /duplicate name "gateway"/);
});
