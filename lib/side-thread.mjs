// Side threads: one leased T3 thread outside the plan, for a review (`orq review`) or a decision (`orq ask`).
// The lease counts against the machine cap from reservation until the outcome is recorded.
import { createT3 } from './t3.mjs';
import { markUsed, recordFailure, recordSuccess } from './health.mjs';
import { listLeases, removeLease, writeLease } from './leases.mjs';
import { reserve, updateRegistry, withMachine } from './launch.mjs';
import { leasesDir } from './paths.mjs';

/**
 * Reserve a slot, start the thread (t3 runs outside every lock), then turn the reservation into its lease.
 * kind/n name the lease (`<kind>-<n>`); jobClass is the routing job the model's health is counted under. Returns {threadId}, {noSlot: true} or {error} (the model's failure is recorded).
 */
export async function startSideThread(ctx, {
  bin, c, cap, ttl, kind, n, jobClass, message, worktree, branch, title,
}) {
  const fx = { cwd: ctx.cwd, env: ctx.env, now: ctx.now };
  const dir = leasesDir(ctx.env);
  const unit = `${kind}-${n}`;
  const mark = { kind, [kind]: n };
  const reservation = await reserve(fx, {
    unit, attempt: 1, instance: c.instance, model: c.model, mark,
  }, cap, ttl);
  if (reservation === null) return { noSlot: true };
  let threadId;
  try {
    ({ threadId } = createT3({ bin, exec: ctx.deps.exec }).startThread({
      project: ctx.cwd, message, provider: c.instance, model: c.model, worktree, branch, title,
    }));
  } catch (e) {
    await withMachine(fx, () => removeLease(dir, reservation));
    await updateRegistry(fx, (r) => recordFailure(r, c.key, { now: ctx.now(), jobClass, kind: 'unknown' }));
    return { error: e.message };
  }
  await withMachine(fx, async () => {
    await writeLease(dir, {
      threadId, project: ctx.cwd, unit, instance: c.instance, model: c.model, startedAt: ctx.now(), heartbeatAt: ctx.now(), blocked: false, ...mark,
    });
    await removeLease(dir, reservation);
  });
  await updateRegistry(fx, (r) => markUsed(r, c.key, ctx.now()));
  return { threadId };
}

// Still running: keep its lease fresh so `orq wait` and the TTL do not reap it.
export async function refreshSideLease(fx, threadId) {
  await withMachine(fx, async () => {
    const lease = (await listLeases(leasesDir(fx.env))).find((l) => l.threadId === threadId);
    if (lease) await writeLease(leasesDir(fx.env), { ...lease, heartbeatAt: fx.now() });
  });
}

// Ended: record the model's health once and free the slot. ok: the thread completed (whatever it said).
export async function settleSideThread(fx, {
  key, threadId, jobClass, ok,
}) {
  await updateRegistry(fx, (reg) => (ok
    ? recordSuccess(reg, key, { now: fx.now(), jobClass, firstPass: false })
    : recordFailure(reg, key, { now: fx.now(), jobClass, kind: 'unknown' })));
  await withMachine(fx, () => removeLease(leasesDir(fx.env), threadId));
}
