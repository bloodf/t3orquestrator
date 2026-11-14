// Pick a model for a job class. Pure: reasons in tiers and families, never in model names.

import { routable } from './registry.mjs';

function resolveMinTier(rule, job, authorTier) {
  if (rule.minTier !== 'author') return rule.minTier;
  if (!Number.isInteger(authorTier) || authorTier < 1 || authorTier > 4) {
    throw new Error(`job "${job}" needs authorTier as an integer 1-4, got ${authorTier}`);
  }
  return authorTier;
}

const cooling = (until, now) => until !== null && until !== undefined && until > now;

// Why a usable model cannot be picked right now: 'excluded' | 'cooling' | 'limit' | null.
function blocker(m, inst, ctx) {
  if (ctx.exclude.has(m.key)) return 'excluded';
  if (cooling(inst.cooldownUntil, ctx.now) || cooling(m.cooldownUntil, ctx.now)) return 'cooling';
  if ((ctx.running[m.instance] ?? 0) >= (inst.limit ?? ctx.defaultLimit)) return 'limit';
  return null;
}

function retryTime(m, inst, now) {
  return Math.max(...[m.cooldownUntil, inst.cooldownUntil].filter((t) => cooling(t, now)));
}

// A model's record for a job class: its first-pass rate once it has 3 attempts (unknown = neutral), and demoted
// when 4+ attempts passed first time under 34%. Review and decide threads are never gated: their record says nothing.
const UNSCORED = ['review', 'decide'];
const NEUTRAL = 0.5;
export function recordOf(m, job) {
  const o = UNSCORED.includes(job) ? null : m.outcomes?.[job];
  const n = Number.isInteger(o?.attempts) ? o.attempts : 0;
  const rate = n > 0 ? (o.firstPass ?? 0) / n : null;
  return { score: n >= 3 ? Math.round(rate * 100) / 100 : null, n, demoted: n >= 4 && rate < 0.34 };
}

// strongest (job `decide`): highest tier first; otherwise the cheapest capable tier first. Then the better
// record for the job, then load, then least recently used: two models with the same record still alternate.
function ordering(running, strongest, job) {
  const score = (m) => recordOf(m, job).score ?? NEUTRAL;
  return (a, b) => (strongest ? b.tier - a.tier : a.tier - b.tier)
    || score(b) - score(a)
    || (running[a.instance] ?? 0) - (running[b.instance] ?? 0)
    || (a.lastUsedAt ?? -Infinity) - (b.lastUsedAt ?? -Infinity)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function toCandidate(m, job) {
  const r = recordOf(m, job);
  return {
    key: m.key, instance: m.instance, model: m.model, tier: m.tier, family: m.family, confirmed: m.confirmedAt !== null,
    ...(r.n > 0 ? { score: r.score, n: r.n } : {}), ...(r.demoted ? { demoted: true } : {}),
  };
}

function build(models, {
  running, differentFamily, authorFamily, belowTier, minTier, avoid, avoidKeys, strongest, job,
}) {
  // what failed this unit goes last, a failed model behind a failed instance: a preference, never an exclusion
  const rank = (m) => (avoidKeys.has(m.key) ? 2 : 0) + (avoid.has(m.instance) ? 1 : 0);
  const mark = (m) => {
    const c = toCandidate(m, job);
    if (differentFamily && (m.family === authorFamily || m.family === 'unknown')) c.sameFamily = true;
    if (belowTier) Object.assign(c, { belowTier: true, wantedTier: minTier });
    if (rank(m) > 0) c.avoided = true;
    return c;
  };
  const ordered = [...models].sort(ordering(running, strongest, job));
  const families = [...ordered.filter((m) => !mark(m).sameFamily), ...ordered.filter((m) => mark(m).sameFamily)];
  const ranked = [0, 1, 2, 3].flatMap((r) => families.filter((m) => rank(m) === r));
  // a model that keeps failing this job class comes after every other adequate one, at any tier; never excluded
  const demoted = (m) => recordOf(m, job).demoted;
  return [...ranked.filter((m) => !demoted(m)), ...ranked.filter(demoted)].map(mark);
}

function blockedReason(scope, ctx, registry) {
  const kinds = new Set(scope.map((m) => blocker(m, registry.instances[m.instance], ctx)));
  const names = { excluded: 'all excluded', cooling: 'all cooling down', limit: 'all at concurrency limit' };
  const blocked = kinds.size === 1 ? [...kinds][0] : 'mixed';
  const reason = kinds.size === 1
    ? names[blocked]
    : `none eligible: ${[...kinds].map((k) => names[k].replace('all ', '')).join(', ')}`;
  const times = scope
    .filter((m) => blocker(m, registry.instances[m.instance], ctx) === 'cooling')
    .map((m) => retryTime(m, registry.instances[m.instance], ctx.now));
  return { candidates: [], blocked, reason, retryAt: times.length ? Math.min(...times) : null };
}

export function route({
  registry, rules, job, authorTier, authorFamily, running = {}, exclude = [], now, defaultLimit = 2, atLeast = 1, avoidInstances = [], avoidKeys = [],
}) {
  const rule = rules?.jobs?.[job];
  if (!rule) throw new Error(`unknown job "${job}"; valid jobs: ${Object.keys(rules?.jobs ?? {}).join(', ')}`);
  const minTier = Math.max(resolveMinTier(rule, job, authorTier), atLeast); // atLeast: escalation floor
  if (rule.differentFamily === true && !authorFamily) {
    throw new Error(`job "${job}" needs authorFamily (use "unknown" if not known)`);
  }
  const ctx = { defaultLimit, running, exclude: new Set(exclude), now };
  const usable = Object.entries(registry.models)
    .map(([key, m]) => ({ ...m, key }))
    .filter((m) => m.available && routable(registry.instances[m.instance]));
  if (usable.length === 0) return { candidates: [], blocked: 'empty', reason: 'no usable model in registry; run sync', retryAt: null };

  const atTier = usable.filter((m) => m.tier >= minTier);
  const best = Math.max(...usable.map((m) => m.tier));
  const isFree = (m) => blocker(m, registry.instances[m.instance], ctx) === null;
  let scope = atTier.length === 0 ? usable.filter((m) => m.tier === best) : atTier;
  let free = scope.filter(isFree);
  // strongest (`decide`): a free weaker model beats waiting, since waiting means interrupting the user
  if (free.length === 0 && rule.strongest === true && usable.some(isFree)) {
    scope = usable;
    free = usable.filter(isFree);
  }
  if (free.length === 0) return blockedReason(scope, ctx, registry);
  const belowTier = free.every((m) => m.tier < minTier);
  const opts = {
    running, differentFamily: rule.differentFamily === true, authorFamily, belowTier, minTier, strongest: rule.strongest === true, avoid: new Set(avoidInstances), avoidKeys: new Set(avoidKeys), job,
  };
  return {
    candidates: build(free, opts),
    blocked: null,
    reason: belowTier ? `no model at tier ${minTier}; using best available` : 'ok',
    retryAt: null,
  };
}
