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

export function runningByInstance(leases) {
  return leases.reduce((acc, l) => ({ ...acc, [l.instance]: (acc[l.instance] ?? 0) + 1 }), {});
}
