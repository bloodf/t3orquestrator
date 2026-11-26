// A lease marks one thread launched by orq; the machine-wide cap counts leases, a project's own cap counts its leases.
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

// The slots one project may still fill: the machine cap less every active lease and, when the project sets its own
// cap, that cap less the project's active leases (every orq thread of the project: units, reviews, decisions).
// by: the limit in force, the smaller of the two (the machine's on a tie).
export function freeSlots({
  cap, projectCap, project, leases, now, ttlMs,
}) {
  const machine = cap - countActive(leases, now, ttlMs);
  if (projectCap === undefined || projectCap === null) return { slots: machine, by: 'machine' };
  const own = projectCap - countActive(leases.filter((l) => l.project === project), now, ttlMs);
  return own < machine ? { slots: own, by: 'project' } : { slots: machine, by: 'machine' };
}

// A gate lease marks one running gate (a unit's or a final run) of any project on this machine: the machine-wide
// gate budget (`gateCap`) counts them, so many projects' gates do not start at once. One file per gate-run pid.
// A lease whose pid is gone, or older than any gate runs, holds nothing (a pid the OS reused is not counted forever).
export const GATE_LEASE_MAX_MS = 2 * 24 * 60 * 60_000;
export const defaultGateCap = (cores) => Math.max(2, Math.floor(cores / 8));

export async function liveGateLeases(dir, { isAlive, now }) {
  const names = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  const all = await Promise.all(names.filter((n) => /^\d+\.json$/.test(n)).map((n) => readJson(path.join(dir, n), null).catch(() => null)));
  return all.filter((l) => Number.isInteger(l?.pid) && isAlive(l.pid) && now - (l.startedAt ?? 0) < GATE_LEASE_MAX_MS);
}

export async function writeGateLease(dir, lease) {
  if (!(Number.isInteger(lease?.pid) && lease.pid > 0)) throw new Error('gate lease pid must be a positive integer');
  await writeJsonAtomic(path.join(dir, `${lease.pid}.json`), lease);
}

export async function removeGateLease(dir, pid) {
  if (Number.isInteger(pid) && pid > 0) await fs.rm(path.join(dir, `${pid}.json`), { force: true });
}
