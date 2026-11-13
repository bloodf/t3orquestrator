// Helpers shared by the tick passes. `t` is tick's private accumulator; inputs are never mutated.
import { apply, unitOf } from './ledger.mjs';
import { recordFailure, markAlive } from './health.mjs';

export const MIN = 60_000;

export const unitIds = (t, states) => t.plan.units.map((u) => u.id).filter((id) => states.includes(unitOf(t.st, id).state));
export const jobOf = (t, id) => t.plan.units.find((u) => u.id === id).job;
export const leaseOf = (t, threadId) => t.leases.find((l) => l.threadId === threadId);

// A unit whose first gate failed and whose thread has not yet been sent the failures.
export const awaitsFeedback = (u) => u.state === 'queued' && u.attempt === 2 && u.threadId !== null;

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

export function providerFailure(t, id, unit, status) {
  emit(t, 'thread-ended', id, { status });
  if (unit.threadId) removeLease(t, id, unit.threadId);
  const job = jobOf(t, id);
  if (known(t, unit.key)) t.registry = recordFailure(t.registry, unit.key, { now: t.now, jobClass: job, kind: 'unknown' });
  t.actions.push({ type: 'record-failure', unit: id, key: unit.key, job, kind: 'unknown' });
}

export function alive(t, id, unit) {
  if (known(t, unit.key)) t.registry = markAlive(t.registry, unit.key, t.now);
  t.actions.push({ type: 'mark-alive', unit: id, key: unit.key });
}
