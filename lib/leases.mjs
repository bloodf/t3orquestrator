// A lease marks one thread launched by orq; the machine-wide cap counts leases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.mjs';

const STRINGS = ['threadId', 'project', 'unit', 'instance', 'model'];

function leaseFile(dir, threadId) {
  if (typeof threadId !== 'string' || threadId === '' || /[\\/]/.test(threadId)) {
    throw new Error(`lease.threadId must be a non-empty string without path separators, got ${threadId}`);
  }
  return path.join(dir, `${threadId}.json`);
}

export async function writeLease(dir, lease) {
  for (const k of STRINGS) {
    if (typeof lease?.[k] !== 'string' || lease[k] === '') throw new Error(`lease.${k} must be a non-empty string`);
  }
  if (!Number.isFinite(lease.startedAt)) throw new Error('lease.startedAt must be an epoch ms number');
  if (lease.blocked !== undefined && typeof lease.blocked !== 'boolean') throw new Error('lease.blocked must be a boolean');
  if (lease.heartbeatAt !== undefined && !Number.isFinite(lease.heartbeatAt)) throw new Error('lease.heartbeatAt must be an epoch ms number');
  await writeJsonAtomic(leaseFile(dir, lease.threadId), lease);
}

export async function removeLease(dir, threadId) {
  await fs.rm(leaseFile(dir, threadId), { force: true });
}

export async function hasLease(dir, threadId) {
  try {
    await fs.stat(leaseFile(dir, threadId));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

export async function listLeases(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  return Promise.all(files.map((n) => readJson(path.join(dir, n))));
}

export const DEFAULT_LEASE_TTL_MINUTES = 30;

// A lease not refreshed within the TTL belongs to a crashed or abandoned run and holds no slot.
// Without `now`, every lease is live.
export function liveLeases(leases, now, ttlMs) {
  return now === undefined ? leases : leases.filter((l) => (l.heartbeatAt ?? l.startedAt) >= now - ttlMs);
}

export function runningByInstance(leases, now, ttlMs) {
  return liveLeases(leases, now, ttlMs).reduce((acc, l) => ({ ...acc, [l.instance]: (acc[l.instance] ?? 0) + 1 }), {});
}

// A thread orq gave up on: the lease stays, still counting, but no longer belongs to its unit.
export async function abandonLease(dir, threadId) {
  const lease = await readJson(leaseFile(dir, threadId), null);
  if (lease === null) return false;
  await writeJsonAtomic(leaseFile(dir, threadId), { ...lease, abandoned: true });
  return true;
}

// A blocked lease (thread waiting on a request) keeps its record but frees its slot under the cap.
export async function setLeaseBlocked(dir, threadId, blocked) {
  const lease = await readJson(leaseFile(dir, threadId), null);
  if (lease === null) return false;
  await writeLease(dir, { ...lease, blocked });
  return true;
}

export const countActive = (leases, now, ttlMs) => liveLeases(leases, now, ttlMs).filter((l) => !l.blocked).length;
