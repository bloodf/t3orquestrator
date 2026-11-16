// Account usage as T3 reports it per provider instance (`usageLimits` in its provider status cache), laid over the
// registry for routing. Pure. Reading the caches is in usage-source.mjs.

export const DEFAULT_THRESHOLD = 90; // used percent at which a model waits for its window's reset
export const MAX_AGE_MS = 3600_000; // an older reading says nothing: T3 keeps the last bars after a failed probe
const RECHECK_MS = 5 * 60_000; // no reset time known: look again after this

// An ISO time; one with no zone is UTC (Date.parse would read it as local time).
function time(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(/T[\d:.]+$/.test(v) ? `${v}Z` : v);
  return Number.isFinite(t) ? t : null;
}
// A reading dated more than MAX_AGE_MS from now, either way (a clock change), or undated, says nothing.
const fresh = (t, now) => t !== null && Math.abs(now - t) <= MAX_AGE_MS;

// One instance's snapshot: its usage windows that have not reset, and whether it can run at all. A snapshot with no
// usageLimits reports no usage (kimi); one whose usageLimits do not parse is unreadable.
export function instanceUsage(snapshot, now) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const u = snapshot.usageLimits;
  if (u !== undefined && !(u && typeof u === 'object' && Array.isArray(u.windows))) return { unreadable: true };
  const checkedAt = time(u?.checkedAt);
  const stale = u !== undefined && !fresh(checkedAt, now);
  const windows = stale || !u ? [] : u.windows
    .filter((w) => typeof w?.id === 'string' && Number.isFinite(w.usedPercent))
    .map((w) => ({ id: w.id, used: w.usedPercent, resetAt: time(w.resetsAt) }))
    .filter((w) => w.resetAt === null || w.resetAt > now);
  const down = fresh(time(snapshot.checkedAt), now) && (snapshot.status === 'error' || snapshot.auth?.status === 'unauthenticated');
  return {
    checkedAt, down, stale, windows,
  };
}

// Which windows bind a model. Antigravity keeps one pool per model family, `3p` shared by claude and gpt, as T3
// decides (exhaustedUsageWindow). A `gemini-<x>-…` window (gemini-argon-wtu-weekly) binds only models whose slug has
// <x>, which T3 does not distinguish. Every other driver's windows bind all its models.
const PERIODS = /^(\d+[hd]|daily|weekly|monthly)$/;
function binds(driver, model, windowId) {
  if (driver !== 'antigravity') return true;
  const family = /^(gemini|claude|gpt)-/.exec(model)?.[1];
  const [pool, sub] = windowId.split('-');
  if (!['gemini', 'claude', 'gpt', '3p'].includes(pool) || family === undefined) return true;
  if (sub && !PERIODS.test(sub) && windowId.split('-').length > 2) return pool === family && model.includes(sub);
  return pool === family || (pool === '3p' && family !== 'gemini');
}

// A model at or over the threshold in any window cools until the latest of those windows resets (until all of them
// have room again), and carries its headroom: what is left of its fullest window, 0-1, null when nothing is known.
function modelView(m, driver, u, { now, threshold }) {
  const ws = u.windows.filter((w) => binds(driver, m.model, w.id));
  const full = ws.filter((w) => w.used >= threshold).map((w) => w.resetAt ?? now + RECHECK_MS);
  const until = Math.max(0, ...full, m.cooldownUntil ?? 0);
  const headroom = ws.length ? (100 - Math.max(...ws.map((w) => w.used))) / 100 : null;
  return { ...m, headroom, ...(until > now ? { cooldownUntil: until } : {}) };
}

// The registry as routing sees it. A down instance cools until the next look. Never written back.
export function withUsage(registry, usage, { now, threshold = DEFAULT_THRESHOLD }) {
  const known = Object.keys(usage ?? {}).filter((id) => registry.instances[id] && usage[id]?.windows);
  if (known.length === 0) return registry;
  const instances = { ...registry.instances };
  for (const id of known) {
    const until = usage[id].down ? Math.max(now + RECHECK_MS, instances[id].cooldownUntil ?? 0) : null;
    instances[id] = { ...instances[id], usage: usage[id], ...(until ? { cooldownUntil: until } : {}) };
  }
  const models = Object.fromEntries(Object.entries(registry.models).map(([k, m]) => (known.includes(m.instance)
    ? [k, modelView(m, instances[m.instance].driverKind, usage[m.instance], { now, threshold })] : [k, m])));
  return { ...registry, instances, models };
}
