// A lease marks one thread launched by orq; the machine-wide cap counts leases, a project's own cap counts its leases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
// gate budget (`gateCap`) counts them, so many projects' gates do not start at once. One file per gate, <id>.json.
// It is written as a reservation (owner: the `orq wait` that starts the gate) before the gate is spawned, then holds
// the gate's pid and that process's start time; the gate itself confirms it when it starts (`orq gate-run`), so a
// launch whose parent died half way is still counted. A pid whose process started at another time is a reused pid.
export const GATE_LEASE_MAX_MS = 2 * 24 * 60 * 60_000;
export const GATE_RESERVE_MS = 2 * 60_000; // a reservation the gate never confirmed
export const defaultGateCap = (cores) => Math.max(2, Math.floor(cores / 8));
const GATE_ID = /^[0-9a-f]{16}$/;
export const newGateLeaseId = () => randomBytes(8).toString('hex');

// The start time of a process as `ps` prints it, or null when it cannot be read (then a live pid is trusted).
export function processStart(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const sameProcess = (pid, start, { isAlive, procStart }) => {
  if (!(Number.isInteger(pid) && pid > 0 && isAlive(pid))) return false;
  if (typeof start !== 'string') return true;
  const now = procStart(pid);
  return now === null || now === start;
};

export function gateLeaseLive(l, { isAlive, procStart = processStart, now }) {
  if (l === null || typeof l !== 'object') return false;
  const age = now - (l.startedAt ?? 0);
  if (Number.isInteger(l.pid)) return age < GATE_LEASE_MAX_MS && sameProcess(l.pid, l.pidStart, { isAlive, procStart });
  return age < GATE_RESERVE_MS && sameProcess(l.owner, l.ownerStart, { isAlive, procStart });
}

// Every gate lease file. An unreadable one throws: a count or a keep list built without it would be wrong.
export async function readGateLeases(dir) {
  const names = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  return Promise.all(names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map(async (n) => ({ ...(await readJson(path.join(dir, n))), file: n })));
}

// For the budget an unreadable file counts as a running gate (it may be one): never fewer than are running.
export async function liveGateLeases(dir, deps) {
  const names = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  const all = await Promise.all(names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => readJson(path.join(dir, n), null).then((l) => ({ l }), () => ({ unreadable: true }))));
  return all.filter((x) => x.unreadable || gateLeaseLive(x.l, deps)).map((x) => x.l ?? { unreadable: true });
}

export async function writeGateLease(dir, lease) {
  if (!GATE_ID.test(lease?.id ?? '')) throw new Error('gate lease id must be 16 hex characters');
  await writeJsonAtomic(path.join(dir, `${lease.id}.json`), lease);
}

// The gate confirms its own lease: its pid and start time. Missing (the parent never wrote it): written now.
export async function confirmGateLease(dir, id, fields) {
  if (!GATE_ID.test(id ?? '')) return;
  const file = path.join(dir, `${id}.json`);
  const { reservation: _r, ...lease } = await readJson(file, null) ?? { startedAt: fields.startedAt };
  await writeJsonAtomic(file, {
    ...lease, id, pid: fields.pid, pidStart: fields.pidStart,
  });
}

export async function removeGateLease(dir, id) {
  if (GATE_ID.test(id ?? '')) await fs.rm(path.join(dir, `${id}.json`), { force: true });
}

// Remove the leases `match` picks (a finished gate's, found by project, unit and pid). Unreadable files stay.
export async function removeGateLeasesWhere(dir, match) {
  const names = await fs.readdir(dir).catch(() => []);
  for (const n of names.filter((x) => /^[0-9a-f]{16}\.json$/.test(x))) {
    const l = await readJson(path.join(dir, n), null).catch(() => null);
    if (l && match(l)) await fs.rm(path.join(dir, n), { force: true });
  }
}
