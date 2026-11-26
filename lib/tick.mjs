// The scheduler's decision function. Pure and deterministic: no I/O, inputs never mutated; fix units first, then plan order, break ties.
import { unitOf, authorsOf, FINAL } from './ledger.mjs';
import { readyUnits } from './plan.mjs';
import { ASKS_ORCHESTRATOR } from './worker-status.mjs';
import { route } from './route.mjs';
import { exhausted } from './usage.mjs';
import {
  freeSlots, liveLeases, runningByInstance, DEFAULT_LEASE_TTL_MINUTES,
} from './leases.mjs';
import {
  MIN, unitIds, leaseOf, awaitsFeedback, emit, removeLease, providerFailure, alive, fixFirst,
} from './tick-util.mjs';
import {
  gates, feedback, integrations, finalGate, rollingFinal, MAX_NUDGES,
} from './tick-gates.mjs';

const FLYING = ['running', 'blocked', 'gating'];
export const GATE_BACKLOG_FACTOR = 2;
const ENDED = ['failed', 'cancelled', 'interrupted', 'missing'];
const DEFAULTS = {
  stallMinutes: 20, gateConcurrency: 2, perInstanceLimit: 2, leaseTtlMinutes: DEFAULT_LEASE_TTL_MINUTES,
};
const MAX_PROVIDER_FAILURES = 3;
const MAX_LIMIT_FAILURES = 10; // uncounted limits, each with a cooldown; past this the reply is likely misread
const MAX_AUTH_FAILURES = 2;
const FEEDBACK_VISIBLE_MS = 2 * MIN;
const NO_AUTHORS = { maxTier: 2, family: 'unknown' }; // before anything is integrated
const LIMIT_QUIET_MINUTES = 5; // quiet this long on an account T3 shows used up or signed out: it hit the limit mid-run

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
  giveUp(t, id, unit, minutes, null);
}

// The thread may still run in T3 (orq cannot interrupt it): its lease is kept, abandoned, and the orchestrator told.
function giveUp(t, id, unit, minutes, limit) {
  providerFailure(t, id, unit, 'stalled', limit);
  const why = limit ? `its provider stopped it: ${limit.reason}; ` : '';
  t.notes.push(`note: unit ${id} gave up on thread ${unit.threadId} (${why}quiet for ${minutes} min); it still holds a slot until it ends: interrupt it (t3_thread_interrupt)`);
}

// Most stop reports are unfinished work ("not done yet"): the first one of a launch is answered in the same thread,
// with the worker's reason quoted (an `unfinished` with `stop`); a second one, or one after a nudge, is judged.
function stopReport(t, id, unit, report) {
  const reason = `worker reported ${report.status}: ${report.detail}`;
  if (unit.nudges < MAX_NUDGES && unit.threadId) emit(t, 'unfinished', id, { failures: [reason], headSha: unit.headSha, stop: report.status });
  else emit(t, 'needs-judgment', id, { reason });
}

const quiet = (t, th) => Math.floor((t.now - th.updatedAt) / MIN);

function observe(t, id) {
  const unit = unitOf(t.st, id);
  const th = t.threads[unit.threadId];
  const status = th ? th.status : 'missing';
  if (status === 'completed' && unit.since !== null && th.updatedAt <= unit.since) {
    feedbackNotStarted(t, id, unit);
  } else if (status === 'completed' && th.limit) {
    providerFailure(t, id, unit, 'failed', th.limit); // a limit reply ends the turn "completed": nothing to gate
  } else if (status === 'completed') {
    emit(t, 'thread-ended', id, { status });
    removeLease(t, id, unit.threadId);
    alive(t, id, unit);
    // th.report: the parsed status line of the worker's reply, supplied by the caller (null when unread)
    if (ASKS_ORCHESTRATOR.includes(th.report?.status)) stopReport(t, id, unit, th.report);
  } else if (ENDED.includes(status)) {
    providerFailure(t, id, unit, status, th?.limit ?? null);
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
  } else if (unit.state === 'running' && quiet(t, th) >= LIMIT_QUIET_MINUTES && exhausted(t.registry, unit.key, t.now)) {
    giveUp(t, id, unit, quiet(t, th), exhausted(t.registry, unit.key, t.now));
  } else if (unit.state === 'running' && t.now - th.updatedAt > t.config.stallMinutes * MIN) {
    stalled(t, id, unit, Math.floor((t.now - th.updatedAt) / MIN));
  }
}

// the families of the models whose threads failed this unit: its relaunch prefers another (route.mjs)
const familiesOf = (t, keys) => [...new Set(keys.map((k) => t.registry.models[k]?.family).filter(Boolean))];

function candidate(t, id, running) {
  const unit = unitOf(t.st, id);
  const pu = t.plan.units.find((u) => u.id === id);
  const authors = authorsOf(t.plan.units.map((u) => u.id), t.st) ?? NO_AUTHORS;
  // every relaunch goes to a model no attempt used, of another family first; a used one only when nothing else is left
  const used = [...new Set([...unit.failedKeys, ...(unit.used ?? [])])];
  const r = route({
    registry: t.registry, rules: t.rules, job: pu.job, authorTier: authors.maxTier, authorFamily: authors.family, running, exclude: unit.tried, avoidKeys: used, avoidInstances: unit.triedInstances, avoidFamilies: familiesOf(t, used), now: t.now,
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
    ...(used.includes(c.key) ? { reused: true } : {}),
  };
}

function launch(t) {
  for (const id of unitIds(t, ['queued'])) {
    // a dropped dependency never integrates (a hand-edited plan or an older ledger; `orq unit drop` refuses it)
    const gone = (t.plan.units.find((u) => u.id === id).deps ?? []).find((d) => unitOf(t.st, d).state === 'dropped');
    const u = unitOf(t.st, id);
    const signedOut = u.authFailures >= MAX_AUTH_FAILURES ? u.failedLaunch?.key?.split('::')[0] : null; // a sign-out does not end by itself
    if (u.providerFailures >= MAX_PROVIDER_FAILURES) emit(t, 'needs-judgment', id, { reason: '3 provider failures', provider: true });
    else if (signedOut) emit(t, 'needs-judgment', id, { reason: `instance ${signedOut} is signed out: sign in to it in T3, then "orq unit retry ${id}"`, provider: true });
    else if (u.limitFailures >= MAX_LIMIT_FAILURES) emit(t, 'needs-judgment', id, { reason: `${MAX_LIMIT_FAILURES} limit failures`, provider: true });
    else if (gone) emit(t, 'needs-judgment', id, { reason: `depends on dropped unit ${gone}` });
  }
  const ready = fixFirst(t, readyUnits(t.plan, unitIds(t, ['integrated'])));
  if (t.hold) { // the machine is under pressure or a protected service fails (admission.mjs): nothing new starts
    t.heldBack += ready.filter((id) => unitOf(t.st, id).state === 'queued' && !awaitsFeedback(unitOf(t.st, id))).length;
    return;
  }
  const anyPassed = unitIds(t, ['passed', 'integrated']).length > 0;
  let inFlight = unitIds(t, FLYING).length + unitIds(t, ['queued']).filter((id) => awaitsFeedback(unitOf(t.st, id))).length;
  const running = { ...runningByInstance(t.leases) };
  // checks are the bottleneck: more coding only lengthens the queue, so new launches wait while it is long
  // (relaunches of a failed unit still go: their work is already in the queue's past)
  const backedUp = t.gateBacklog > GATE_BACKLOG_FACTOR * t.config.gateConcurrency;
  if (backedUp) t.notes.push(`note: ${t.gateBacklog} units wait for checks (over ${GATE_BACKLOG_FACTOR}x gateConcurrency ${t.config.gateConcurrency}); new units wait`);
  for (const id of ready) {
    const u = unitOf(t.st, id);
    if (u.state !== 'queued' || awaitsFeedback(u)) continue;
    if (!anyPassed && !t.config.proven && inFlight >= 1) break; // start one unit first, in a project not proven yet
    if (backedUp && u.attempt === 0) continue;
    const a = candidate(t, id, running); // route first: an unroutable unit is reported whether or not a slot is free
    if (!a) continue;
    if (t.slots <= 0) { t.slotWaiting.push(id); continue; }
    t.actions.push(a);
    if (a.reused) t.notes.push(`note: unit ${id} relaunched on ${a.key}, a model an earlier attempt used: no unused model is eligible`);
    running[a.instance] = (running[a.instance] ?? 0) + 1;
    t.slots -= 1;
    inFlight += 1;
    t.launched += 1;
  }
}

function complete(t) {
  const states = t.plan.units.map((u) => unitOf(t.st, u.id).state);
  if (t.config.continuous && states.includes('integrated')) rollingFinal(t); // before the plan is complete too
  if (!states.every((s) => s === 'integrated' || s === 'dropped')) return false;
  const p = t.st.plan;
  if (!states.includes('integrated') || p.final?.head === p.integrationHead) return true; // final gate is per head
  return t.config.continuous ? false : finalGate(t);
}

function report(t, done) {
  const judgment = unitIds(t, ['failed']).map((id) => ({ unit: id, reason: unitOf(t.st, id).reason }));
  if (t.finalJudgment) judgment.push({ unit: FINAL, reason: t.finalJudgment });
  return {
    done, judgment, newlyBlocked: t.newlyBlocked, stalled: t.stalled, notes: t.notes, unroutable: t.unroutable,
    noSlots: t.slotWaiting.length > 0, slotWaiting: t.slotWaiting, capBy: t.capBy, // ready units that only lack a slot; the cap in force
    held: t.heldBack > 0, hold: t.hold, heldBack: t.heldBack, // launches, feedback and gates a held machine did not start, and why
    inFlight: unitIds(t, [...FLYING, 'passed']).length + t.launched + unitIds(t, ['queued']).filter((id) => awaitsFeedback(unitOf(t.st, id))).length,
    queued: unitIds(t, ['queued']).length - t.launched,
  };
}

export function tick(input) {
  const config = { ...DEFAULTS, ...input.config };
  const leases = liveLeases(input.leases, input.now, config.leaseTtlMinutes * MIN); // expired leases hold no slot
  // projectCap (optional): this project's own limit; project: the path its leases record
  const free = freeSlots({
    cap: input.cap, projectCap: input.projectCap, project: input.project, leases,
  });
  const t = {
    ...input, config, leases, st: input.state, events: [], actions: [], capBy: free.by,
    slots: free.slots, newlyBlocked: [], stalled: [], unroutable: [], notes: [],
    slotWaiting: [], launched: 0, gateFree: 0, gateBacklog: 0, finalJudgment: null,
    hold: input.hold?.reasons?.length ? input.hold.reasons.join('; ') : null, heldBack: 0, // hold: {reasons} from admission.mjs
  };
  for (const id of unitIds(t, ['running', 'blocked'])) observe(t, id);
  gates(t);
  feedback(t);
  integrations(t);
  launch(t);
  const done = complete(t);
  return { events: t.events, actions: t.actions, report: report(t, done) };
}
