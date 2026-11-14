import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writeLease, removeLease, listLeases, runningByInstance, hasLease, setLeaseBlocked, countActive, liveLeases, freeSlots,
} from '../lib/leases.mjs';

const lease = (threadId, instance = 'a') => ({
  threadId, project: 'p', unit: 'u1', instance, model: 'm', startedAt: 5,
});
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'orq-leases-'));

test('write, has, list, remove', async () => {
  const dir = path.join(await tmp(), 'leases');
  assert.deepEqual(await listLeases(dir), []);
  assert.equal(await hasLease(dir, 't1'), false);
  await writeLease(dir, lease('mcp:t1'));
  await writeLease(dir, lease('t2', 'b'));
  assert.equal(await hasLease(dir, 'mcp:t1'), true);
  const all = await listLeases(dir);
  assert.deepEqual(all.map((l) => l.threadId).sort(), ['mcp:t1', 't2']);
  await removeLease(dir, 'mcp:t1');
  await removeLease(dir, 'mcp:t1');
  assert.deepEqual((await listLeases(dir)).map((l) => l.threadId), ['t2']);
});

test('writeLease validates fields', async () => {
  const dir = await tmp();
  await assert.rejects(writeLease(dir, { ...lease('t'), unit: '' }), /lease.unit/);
  await assert.rejects(writeLease(dir, { ...lease('t'), startedAt: 'x' }), /lease.startedAt/);
  await assert.rejects(writeLease(dir, { ...lease('../x') }), /threadId/);
});

test('corrupt lease file throws naming it', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'bad.json'), '{nope');
  await assert.rejects(listLeases(dir), /bad\.json/);
});

test('runningByInstance counts per instance', () => {
  assert.deepEqual(runningByInstance([lease('1'), lease('2'), lease('3', 'b')]), { a: 2, b: 1 });
  assert.deepEqual(runningByInstance([]), {});
});

test('setLeaseBlocked flips the flag; countActive skips blocked leases', async () => {
  const dir = await tmp();
  await writeLease(dir, lease('t1'));
  await writeLease(dir, lease('t2'));
  assert.equal(await setLeaseBlocked(dir, 't1', true), true);
  assert.equal(await setLeaseBlocked(dir, 'gone', true), false);
  const all = await listLeases(dir);
  assert.equal(all.find((l) => l.threadId === 't1').blocked, true);
  assert.equal(countActive(all), 1);
  await setLeaseBlocked(dir, 't1', false);
  assert.equal(countActive(await listLeases(dir)), 2);
  await assert.rejects(writeLease(dir, { ...lease('t3'), blocked: 'yes' }), /lease.blocked/);
});

test('leases whose heartbeat is older than the TTL do not count', () => {
  const now = 100 * 60_000;
  const ttl = 30 * 60_000;
  const fresh = { ...lease('1'), heartbeatAt: now - 1000 };
  const old = { ...lease('2', 'b'), heartbeatAt: now - ttl - 1 };
  const legacy = { ...lease('3'), startedAt: now - ttl - 1 };
  assert.equal(countActive([fresh, old, legacy], now, ttl), 1);
  assert.deepEqual(runningByInstance([fresh, old, legacy], now, ttl), { a: 1 });
  assert.deepEqual(liveLeases([fresh, old], now, ttl), [fresh]);
  assert.equal(countActive([fresh, old, legacy]), 3);
});

test('freeSlots: the smaller of the machine cap and the project cap, each less its own active leases', () => {
  const own = (id, over = {}) => ({ ...lease(id), project: '/p', ...over });
  const other = (id) => ({ ...lease(id), project: '/q' });
  // no project cap: the machine cap alone, as before
  assert.deepEqual(freeSlots({ cap: 4, leases: [own('1'), other('2')], project: '/p' }), { slots: 2, by: 'machine' });
  assert.deepEqual(freeSlots({ cap: 4, projectCap: null, leases: [], project: '/p' }), { slots: 4, by: 'machine' });
  // a project cap below the machine's binds this project only
  assert.deepEqual(freeSlots({ cap: 4, projectCap: 2, leases: [own('1')], project: '/p' }), { slots: 1, by: 'project' });
  assert.deepEqual(freeSlots({ cap: 4, leases: [own('1')], project: '/q' }), { slots: 3, by: 'machine' });
  // another project's leases use the machine cap, not this project's cap; blocked leases count for neither
  assert.deepEqual(freeSlots({ cap: 4, projectCap: 2, leases: [other('2'), other('3'), other('4')], project: '/p' }), { slots: 1, by: 'machine' });
  assert.deepEqual(freeSlots({ cap: 4, projectCap: 1, leases: [own('1', { blocked: true }), other('2')], project: '/p' }), { slots: 1, by: 'project' });
  assert.deepEqual(freeSlots({ cap: 4, projectCap: 3, leases: [other('2')], project: '/p' }), { slots: 3, by: 'machine' }); // a tie: the machine's
});
