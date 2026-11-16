// Helpers shared by the tick passes. `t` is tick's private accumulator; inputs are never mutated.
import { apply, unitOf } from './ledger.mjs';
import { recordFailure, markAlive } from './health.mjs';

export const MIN = 60_000;

export const unitIds = (t, states) => t.plan.units.map((u) => u.id).filter((id) => states.includes(unitOf(t.st, id).state));
export const jobOf = (t, id) => t.plan.units.find((u) => u.id === id).job;
// A fix unit repairs what blocks the final checks, so it takes free launch, feedback and gate slots first; plan order otherwise.
export const fixFirst = (t, ids) => {
  const fix = new Set(t.plan.units.filter((u) => u.job === 'fix').map((u) => u.id));
  return [...ids.filter((id) => fix.has(id)), ...ids.filter((id) => !fix.has(id))];
};
export const leaseOf = (t, threadId) => t.leases.find((l) => l.threadId === threadId);

export const CONFLICT = 'merge conflict with the integration branch in '; // the start of a `conflicted` event's failure
// The unit's last word is a conflict (not a later gate failure): its commit passed and only the merge is left.
export const conflictPending = (u) => u.conflicts > 0 && String(u.lastFailure?.[0] ?? '').startsWith(CONFLICT);
// A unit whose thread has a message due: its first gate failed (the failures), or its turn ended with no commit (a nudge).
export const awaitsFeedback = (u) => u.state === 'queued' && u.threadId !== null && (u.attempt === 2 || u.nudge === true);

export function emit(t, type, unit, extra = {}) {
  const e = { type, unit, at: t.now, ...extra };
  t.st = apply(t.st, e);
  t.events.push(e);
}

export function removeLease(t, id, threadId) {
  const l = leaseOf(t, threadId);
  if (l && !l.blocked) t.slots += 1;
  t.actions.push({ type: 'lease-remove', unit: id, threadId });
}

// Registry changes are applied to tick's own copy at once, so later routing in this poll sees them; the
// matching action persists the same change once (the next poll reads it from disk, never applied twice).
const known = (t, key) => key !== null && t.registry.models[key] !== undefined;

// A thread orq gives up on may still run in T3: its lease stays (abandoned), still counting against the cap.
export function abandonLease(t, id, threadId) {
  t.actions.push({ type: 'lease-abandon', unit: id, threadId });
}

export function providerFailure(t, id, unit, status) {
  emit(t, 'thread-ended', id, { status });
  if (unit.threadId && status === 'stalled') abandonLease(t, id, unit.threadId);
  else if (unit.threadId) removeLease(t, id, unit.threadId);
  const job = jobOf(t, id);
  if (known(t, unit.key)) t.registry = recordFailure(t.registry, unit.key, { now: t.now, jobClass: job, kind: 'unknown' });
  t.actions.push({ type: 'record-failure', unit: id, key: unit.key, job, kind: 'unknown' });
}

export function alive(t, id, unit) {
  if (known(t, unit.key)) t.registry = markAlive(t.registry, unit.key, t.now);
  t.actions.push({ type: 'mark-alive', unit: id, key: unit.key });
}
