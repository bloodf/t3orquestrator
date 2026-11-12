import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const isMissing = (e) => e && e.code === 'ENOENT';
const rand = () => randomBytes(8).toString('hex');
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNREADABLE_STALE_MS = 5000;

// ponytail: pid liveness assumes one host and no pid reuse within a critical section; a home directory shared over the network needs a heartbeat instead.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Atomically create `target` already containing `record` (link of a private temp file).
async function createWithContent(target, record) {
  const tmp = `${target}.${process.pid}.${rand()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record));
  try {
    await fs.link(tmp, target);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

function parseOwner(text) {
  try {
    const o = JSON.parse(text);
    if (Number.isInteger(o.pid) && o.pid > 0 && typeof o.token === 'string' && o.token !== '') return o;
  } catch {
    // not JSON: reported as an unknown owner below
  }
  return null;
}

// -> undefined when the file is gone, else {owner|null, mtimeMs}
async function readOwner(file) {
  try {
    const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { owner: parseOwner(text), mtimeMs: st.mtimeMs };
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

const identity = (held) => (held.owner ? held.owner.token : `mtime:${held.mtimeMs}`);

function isStale(held, { isAlive, now }) {
  if (held.owner) return !isAlive(held.owner.pid);
  return now() - held.mtimeMs > UNREADABLE_STALE_MS;
}

const same = (held, seen) => held !== undefined && identity(held) === identity(seen);

// Remove a stale lock under a guard so two takers cannot unlink each other's fresh lock.
// -> true when this caller held the guard (and so should retry at once).
async function takeover(lockPath, seen, deps) {
  const guard = `${lockPath}.takeover`;
  if (!(await createWithContent(guard, { pid: process.pid, token: rand() }))) {
    const g = await readOwner(guard);
    // ponytail: clearing a dead guard is check-then-unlink; after a crash inside the guard, two racing
    // takers can both hold it and break exclusion once. Fix with rename-to-tomb + token verify if it matters.
    if (g && isStale(g, deps)) await fs.rm(guard, { force: true });
    return false;
  }
  try {
    if (deps.onBeforeTakeover) await deps.onBeforeTakeover();
    if (same(await readOwner(lockPath), seen) && same(await readOwner(lockPath), seen)) {
      await fs.rm(lockPath, { force: true });
    }
  } finally {
    await fs.rm(guard, { force: true });
  }
  return true;
}

async function release(lockPath, token) {
  const held = await readOwner(lockPath);
  if (!held || !held.owner || held.owner.token !== token) throw new Error(`lock lost: ${lockPath}`);
  await fs.rm(lockPath, { force: true });
}

async function acquire(lockPath, me, deps) {
  const deadline = deps.now() + deps.timeoutMs;
  for (;;) {
    if (await createWithContent(lockPath, me)) return;
    const held = await readOwner(lockPath);
    if (held && isStale(held, deps) && (await takeover(lockPath, held, deps))) continue;
    if (deps.now() >= deadline) {
      const pid = held && held.owner ? held.owner.pid : 'unknown';
      throw new Error(`lock busy: ${lockPath} (held by pid ${pid}; if that process is not orq, delete the file)`);
    }
    await deps.sleep(20);
  }
}

export async function withLock(lockPath, fn, opts = {}) {
  const {
    timeoutMs = 10000, isAlive = pidAlive, now = Date.now, sleep = realSleep,
    pid = process.pid, token = rand(), onBeforeTakeover,
  } = opts;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await acquire(lockPath, { pid, token }, { timeoutMs, isAlive, now, sleep, onBeforeTakeover });
  let result;
  let failure;
  try {
    result = await fn();
  } catch (e) {
    failure = { error: e };
  }
  try {
    await release(lockPath, token);
  } catch (releaseError) {
    if (!failure) throw releaseError;
    if (failure.error && typeof failure.error === 'object') failure.error.suppressed = releaseError;
  }
  if (failure) throw failure.error;
  return result;
}
