// Plan start and unit launch. Locks are only held around file reads and writes, never around t3 or git.
import fs from 'node:fs/promises';
import path from 'node:path';
import { commit, readState, unitOf } from './ledger.mjs';
import {
  countActive, listLeases, removeLease, writeLease, DEFAULT_LEASE_TTL_MINUTES,
} from './leases.mjs';
import { emptyRegistry } from './registry.mjs';
import { markUsed, recordFailure } from './health.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { withLock } from './lock.mjs';
import { leasesDir, machineLockPath, registryPath } from './paths.mjs';

export const withMachine = (fx, fn) => withLock(machineLockPath(fx.env), fn);

export function updateRegistry(fx, fn) {
  return withMachine(fx, async () => {
    const file = registryPath(fx.env);
    await writeJsonAtomic(file, fn(await readJson(file, emptyRegistry())));
  });
}

export function failureText(failures) {
  return failures.map((f) => `- ${f}`).join('\n');
}

export async function ensurePlanStarted(fx, { plan, config }) {
  const current = await readState(fx.cwd);
  if (current.plan.planId !== null) return current.plan;
  const baseSha = fx.git.resolveSha(fx.cwd, plan.base || config.base); // subprocess: before the lock
  const planId = Math.floor(fx.now() / 1000).toString(36);
  const { state } = await commit(fx.cwd, (s) => (s.plan.planId !== null ? [] : [{
    type: 'plan-started', unit: null, at: fx.now(), planId, baseSha, integrationBranch: `orq/${planId}/integration`,
  }]));
  return state.plan;
}

const isDropped = (state, unit) => unitOf(state, unit).state === 'dropped';

export const ttlMs = (config) => (config.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;

// Under the machine lock: re-count the leases that hold a slot and reserve one, or return null.
export async function reserve(fx, a, cap, ttlMs) {
  const dir = leasesDir(fx.env);
  const id = `reserve-${process.pid}-${a.unit}-a${a.attempt}`;
  return withMachine(fx, async () => {
    if (countActive(await listLeases(dir), fx.now(), ttlMs) >= cap) return null;
    await writeLease(dir, {
      threadId: id, project: fx.cwd, unit: a.unit, instance: a.instance, model: a.model, startedAt: fx.now(),
      heartbeatAt: fx.now(), blocked: false, reservation: true, ...(a.mark ?? {}),
    });
    return id;
  });
}

async function startFailed(fx, a, launched, reservation, error) {
  await withMachine(fx, () => removeLease(leasesDir(fx.env), reservation));
  await commit(fx.cwd, (s) => (isDropped(s, a.unit) ? [] : [
    { ...launched, threadId: null, at: fx.now() },
    { type: 'thread-ended', unit: a.unit, at: fx.now(), status: 'start-failed' },
  ]));
  await updateRegistry(fx, (r) => recordFailure(r, a.key, { now: fx.now(), jobClass: a.job, kind: 'unknown' }));
  return { error: error.message };
}

// The real lease is the write-ahead record of a launch: it holds everything the `launched` event needs,
// so a crash before the ledger append is adopted on the next poll instead of launching twice.
async function recordStart(fx, a, launched, reservation, threadId) {
  const dir = leasesDir(fx.env);
  const { type, at, ...fields } = launched;
  await withMachine(fx, async () => {
    await writeLease(dir, {
      ...fields, threadId, project: fx.cwd, startedAt: fx.now(), heartbeatAt: fx.now(), blocked: false,
    });
    await removeLease(dir, reservation);
  });
  let dropped = false;
  await commit(fx.cwd, (s) => {
    dropped = isDropped(s, a.unit); // `orq unit drop` ran while the thread was starting
    return dropped ? [] : [{ ...launched, threadId, at: fx.now() }];
  });
  await updateRegistry(fx, (r) => markUsed(r, a.key, fx.now()));
  if (!dropped) return { threadId };
  await withMachine(fx, () => removeLease(dir, threadId));
  return { orphaned: threadId, note: `note: unit ${a.unit} was dropped while launching; thread ${threadId} left running — interrupt it` };
}

export async function launchUnit(fx, a, { plan, config, cap }) {
  const planState = await ensurePlanStarted(fx, { plan, config });
  const u = unitOf(await readState(fx.cwd), a.unit);
  if (u.state !== 'queued' || Math.max(1, u.attempt) !== a.attempt) return { skipped: 'already launched' };
  const spec = plan.units.find((x) => x.id === a.unit);
  const order = await fs.readFile(path.join(fx.cwd, spec.order), 'utf8');
  const reservation = await reserve(fx, a, cap, ttlMs(config));
  if (reservation === null) return { skipped: 'cap reached' };
  const branch = `orq/${planState.planId}/${a.unit}-a${a.attempt}${u.launches > 0 ? `-l${u.launches + 1}` : ''}`;
  const baseSha = (await readState(fx.cwd)).plan.integrationHead;
  const launched = {
    type: 'launched', unit: a.unit, attempt: a.attempt, launch: u.launches + 1, key: a.key, instance: a.instance, model: a.model,
    branch, baseSha, tier: a.tier, family: a.family ?? null,
  };
  const message = a.failures?.length ? `Previous attempt failed the gate:\n${failureText(a.failures)}\n\n${order}` : order;
  let threadId;
  // ponytail: a crash between startThread returning and recordStart's lease write leaves a running thread known
  // only as a reservation; the reservation is reaped after 2 minutes and the unit relaunches, so that work runs
  // twice. Upgrade: give the thread an idempotency title and look it up by title in `thread list` before relaunching.
  try {
    ({ threadId } = fx.t3.startThread({
      project: fx.cwd, message, provider: a.instance, model: a.model, worktree: baseSha, branch, title: `orq ${a.unit}: ${spec.title}`,
    }));
  } catch (e) {
    return startFailed(fx, a, launched, reservation, e);
  }
  return recordStart(fx, a, launched, reservation, threadId);
}
