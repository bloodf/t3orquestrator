// Account usage as T3 reports it per provider instance (`usageLimits` in its provider status cache), laid over the
// registry for routing. Pure. Reading the caches is in usage-source.mjs.

export const DEFAULT_THRESHOLD = 90; // used percent at which a model waits for its window's reset
export const MAX_AGE_MS = 3600_000; // an older reading says nothing: T3 keeps the last bars after a failed probe
const RECHECK_MS = 5 * 60_000; // no reset time known: look again after this
const SETTLE_MS = 10 * 60_000; // a reading this long after a provider's refusal outranks the reset time it named
const MAX_SETTLE_MS = 4 * 60 * 60_000;
// each refusal in a row (health.mjs limitStrikes) doubles the wait: T3's bars showed room and the provider refused again
const settleOf = (m) => Math.min(SETTLE_MS * 2 ** Math.max(0, (m.limitStrikes ?? 1) - 1), MAX_SETTLE_MS);

// An ISO time; one with no zone is UTC (Date.parse would read it as local time).
function time(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(/T[\d:.]+$/.test(v) ? `${v}Z` : v);
  return Number.isFinite(t) ? t : null;
}
// A reading dated more than MAX_AGE_MS from now, either way (a clock change), or undated, says nothing.
const fresh = (t, now) => t !== null && Math.abs(now - t) <= MAX_AGE_MS;

// An antigravity account has several quota groups, each with its own windows. T3 names the group in the window's
// label ("Gemini · Weekly", "Claude & GPT (shared) · Weekly", "Gemini 4 Argon · Weekly"). A `gemini-<x>-…` window whose
// <x> is not a period (gemini-argon-wtu-weekly) is one model's own quota: its members are the models T3 lists with <x>
// in the slug or the display name (gemini-pro-orchestrator-g1-pro is "Orchestrator (Argon)" and draws on argon's).
const PERIODS = /^(\d+[hd]|daily|weekly|monthly)$/;
const POOLS = ['gemini', 'claude', 'gpt', '3p'];
function ownModel(windowId) {
  const [pool, sub, ...rest] = windowId.split('-');
  return POOLS.includes(pool) && sub && rest.length > 0 && !PERIODS.test(sub) ? sub : null;
}
export function groupOf(w, models) {
  const group = typeof w.label === 'string' && w.label.includes(' · ') ? w.label.split(' · ')[0] : null;
  const sub = ownModel(w.id);
  const members = sub && Array.isArray(models)
    ? models.filter((m) => typeof m?.slug === 'string' && `${m.slug} ${m.name ?? ''}`.toLowerCase().includes(sub)).map((m) => m.slug) : [];
  return { ...(group ? { group } : {}), ...(members.length ? { members } : {}) };
}

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
    .map((w) => ({ id: w.id, used: w.usedPercent, resetAt: time(w.resetsAt), ...(snapshot.driver === 'antigravity' ? groupOf(w, snapshot.models) : {}) }))
    .filter((w) => w.resetAt === null || w.resetAt > now);
  const recent = fresh(time(snapshot.checkedAt), now);
  const down = recent && (snapshot.status === 'error' || snapshot.auth?.status === 'unauthenticated');
  const signedOut = recent && snapshot.auth?.status === 'unauthenticated'; // not a failed probe (`error`): the account itself
  return {
    checkedAt, down, stale, windows, ...(signedOut ? { signedOut } : {}),
  };
}

// Which windows bind a model. Antigravity keeps one pool per model family, `3p` shared by claude and gpt, as T3
// decides (exhaustedUsageWindow). A model's own window (ownModel) binds only its members, or the models whose slug has
// its name when T3 listed none; T3 binds it to every gemini model. Every other driver's windows bind all its models.
const familyOf = (driver, model) => (driver === 'antigravity' ? /^(gemini|claude|gpt)-/.exec(model)?.[1] : undefined);
// A window with a scope (a real quota reading, quota.mjs) binds only that: 'feature' (Codex code review) no model,
// 'model:<slug>' the models whose id holds that slug (claude's opus / sonnet / fable weeks).
const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
function binds(driver, model, w) {
  if (w.scope === 'feature') return false;
  if (typeof w.scope === 'string' && w.scope.startsWith('model:')) return flat(model).includes(w.scope.slice(6));
  const family = familyOf(driver, model);
  const [pool] = w.id.split('-');
  if (!POOLS.includes(pool) || family === undefined) return true;
  const sub = ownModel(w.id);
  if (sub) return pool === family && (w.members ? w.members.includes(model) : model.includes(sub));
  return pool === family || (pool === '3p' && family !== 'gemini');
}

// A model at or over the threshold in any window cools until the latest of those windows resets (until all of them
// have room again), and carries its headroom: what is left of its fullest window, 0-1, null when nothing is known.
const bound = (m, driver, u) => u.windows.filter((w) => binds(driver, m.model, w));
const fullOf = (ws, { now, threshold }) => ws.filter((w) => w.used >= threshold).map((w) => w.resetAt ?? now + RECHECK_MS);

// A limit hold (health.mjs recordLimit) covers the model's whole family on the instance until the reset the provider
// named. Where usage is per quota group (antigravity), a reading taken SETTLE_MS after the refusal that shows room in
// every window of the model's own group ends the hold: the quota came back early, or the refusal was another group's.
// ponytail: a refusal T3 shows no window for (a quota it does not list, a capacity error that names a long wait) is
// retried after SETTLE_MS, then twice as long after each refusal in a row (settleOf), up to MAX_SETTLE_MS.
// A real quota reading (EasyCLI, quota.mjs) lifts the hold the same way on any driver: its windows are the account's own.
function lifts(m, driver, u, opts) {
  const ws = bound(m, driver, u);
  return m.limitUntil > opts.now && (familyOf(driver, m.model) !== undefined || u.source === 'easycli') && ws.length > 0 && fullOf(ws, opts).length === 0
    && Math.min(u.checkedAt, opts.now) >= (m.limitAt ?? 0) + settleOf(m);
}
// the cooldown that is the hold itself; a longer or shorter one is a failure backoff, which stays
const withoutHold = (o) => (o.cooldownUntil === o.limitUntil ? 0 : o.cooldownUntil ?? 0);

function modelView(m, driver, u, opts) {
  const ws = bound(m, driver, u);
  const lifted = lifts(m, driver, u, opts);
  const until = Math.max(0, ...fullOf(ws, opts), lifted ? withoutHold(m) : m.cooldownUntil ?? 0);
  const headroom = ws.length ? (100 - Math.max(...ws.map((w) => w.used))) / 100 : null;
  return { ...m, headroom, ...(until > opts.now ? { cooldownUntil: until } : lifted ? { cooldownUntil: null } : {}) };
}

// A model its provider cannot run now, by the usage T3 reported (laid on by withUsage): its instance signed out (not
// merely a failed probe), or a window that binds it used up (100%, not the routing threshold). null when it may run or nothing is known.
// A running thread on such a model that has gone quiet hit the limit mid-run (tick gives it up and moves the unit).
export function exhausted(registry, key, now) {
  const m = registry.models[key];
  const inst = m && registry.instances[m.instance];
  const u = inst?.usage;
  if (!u?.windows) return null;
  if (u.signedOut) return { kind: 'auth', reason: `instance ${m.instance} is signed out`, until: now + RECHECK_MS, source: 'usage' };
  const full = u.windows.filter((w) => w.used >= 100 && binds(inst.driverKind, m.model, w));
  if (full.length === 0) return null;
  const last = full.reduce((a, b) => ((b.resetAt ?? 0) > (a.resetAt ?? 0) ? b : a));
  return { kind: 'limit', reason: `usage window ${last.id} at 100%`, until: last.resetAt ?? now + RECHECK_MS, source: 'usage' };
}

// The registry as routing sees it. A down instance cools until the next look. An instance held because a limit
// covered every model of it (recordLimit) is free once each of those holds has ended. Never written back.
export function withUsage(registry, usage, { now, threshold = DEFAULT_THRESHOLD }) {
  const known = Object.keys(usage ?? {}).filter((id) => registry.instances[id] && usage[id]?.windows);
  if (known.length === 0) return registry;
  const opts = { now, threshold };
  const instances = { ...registry.instances };
  for (const id of known) {
    const inst = instances[id];
    const mine = Object.values(registry.models).filter((m) => m.instance === id);
    const freed = inst.limitUntil > now && mine.length > 0 && mine.every((m) => lifts(m, inst.driverKind, usage[id], opts));
    const own = freed ? withoutHold(inst) : inst.cooldownUntil ?? 0;
    const until = usage[id].down ? Math.max(now + RECHECK_MS, own) : own;
    instances[id] = { ...inst, usage: usage[id], ...(until > now ? { cooldownUntil: until } : freed ? { cooldownUntil: null } : {}) };
  }
  const models = Object.fromEntries(Object.entries(registry.models).map(([k, m]) => (known.includes(m.instance)
    ? [k, modelView(m, instances[m.instance].driverKind, usage[m.instance], opts)] : [k, m])));
  return { ...registry, instances, models };
}
