// The scheduler's decision function. Pure and deterministic: no I/O, inputs never mutated, plan order breaks ties.
import { unitOf, authorsOf, FINAL } from './ledger.mjs';
import { readyUnits } from './plan.mjs';
import { ASKS_ORCHESTRATOR } from './worker-status.mjs';
import { route } from './route.mjs';
import {
  countActive, liveLeases, runningByInstance, DEFAULT_LEASE_TTL_MINUTES,
} from './leases.mjs';
import {
  MIN, unitIds, leaseOf, awaitsFeedback, emit, removeLease, providerFailure, alive,
} from './tick-util.mjs';
import {
  gates, feedback, integrations, finalGate,
} from './tick-gates.mjs';

const FLYING = ['running', 'blocked', 'gating'];
const ENDED = ['failed', 'cancelled', 'interrupted', 'missing'];
const DEFAULTS = {
  stallMinutes: 20, gateConcurrency: 1, perInstanceLimit: 2, leaseTtlMinutes: DEFAULT_LEASE_TTL_MINUTES,
};
const MAX_PROVIDER_FAILURES = 3;
const FEEDBACK_VISIBLE_MS = 2 * MIN;
const NO_AUTHORS = { maxTier: 2, family: 'unknown' }; // before anything is integrated

// The thread still shows its run from before the feedback: wait, report it, and give up after stallMinutes.
function feedbackNotStarted(t, id, unit) {
  const waited = t.now - unit.since;
  if (waited > t.config.stallMinutes * MIN) providerFailure(t, id, unit, 'feedback-lost');
  else if (waited > FEEDBACK_VISIBLE_MS) t.stalled.push({ unit: id, threadId: unit.threadId, minutes: Math.floor(waited / MIN) });
}

// Quiet for stallMinutes: reported (the orchestrator may interrupt it). Quiet for twice that: T3 kept it "running"
// after a limit or an outage, so orq gives it up as a provider failure and the unit continues elsewhere once a slot
// is free. The thread itself is left alone (orq cannot interrupt it) and its lease is kept, abandoned, so the cap
// still counts it until T3 shows it ended or the lease TTL runs out; anything it commits later stays on its old branch.
function stalled(t, id, unit, minutes) {
  if (minutes < 2 * t.config.stallMinutes) {
    t.stalled.push({ unit: id, threadId: unit.threadId, minutes });
    return;
  }
  providerFailure(t, id, unit, 'stalled');
  t.notes.push(`note: unit ${id} gave up on thread ${unit.threadId} (quiet for ${minutes} min); it still holds a slot until it ends: interrupt it (t3_thread_interrupt)`);
}

function observe(t, id) {
  const unit = unitOf(t.st, id);
  const th = t.threads[unit.threadId];
  const status = th ? th.status : 'missing';
  if (status === 'completed' && unit.since !== null && th.updatedAt <= unit.since) {
    feedbackNotStarted(t, id, unit);
  } else if (status === 'completed') {
    emit(t, 'thread-ended', id, { status });
    removeLease(t, id, unit.threadId);
    alive(t, id, unit);
    // th.report: the parsed status line of the worker's reply, supplied by the caller (null when unread)
    if (ASKS_ORCHESTRATOR.includes(th.report?.status)) {
      emit(t, 'needs-judgment', id, { reason: `worker reported ${th.report.status}: ${th.report.detail}` });
    }
  } else if (ENDED.includes(status)) {
    providerFailure(t, id, unit, status);
  } else if (th.pending > 0 && unit.state === 'running') {
    emit(t, 'blocked', id);
    const l = leaseOf(t, unit.threadId);
    if (l && !l.blocked) t.slots += 1;
    t.actions.push({ type: 'lease-block', unit: id, threadId: unit.threadId });
    t.newlyBlocked.push({ unit: id, threadId: unit.threadId });
  } else if (th.pending === 0 && unit.state === 'blocked') {
    emit(t, 'unblocked', id);
    if (leaseOf(t, unit.threadId)?.blocked) t.slots -= 1;
    t.actions.push({ type: 'lease-unblock', unit: id, threadId: unit.threadId });
  } else if (unit.state === 'running' && t.now - th.updatedAt > t.config.stallMinutes * MIN) {
    stalled(t, id, unit, Math.floor((t.now - th.updatedAt) / MIN));
  }
}

function candidate(t, id, running) {
  const unit = unitOf(t.st, id);
  const pu = t.plan.units.find((u) => u.id === id);
  const authors = authorsOf(t.plan.units.map((u) => u.id), t.st) ?? NO_AUTHORS;
  const r = route({
    registry: t.registry, rules: t.rules, job: pu.job, authorTier: authors.maxTier, authorFamily: authors.family, running, exclude: unit.tried, avoidKeys: unit.failedKeys, avoidInstances: unit.triedInstances, now: t.now,
    defaultLimit: t.config.perInstanceLimit, atLeast: unit.minTier ?? 1,
  });
  if (r.candidates.length === 0) {
    // every model it may use failed its quality ladder: nothing will change by waiting
    if (r.blocked === 'excluded') emit(t, 'needs-judgment', id, { reason: `no model available: ${r.reason}`, provider: true });
    else if (r.blocked === 'limit') t.slotWaiting.push(id); // every model it may use is at its instance limit: a slot frees when a thread ends
    else t.unroutable.push({ unit: id, blocked: r.blocked, reason: r.reason, retryAt: r.retryAt });
    return null;
  }
  const c = r.candidates[0];
  const attempt = Math.max(1, unit.attempt);
  return {
    type: 'launch', unit: id, attempt, key: c.key, instance: c.instance, model: c.model, tier: c.tier, family: c.family, job: pu.job,
    failures: attempt > 1 ? unit.lastFailure : null, ...(c.avoided ? { avoided: true } : {}), ...(c.belowTier ? { wantedTier: c.wantedTier } : {}),
  };
}

function launch(t) {
  for (const id of unitIds(t, ['queued'])) {
    // a dropped dependency never integrates (a hand-edited plan or an older ledger; `orq unit drop` refuses it)
    const gone = (t.plan.units.find((u) => u.id === id).deps ?? []).find((d) => unitOf(t.st, d).state === 'dropped');
    if (unitOf(t.st, id).providerFailures >= MAX_PROVIDER_FAILURES) emit(t, 'needs-judgment', id, { reason: '3 provider failures', provider: true });
    else if (gone) emit(t, 'needs-judgment', id, { reason: `depends on dropped unit ${gone}` });
  }
  const anyPassed = unitIds(t, ['passed', 'integrated']).length > 0;
  let inFlight = unitIds(t, FLYING).length + unitIds(t, ['queued']).filter((id) => awaitsFeedback(unitOf(t.st, id))).length;
  const running = { ...runningByInstance(t.leases) };
  for (const id of readyUnits(t.plan, unitIds(t, ['integrated']))) {
    const u = unitOf(t.st, id);
    if (u.state !== 'queued' || awaitsFeedback(u)) continue;
    if (!anyPassed && inFlight >= 1) break; // start one unit first
    const a = candidate(t, id, running); // route first: an unroutable unit is reported whether or not a slot is free
    if (!a) continue;
    if (t.slots <= 0) { t.slotWaiting.push(id); continue; }
    t.actions.push(a);
    running[a.instance] = (running[a.instance] ?? 0) + 1;
    t.slots -= 1;
    inFlight += 1;
    t.launched += 1;
  }
}

function complete(t) {
  const states = t.plan.units.map((u) => unitOf(t.st, u.id).state);
  if (!states.every((s) => s === 'integrated' || s === 'dropped')) return false;
  const p = t.st.plan;
  if (!states.includes('integrated') || p.final?.head === p.integrationHead) return true; // final gate is per head
  return finalGate(t);
}

function report(t, done) {
  const judgment = unitIds(t, ['failed']).map((id) => ({ unit: id, reason: unitOf(t.st, id).reason }));
  if (t.finalJudgment) judgment.push({ unit: FINAL, reason: t.finalJudgment });
  return {
    done, judgment, newlyBlocked: t.newlyBlocked, stalled: t.stalled, notes: t.notes, unroutable: t.unroutable,
    noSlots: t.slotWaiting.length > 0, slotWaiting: t.slotWaiting, // ready units that only lack a machine slot
    inFlight: unitIds(t, [...FLYING, 'passed']).length + t.launched + unitIds(t, ['queued']).filter((id) => awaitsFeedback(unitOf(t.st, id))).length,
    queued: unitIds(t, ['queued']).length - t.launched,
  };
}

export function tick(input) {
  const config = { ...DEFAULTS, ...input.config };
  const leases = liveLeases(input.leases, input.now, config.leaseTtlMinutes * MIN); // expired leases hold no slot
  const t = {
    ...input, config, leases, st: input.state, events: [], actions: [],
    slots: input.cap - countActive(leases), newlyBlocked: [], stalled: [], unroutable: [], notes: [],
    slotWaiting: [], launched: 0, gateFree: 0, finalJudgment: null,
  };
  for (const id of unitIds(t, ['running', 'blocked'])) observe(t, id);
  gates(t);
  feedback(t);
  integrations(t);
  launch(t);
  const done = complete(t);
  return { events: t.events, actions: t.actions, report: report(t, done) };
}
