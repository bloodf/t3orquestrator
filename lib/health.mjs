// Health tracking: successes, failures with backoff, and per-job outcome counts.
import { edit } from './registry.mjs';

const MIN = 60_000;

export function backoff(n) {
  return Math.min(10 * MIN * 2 ** (n - 1), 5 * 60 * MIN);
}

function countOutcome(m, jobClass, firstPass) {
  if (!jobClass) return;
  const o = (m.outcomes[jobClass] ??= { attempts: 0, firstPass: 0 });
  o.attempts += 1;
  if (firstPass) o.firstPass += 1;
}

export function recordSuccess(registry, key, { now, jobClass, firstPass }) {
  return edit(registry, key, (m, inst) => {
    Object.assign(m, { confirmedAt: now, lastUsedAt: now, failures: 0, cooldownUntil: null, available: true, rejectedAt: null });
    if (inst) Object.assign(inst, { failures: 0, cooldownUntil: null });
    countOutcome(m, jobClass, firstPass);
  });
}

const FAILURE_KINDS = ['model-rejected', 'provider', 'unknown'];

export function recordFailure(registry, key, { now, jobClass, kind = 'unknown' }) {
  if (!FAILURE_KINDS.includes(kind)) throw new Error(`unknown failure kind: ${kind}; valid: ${FAILURE_KINDS.join(', ')}`);
  return edit(registry, key, (m, inst) => {
    m.failures += 1;
    countOutcome(m, jobClass, false);
    if (kind === 'model-rejected') {
      m.available = false;
      m.rejectedAt = now;
      return;
    }
    m.cooldownUntil = now + backoff(m.failures);
    // an unconfirmed pair that fails points at the model, not the provider
    if (!inst || (kind === 'unknown' && m.confirmedAt === null)) return;
    inst.failures += 1;
    if (inst.failures >= 3) inst.cooldownUntil = now + backoff(inst.failures - 2);
  });
}

export function markUsed(registry, key, now) {
  return edit(registry, key, (m) => { m.lastUsedAt = now; });
}
