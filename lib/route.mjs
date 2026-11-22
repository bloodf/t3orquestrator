// Pick a model for a job class. Pure: reasons in tiers and families, never in model names.

import { routable } from './registry.mjs';
import { MAX_RESULTS } from './health.mjs';

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

// A model's record for a job class, from `results` (the first gate verdict of each launch, last 10; health.mjs):
// its pass rate once it has 3 results (fewer = neutral), and demoted when 4+ results pass under 34%. A record whose
// last result is over 24 h old lapses to neutral, so a demoted model gets another chance. Review and decide threads
// are never gated: they have no record. Counts from before this version (`outcomes`) are not read.
const UNSCORED = ['review', 'decide'];
const NEUTRAL = 0.5;
const LAPSE_MS = 24 * 3600_000;
export function recordOf(m, job, now = 0) {
  const list = UNSCORED.includes(job) || !Array.isArray(m.results?.[job]) ? [] : m.results[job].slice(-MAX_RESULTS);
  const n = list.length;
  if (n === 0) return { score: null, n: 0, demoted: false };
  const rate = list.filter((r) => r.pass === true).length / n;
  const demoted = n >= 4 && rate < 0.34;
  if (demoted && now - (list.at(-1).at ?? 0) > LAPSE_MS) return { score: null, n: 0, demoted: false }; // another chance
  return { score: n >= 3 ? Math.round(rate * 100) / 100 : null, n, demoted };
}

// A free model (policy.mjs) earns its tier instead of being trusted with it: it starts on tier 1 jobs, reaches tier 2
// after 3 passing gates (pass rate 60%+ over its last results, all job classes), and its own tier after 8 passes at
// 70%+. Never above the registry tier; a tier the user set is kept as is. Free hosted models vary too much to assume.
export function earnedTier(m) {
  if (!m.free || m.tierSource === 'user') return m.tier;
  const all = Object.values(m.results ?? {}).flatMap((l) => (Array.isArray(l) ? l.slice(-MAX_RESULTS) : []));
  const passes = all.filter((r) => r.pass === true).length;
  const rate = all.length ? passes / all.length : 0;
  const earned = passes >= 8 && rate >= 0.7 ? m.tier : passes >= 3 && rate >= 0.6 ? 2 : 1;
  return Math.min(m.tier, earned);
}

// strongest (job `decide`): highest tier first; otherwise the cheapest capable tier first. Then the account with more
// headroom (usage.mjs; in quarters, unknown counts as half), then the better record for the job, then load, then least
// recently used: two models with the same record still alternate.
// A preferred instance (policy.mjs preferInstances), then a free model, goes first, except where the strongest is wanted.
const band = (m) => Math.min(3, Math.floor((m.headroom ?? NEUTRAL) * 4));
function ordering(running, strongest, job, now) {
  const score = (m) => recordOf(m, job, now).score ?? NEUTRAL;
  return (a, b) => (strongest ? 0 : Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)))
    || (strongest ? 0 : Number(Boolean(b.free)) - Number(Boolean(a.free)))
    || (strongest ? b.tier - a.tier : a.tier - b.tier)
    || band(b) - band(a)
    || score(b) - score(a)
    || (running[a.instance] ?? 0) - (running[b.instance] ?? 0)
    || (a.lastUsedAt ?? -Infinity) - (b.lastUsedAt ?? -Infinity)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function toCandidate(m, job, now) {
  const r = recordOf(m, job, now);
  return {
    key: m.key, instance: m.instance, model: m.model, tier: m.tier, family: m.family, confirmed: m.confirmedAt !== null,
    ...(r.n > 0 ? { score: r.score, n: r.n } : {}), ...(r.demoted ? { demoted: true } : {}), ...(m.headroom != null ? { headroom: m.headroom } : {}), ...(m.free ? { free: true } : {}), ...(m.preferred ? { preferred: true } : {}),
  };
}

function build(models, {
  running, differentFamily, authorFamily, belowTier, minTier, avoid, avoidKeys, avoidFamilies, strongest, job, now, overLimit,
}) {
  // what failed this unit goes last: a failed model behind a failed instance behind a failed family (the same account
  // or vendor often fails the same way). A preference, never an exclusion; `unknown` is no family. A preferred instance
  // (policy.mjs) is not left for another family: the machine wants it first, and a failed account's sibling is another account
  const rank = (m) => (avoidKeys.has(m.key) ? 4 : 0) + (avoid.has(m.instance) ? 2 : 0) + (!m.preferred && m.family !== 'unknown' && avoidFamilies.has(m.family) ? 1 : 0);
  const mark = (m) => {
    const c = toCandidate(m, job, now);
    if (differentFamily && (m.family === authorFamily || m.family === 'unknown')) c.sameFamily = true;
    if (belowTier) Object.assign(c, { belowTier: true, wantedTier: minTier });
    if (overLimit) c.overLimit = true;
    if (rank(m) > 0) c.avoided = true;
    return c;
  };
  const ordered = [...models].sort(ordering(running, strongest, job, now));
  const families = [...ordered.filter((m) => !mark(m).sameFamily), ...ordered.filter((m) => mark(m).sameFamily)];
  const ranked = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((r) => families.filter((m) => rank(m) === r));
  // a model that keeps failing this job class comes after every other adequate one, at any tier; never excluded
  const demoted = (m) => recordOf(m, job, now).demoted;
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

// why the machine policy (policy.mjs) leaves a job no model: the job waits, like one with no model at all
function policyReason(listed) {
  const left = listed.filter((m) => !m.excluded);
  if (left.length === 0) return 'every usable model is excluded (machine config excludeModels)';
  if (left.some((m) => !m.familyBlocked)) return 'only decision-only models are usable (kept for decisions: machine config decisionOnly)';
  return 'no model of a family its instance allows (machine config instanceFamilies)';
}

// Degrade instead of stopping, when no model the job wants (scope) can run now. -> {free, reason, overLimit?} | null.
// A lower tier: every wanted model is out for a while (a quota, a long cooldown; none merely busy), so the best free
// tier below does the work. A rule with `fallback: false` waits instead.
// Over the limit: a rule with `always: true` (plan, decide) never gets "none" while a model has quota: with every such
// model at its instance's concurrency limit, one runs over that limit (the machine cap still applies).
// Never below the wanted tier (unless the job wants the strongest, where waiting means asking the user) when the tier
// is back within minutes, or when the unit's own quality ladder set it: an escalation floor, or models it excluded.
const FALLBACK_AFTER_MS = 10 * 60_000;
function degrade({
  usable, scope, minTier, rule, escalated, ctx, registry,
}) {
  const why = (m) => blocker(m, registry.instances[m.instance], ctx);
  const kinds = scope.map(why);
  const cooling = scope.filter((m) => why(m) === 'cooling');
  const until = Math.min(...cooling.map((m) => retryTime(m, registry.instances[m.instance], ctx.now)));
  const floor = Math.min(minTier, ...scope.map((m) => m.tier));
  const best = (list) => list.filter((m) => m.tier === Math.max(...list.map((x) => x.tier)));
  const keep = rule.strongest !== true && (escalated || kinds.includes('excluded') || (cooling.length > 0 && until - ctx.now <= FALLBACK_AFTER_MS));
  const lower = usable.filter((m) => m.tier < floor && why(m) === null);
  if (rule.fallback !== false && !keep && !kinds.includes('limit') && cooling.length > 0 && lower.length > 0) {
    return { free: best(lower), reason: `every model at tier ${floor} or above is cooling down until ${new Date(until).toISOString()}; using tier ${best(lower)[0].tier}` };
  }
  if (rule.always !== true) return null;
  const wanted = scope.filter((m) => why(m) === 'limit');
  if (wanted.length > 0) return { free: wanted, overLimit: true, reason: 'every model with quota at the wanted tier is at its concurrency limit; using one over the limit' };
  const busy = usable.filter((m) => why(m) === 'limit');
  if (keep || busy.length === 0 || rule.fallback === false) return null;
  return { free: best(busy), overLimit: true, reason: `no model at tier ${floor} or above can run now; using a tier ${best(busy)[0].tier} model over its concurrency limit` };
}

export function route({
  registry, rules, job, authorTier, authorFamily, running = {}, exclude = [], now, defaultLimit = 2, atLeast = 1, avoidInstances = [], avoidKeys = [], avoidFamilies = [],
}) {
  const rule = rules?.jobs?.[job];
  if (!rule) throw new Error(`unknown job "${job}"; valid jobs: ${Object.keys(rules?.jobs ?? {}).join(', ')}`);
  const minTier = Math.max(resolveMinTier(rule, job, authorTier), atLeast); // atLeast: escalation floor
  if (rule.differentFamily === true && !authorFamily) {
    throw new Error(`job "${job}" needs authorFamily (use "unknown" if not known)`);
  }
  const ctx = { defaultLimit, running, exclude: new Set(exclude), now };
  const listed = Object.entries(registry.models)
    .map(([key, m]) => ({ ...m, key, tier: earnedTier(m) }))
    .filter((m) => m.available && routable(registry.instances[m.instance]));
  if (listed.length === 0) return { candidates: [], blocked: 'empty', reason: 'no usable model in registry; run sync', retryAt: null };
  const usable = listed.filter((m) => !m.excluded && !m.familyBlocked && (job === 'decide' || !m.decisionOnly));
  if (usable.length === 0) return { candidates: [], blocked: 'policy', reason: policyReason(listed), retryAt: null };

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
  const floor = resolveMinTier(rule, job, authorTier);
  const degraded = free.length === 0 ? degrade({
    usable, scope, minTier, rule, escalated: atLeast > floor, ctx, registry,
  }) : null;
  if (degraded) ({ free } = degraded);
  if (free.length === 0) return blockedReason(scope, ctx, registry);
  const { reason = null, overLimit = false } = degraded ?? {};
  const belowTier = free.every((m) => m.tier < minTier);
  const opts = {
    running, differentFamily: rule.differentFamily === true, authorFamily, belowTier, minTier, strongest: rule.strongest === true, avoid: new Set(avoidInstances), avoidKeys: new Set(avoidKeys), avoidFamilies: new Set(avoidFamilies), job, now, overLimit,
  };
  return {
    candidates: build(free, opts),
    blocked: null,
    reason: reason ?? (belowTier ? `no model at tier ${minTier}; using best available` : 'ok'),
    retryAt: null,
  };
}
