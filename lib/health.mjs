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

// A success lifts failure cooldowns, never a limit's (recordLimit's limitUntil): the work began before the limit.
const held = (o, now) => (o?.limitUntil > now ? o.limitUntil : null);
export function recordSuccess(registry, key, { now, jobClass, firstPass }) {
  return edit(registry, key, (m, inst) => {
    Object.assign(m, { confirmedAt: now, lastUsedAt: now, failures: 0, cooldownUntil: held(m, now), available: true, rejectedAt: null });
    if (inst) Object.assign(inst, { failures: 0, cooldownUntil: held(inst, now) });
    countOutcome(m, jobClass, firstPass);
  });
}

// The scored record (route.mjs): the first gate verdict of each worker launch, per job class, last 10 only.
export const MAX_RESULTS = 10;
export function recordResult(registry, key, { now, jobClass, pass }) {
  return edit(registry, key, (m) => {
    const list = [...(m.results?.[jobClass] ?? []), { at: now, pass: pass === true }].slice(-MAX_RESULTS);
    m.results = { ...m.results, [jobClass]: list };
  });
}

const FAILURE_KINDS = ['model-rejected', 'provider', 'unknown'];

export function recordFailure(registry, key, { now, kind = 'unknown' }) {
  if (!FAILURE_KINDS.includes(kind)) throw new Error(`unknown failure kind: ${kind}; valid: ${FAILURE_KINDS.join(', ')}`);
  return edit(registry, key, (m, inst) => {
    m.failures += 1; // a provider failure says nothing about the work: no outcome, only the backoff below
    if (kind === 'model-rejected') {
      m.available = false;
      m.rejectedAt = now;
      return;
    }
    m.cooldownUntil = now + backoff(m.failures);
    if (!inst) return;
    // ponytail: a failure whose reply names no reason (limits.mjs) could still be a quota or an outage, so two in a row on one instance are treated as the instance being down. A wrong model name costs a 10-minute instance cooldown.
    inst.failures += 1;
    if (inst.failures >= 2) inst.cooldownUntil = now + backoff(inst.failures - 1);
  });
}

// A limit, sign-out or capacity failure (limits.mjs): no failure strike, the provider said why. It cools what the
// provider stopped until it said it is back: `limit` the instance's models of the same family (one account pool, as
// antigravity keeps one per family; an unknown family means all of them), `auth` the instance, `capacity` the model.
const LIMIT_KINDS = ['limit', 'auth', 'capacity'];
const later = (a, b) => Math.max(a ?? 0, b);
const hold = (o, until, at) => Object.assign(o, { cooldownUntil: later(o.cooldownUntil, until), limitUntil: later(o.limitUntil, until), ...(at ? { limitAt: at } : {}) });
// now: when the provider refused. Kept as limitAt, so a later usage reading that shows room can end the hold (usage.mjs).
export function recordLimit(registry, key, { kind, until }, now) {
  if (!LIMIT_KINDS.includes(kind)) throw new Error(`unknown limit kind: ${kind}; valid: ${LIMIT_KINDS.join(', ')}`);
  const m = registry.models[key];
  if (!m) throw new Error(`unknown model key: ${key}`);
  const next = structuredClone(registry);
  const inst = next.instances[m.instance];
  if (kind === 'auth' && inst) {
    hold(inst, until, now);
    return next;
  }
  const pool = (o) => o.instance === m.instance && (m.family === 'unknown' || !m.family || o.family === m.family);
  const hit = kind === 'limit' ? Object.values(next.models).filter(pool) : [next.models[key]]; // auth with no instance: the model
  for (const o of hit) hold(o, until, now);
  const all = Object.values(next.models).filter((o) => o.instance === m.instance);
  if (inst && kind === 'limit' && all.every((o) => hit.includes(o))) hold(inst, until, now);
  return next;
}

export function markUsed(registry, key, now) {
  return edit(registry, key, (m) => { m.lastUsedAt = now; });
}

// A thread that completed proves its instance is up, whatever the gate later says about the work.
export function markAlive(registry, key, now) {
  return edit(registry, key, (m, inst) => {
    if (inst) Object.assign(inst, { failures: 0, cooldownUntil: held(inst, now) });
  });
}
