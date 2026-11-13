// Perform one action decided by tick. Each effect runs its subprocess outside any lock, then records the
// resulting events under the project lock, re-checking that they still apply (a unit may have been dropped).
import { integrate } from './integrate.mjs';
import {
  commit, readState, readStateLocked, unitOf,
} from './ledger.mjs';
import { removeLease, setLeaseBlocked, writeLease } from './leases.mjs';
import { markAlive, recordFailure, recordSuccess } from './health.mjs';
import { integrationDir, leasesDir } from './paths.mjs';
import {
  failureText, launchUnit, reserve, ttlMs, updateRegistry, withMachine,
} from './launch.mjs';
import { startFinalGate, startUnitGate } from './gaterun.mjs';
import { awaitsFeedback } from './tick-util.mjs';

const lastLine = (message) => String(message).trim().split('\n').at(-1);
const commitIf = (fx, unit, applies, events) => commit(fx.cwd, (s) => (applies(unitOf(s, unit)) ? events() : []));
const isPassed = (u) => u.state === 'passed';

async function integrateUnit(fx, unit) {
  const { plan, units } = await readStateLocked(fx.cwd);
  const u = units[unit];
  if (!u || !isPassed(u)) return { skipped: 'not passed' };
  let r;
  try {
    r = integrate({
      repo: fx.cwd, dir: integrationDir(fx.cwd), branch: plan.integrationBranch, baseSha: plan.baseSha,
      units: [{ id: unit, sha: u.headSha }], git: fx.git,
    });
  } catch (e) {
    await commitIf(fx, unit, isPassed, () => [{ type: 'needs-judgment', unit, at: fx.now(), reason: `integrate failed: ${lastLine(e.message)}` }]);
    return { error: e.message };
  }
  const e = r.ok
    ? { type: 'integrated', sha: u.headSha, head: r.head }
    : { type: 'needs-judgment', reason: `merge conflict: ${r.conflict.files.join(', ')}` };
  await commitIf(fx, unit, isPassed, () => [{ ...e, unit, at: fx.now() }]);
  return {};
}

async function feedbackFailed(fx, a, error) {
  const awaiting = (u) => awaitsFeedback(u) && u.threadId === a.threadId;
  await commitIf(fx, a.unit, awaiting, () => [
    { type: 'feedback-sent', unit: a.unit, at: fx.now(), attempt: a.attempt, threadId: a.threadId },
    { type: 'thread-ended', unit: a.unit, at: fx.now(), status: 'failed' },
  ]);
  await updateRegistry(fx, (r) => recordFailure(r, a.key, { now: fx.now(), kind: 'unknown' }));
  return { error: error.message };
}

// Reserve a slot, send, then record: `feedback-sent` is committed only after the send succeeded, so a crash
// before it leaves the unit awaiting feedback and the next poll sends again.
async function sendFeedback(fx, a, run) {
  const awaiting = (u) => awaitsFeedback(u) && u.threadId === a.threadId;
  if (!awaiting(unitOf(await readState(fx.cwd), a.unit))) return { skipped: 'no longer awaiting feedback' };
  const dir = leasesDir(fx.env);
  const reservation = await reserve(fx, a, run.cap, ttlMs(run.config));
  if (reservation === null) return { skipped: 'cap reached' };
  // ponytail: a crash after sendThread succeeds but before `feedback-sent` is committed re-sends the feedback on
  // the next poll, queueing a second run on the same thread. Accepted: a duplicate nudge is harmless, a lost one
  // strands the unit. Upgrade: record a send intent first and match it against the thread's messages.
  try {
    fx.t3.sendThread(a.threadId, `The gate rejected this work:\n${failureText(a.failures)}\nFix it, commit, and report.`);
  } catch (e) {
    await withMachine(fx, () => removeLease(dir, reservation));
    return feedbackFailed(fx, a, e);
  }
  await withMachine(fx, async () => {
    await writeLease(dir, {
      threadId: a.threadId, project: fx.cwd, unit: a.unit, instance: a.instance, model: a.model, startedAt: fx.now(), heartbeatAt: fx.now(), blocked: false,
    });
    await removeLease(dir, reservation);
  });
  const { events } = await commitIf(fx, a.unit, awaiting, () => [
    { type: 'feedback-sent', unit: a.unit, at: fx.now(), attempt: a.attempt, threadId: a.threadId },
  ]);
  if (events.length === 0) await withMachine(fx, () => removeLease(dir, a.threadId));
  return {};
}

const lease = (fx, fn) => withMachine(fx, () => fn(leasesDir(fx.env)));

const EFFECTS = {
  launch: (fx, a, run) => launchUnit(fx, a, run),
  'lease-block': (fx, a) => lease(fx, (dir) => setLeaseBlocked(dir, a.threadId, true)),
  'lease-unblock': (fx, a) => lease(fx, (dir) => setLeaseBlocked(dir, a.threadId, false)),
  'lease-remove': (fx, a) => lease(fx, (dir) => removeLease(dir, a.threadId)),
  'record-success': (fx, a) => updateRegistry(fx, (r) => recordSuccess(r, a.key, { now: fx.now(), jobClass: a.job, firstPass: a.firstPass })),
  'record-failure': (fx, a) => updateRegistry(fx, (r) => recordFailure(r, a.key, { now: fx.now(), jobClass: a.job, kind: a.kind })),
  'mark-alive': (fx, a) => updateRegistry(fx, (r) => (r.models[a.key] ? markAlive(r, a.key, fx.now()) : r)),
  'gate-start': (fx, a) => startUnitGate(fx, a),
  'final-gate': (fx) => startFinalGate(fx),
  integrate: (fx, a) => integrateUnit(fx, a.unit),
  'send-feedback': (fx, a, run) => sendFeedback(fx, a, run),
};

export async function perform(fx, action, run) {
  const effect = EFFECTS[action.type];
  if (!effect) throw new Error(`unknown action "${action.type}"`);
  return effect(fx, action, run);
}
