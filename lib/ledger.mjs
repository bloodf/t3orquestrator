// Unit lifecycle as an explicit state machine. The ledger is append-only; all state is derived here.
//   queued -> running <-> blocked -> gating -> passed -> integrated, plus failed (needs judgment) and dropped.
// A queued unit's `attempt` is the attempt it will launch as (0 means never launched: launches as 1).
import { appendLine, readLines } from './store.mjs';
import { withLock } from './lock.mjs';
import fs from 'node:fs/promises';
import { archivingPath, ledgerPath, projectLockPath } from './paths.mjs';

export const FINAL = 'integration'; // reserved unit id for the final gate on the integration head
const VERDICTS = ['pass', 'fail', 'no-evidence'];
const OPEN = ['queued', 'running', 'blocked', 'gating', 'passed'];

export function initialUnit() {
  return {
    state: 'queued', attempt: 0, providerFailures: 0, launches: 0, threadId: null, key: null, instance: null,
    model: null, family: null, branch: null, baseSha: null, headSha: null, tier: null, wantedTier: null, minTier: null, tried: [], failedKeys: [], triedInstances: [], lastFailure: null,
    reason: null, setupFailed: false, flags: [], blockedReported: false, gateStarts: 0, since: null,
  };
}

export function emptyState() {
  return {
    plan: {
      planId: null, baseSha: null, integrationBranch: null, integrationHead: null, final: null, finalGateStarts: 0,
    },
    units: {},
  };
}

export const unitOf = (state, id) => state.units[id] ?? initialUnit();

function sameAttempt(u, e) {
  if (e.attempt !== u.attempt) throw new Error(`${e.type} for unit ${e.unit}: attempt ${e.attempt}, unit is at ${u.attempt}`);
}

function onGated(u, e) {
  sameAttempt(u, e);
  if (!VERDICTS.includes(e.verdict)) throw new Error(`gated for unit ${e.unit}: unknown verdict "${e.verdict}"`);
  const common = { headSha: e.headSha, flags: e.flags ?? [] };
  if (e.verdict !== 'fail') return { ...common, state: 'passed' };
  const attempt = u.attempt + 1;
  if (attempt !== 3) return { ...common, state: 'queued', attempt, lastFailure: e.failures };
  // attempt 3 runs one tier up and never on the model that just failed twice
  const tried = u.key === null || u.tried.includes(u.key) ? u.tried : [...u.tried, u.key];
  return {
    ...common, state: 'queued', attempt, minTier: Math.min(4, (u.tier ?? 1) + 1), tried, lastFailure: e.failures,
  };
}

// event type -> [states it may leave from, patch(unit, event)]
const UNIT_EVENTS = {
  launched: [['queued'], (u, e) => ({
    state: 'running', attempt: e.attempt, launches: u.launches + 1, threadId: e.threadId, key: e.key,
    instance: e.instance, model: e.model, family: e.family ?? null, branch: e.branch, baseSha: e.baseSha, tier: e.tier, wantedTier: e.wantedTier ?? null,
    headSha: null,
    since: null, blockedReported: false, gateStarts: 0,
  })],
  blocked: [['running'], () => ({ state: 'blocked', blockedReported: true })],
  unblocked: [['blocked'], () => ({ state: 'running', blockedReported: false })],
  'thread-ended': [['running', 'blocked'], (u, e) => (e.status === 'completed'
    ? { state: 'gating', gateStarts: 0 }
    : {
      // a provider failure: prefer other models and instances, but never exclude one (the backoff spaces retries)
      state: 'queued', threadId: null, providerFailures: u.providerFailures + 1,
      failedKeys: u.key === null || u.failedKeys.includes(u.key) ? u.failedKeys : [...u.failedKeys, u.key],
      triedInstances: u.instance === null || u.triedInstances.includes(u.instance) ? u.triedInstances : [...u.triedInstances, u.instance],
    })],
  'feedback-sent': [['queued'], (u, e) => {
    sameAttempt(u, e);
    return { state: 'running', threadId: e.threadId, since: e.at };
  }],
  'gate-started': [['gating'], (u, e) => {
    sameAttempt(u, e);
    return { gateStarts: u.gateStarts + 1, headSha: e.headSha };
  }],
  gated: [['gating'], onGated],
  integrated: [['passed'], () => ({ state: 'integrated' })],
  'needs-judgment': [OPEN, (u, e) => ({ state: 'failed', reason: e.reason, setupFailed: e.setup === true })],
  dropped: [[...OPEN, 'failed'], () => ({ state: 'dropped' })],
  retried: [['failed'], (u, e) => (u.setupFailed
    // the project's setup was fixed: gate the same commit again (since: null, or it reads as "no new commit after feedback")
    ? { state: 'gating', gateStarts: 0, since: null, reason: null, setupFailed: false }
    : {
      state: 'queued', attempt: 0, providerFailures: 0, tried: [], failedKeys: [], triedInstances: [], minTier: e.tier ?? null, reason: null,
      lastFailure: null, gateStarts: 0,
    })],
};

function applyPlan(state, e) {
  const { plan } = state;
  if (e.type === 'plan-started') {
    if (plan.planId !== null) throw new Error(`plan already started as ${plan.planId}`);
    return {
      ...state,
      plan: {
        ...plan, planId: e.planId, baseSha: e.baseSha, integrationBranch: e.integrationBranch, integrationHead: e.baseSha,
      },
    };
  }
  if (plan.planId === null) throw new Error(`${e.type}: plan not started`);
  if (e.type === 'final-retried') return { ...state, plan: { ...plan, finalGateStarts: 0 } }; // orq unit retry integration
  if (e.type === 'final-gated') return { ...state, plan: { ...plan, final: { verdict: e.verdict, failures: e.failures, head: e.head } } };
  return { ...state, plan: { ...plan, finalGateStarts: plan.finalGateStarts + 1 } }; // gate-started on FINAL
}

export function apply(state, e) {
  const planLevel = ['plan-started', 'final-gated', 'final-retried'].includes(e.type);
  if (planLevel || (e.type === 'gate-started' && e.unit === FINAL)) {
    return applyPlan(state, e);
  }
  const entry = UNIT_EVENTS[e.type];
  if (!entry) throw new Error(`unknown event type "${e.type}"`);
  if (e.type === 'launched' && state.plan.planId === null) throw new Error('launched: plan not started');
  const [from, patch] = entry;
  const u = unitOf(state, e.unit);
  if (!from.includes(u.state)) throw new Error(`illegal transition for unit ${e.unit}: ${e.type} from ${u.state}`);
  // a new integration head needs its own final gate
  const plan = e.type === 'integrated' ? { ...state.plan, integrationHead: e.head, finalGateStarts: 0 } : state.plan;
  return { plan, units: { ...state.units, [e.unit]: { ...u, ...patch(u, e) } } };
}

export const reduce = (events) => events.reduce(apply, emptyState());

// Ledger I/O. Only orq writes the ledger, always under the project lock; never run a subprocess inside `fn`.
// While `orq plan archive` is unfinished the plan state is frozen: everything that reads or writes it refuses,
// so nothing can change between a crash and the re-run that completes the archive.
export async function assertNotArchiving(cwd) {
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(archivingPath(cwd), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    marker = { planId: 'unknown' }; // a torn marker still freezes the project
  }
  const err = new Error(`an archive of plan ${marker.planId ?? marker.name} was interrupted; run "orq plan archive" to finish it (or delete .orq/archiving.json to unfreeze without archiving)`);
  err.exitCode = 4;
  throw err;
}

export async function readState(cwd) {
  await assertNotArchiving(cwd);
  return reduce(await readLines(ledgerPath(cwd)));
}
export const readStateLocked = (cwd) => withLock(projectLockPath(cwd), () => readState(cwd));

export function commit(cwd, fn) {
  return withLock(projectLockPath(cwd), async () => {
    await assertNotArchiving(cwd); // re-checked under the lock the archive takes
    const state = reduce(await readLines(ledgerPath(cwd)));
    const events = await fn(state);
    const next = events.reduce(apply, state); // an illegal event throws before anything is written
    for (const e of events) await appendLine(ledgerPath(cwd), e);
    return { state: next, events };
  });
}

// The author of integrated work, for review/fix routing: the highest tier used, its family from the first
// such unit in `ids` order. null when nothing is integrated.
export function authorsOf(ids, state) {
  const done = ids.map((id) => unitOf(state, id)).filter((u) => u.state === 'integrated' && u.tier !== null);
  if (done.length === 0) return null;
  const maxTier = Math.max(...done.map((u) => u.tier));
  return { maxTier, family: done.find((u) => u.tier === maxTier).family ?? 'unknown' };
}
