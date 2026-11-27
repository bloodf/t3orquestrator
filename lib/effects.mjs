// Perform one action decided by tick. Each effect runs its subprocess outside any lock, then records the
// resulting events under the project lock, re-checking that they still apply (a unit may have been dropped).
import { integrate } from './integrate.mjs';
import {
  commit, readState, readStateLocked, unitOf,
} from './ledger.mjs';
import {
  abandonLease, removeLease, setLeaseBlocked, writeLease,
} from './leases.mjs';
import {
  markAlive, recordFailure, recordLimit, recordResult, recordSuccess,
} from './health.mjs';
import path from 'node:path';
import { integrationDir, leasesDir, projectDir } from './paths.mjs';
import { moveBranch, stripUnitCredit } from './strip-credit.mjs';
import {
  gateFeedback, launchUnit, reserve, ttlMs, updateRegistry, withMachine,
} from './launch.mjs';
import { startFinalGate, startUnitGate } from './gaterun.mjs';
import { awaitsFeedback, CONFLICT } from './tick-util.mjs';
import { removeUnitWorktrees } from './worktree-cleanup.mjs';
import { installLine, replaceOldShares } from './share.mjs';

const lastLine = (message) => String(message).trim().split('\n').at(-1);
const commitIf = (fx, unit, applies, events) => commit(fx.cwd, (s) => (applies(unitOf(s, unit)) ? events() : []));
const isPassed = (u) => u.state === 'passed';

// A worker whose turn ended without a commit (seen: a progress note, "INCOMPLETE", in any language) gets a plain
// instruction instead of a failure list: it is the implementer, and asking is the only way to stop. A worker that
// stopped with BLOCKED or NEEDS_CONTEXT is quoted and asked to go on, or to name the one thing it lacks.
export function feedbackMessage(failures, report) {
  const stop = (failures ?? []).find((f) => String(f).startsWith('worker reported '));
  if (stop) {
    return [
      `You stopped with: "${String(stop).slice('worker reported '.length)}".`,
      'Unfinished work is not a blocker: you are the implementer, so continue the work order in this worktree, commit it, then report.',
      'A file outside "You may write" that the goal needs and that "You must not touch" does not list is yours to edit, unless it is a package manifest or lockfile: edit it and name it in your report. Do not ask for it.',
      'If you truly cannot go on without something you do not have, reply again with first line BLOCKED (or NEEDS_CONTEXT) and name the one specific thing you need and where you looked for it.',
    ].join('\n');
  }
  const conflict = (failures ?? []).find((f) => String(f).startsWith(CONFLICT));
  if (conflict) return `Your work passed its checks, but it could not be merged: ${conflict}`;
  const none = (failures ?? []).find((f) => String(f).startsWith('no commits on top of '));
  if (!none) return `The gate rejected this work:\n${report}\nFix it, commit, and report.`;
  return [
    `Your turn ended with nothing committed (${none}), so the work order is not done.`,
    'You are the implementer of this work order: do the work in this worktree yourself, commit it, then report.',
    'Do not wait for another thread or for approval, and do not end your turn to report progress.',
    'If something truly blocks you, or you find that nothing needs to change, reply with first line BLOCKED or NEEDS_CONTEXT and say why.',
  ].join('\n');
}

export const MAX_CONFLICTS = 2; // per launch: past it the plan's paths overlap, and that is the orchestrator's call

// A unit that conflicts goes back to its worker, which merges the head and resolves it: a fresh worker for a
// conflict redid the whole unit (seen: about an hour each time, and the head moved on and conflicted again).
function conflictEvent(u, files, head) {
  const reason = `merge conflict: ${files.join(', ')}`;
  if (!u.threadId || u.conflicts >= MAX_CONFLICTS) return { type: 'needs-judgment', reason };
  const failures = [`${CONFLICT}${files.join(', ')}: other units landed first. In this worktree run \`git merge ${head}\` `
    + '(exactly this commit, not the branch, which moves), resolve each conflict keeping both sides\' changes, run the checks that cover those files, commit, and report.'];
  return { type: 'conflicted', failures, baseSha: head };
}

async function integrateUnit(fx, unit) {
  const { plan, units } = await readStateLocked(fx.cwd);
  const u = units[unit];
  if (!u || !isPassed(u)) return { skipped: 'not passed' };
  let r;
  let sha = u.headSha;
  let move = null;
  try {
    // its own commits lose any tool or model credit first: same trees, so the gate's verdict holds for them
    ({ head: sha, move } = stripUnitCredit({
      git: fx.git, cwd: fx.cwd, head: u.headSha, stop: [plan.integrationHead], branch: u.branch, scratch: path.join(projectDir(fx.cwd), 'commit.tmp'),
    }));
    r = integrate({
      repo: fx.cwd, dir: integrationDir(fx.cwd), branch: plan.integrationBranch, baseSha: plan.baseSha,
      units: [{ id: unit, sha }], git: fx.git,
    });
    if (r.ok) moveBranch(fx.git, fx.cwd, move); // a conflict leaves the worker's branch as it was
  } catch (e) {
    await commitIf(fx, unit, isPassed, () => [{ type: 'needs-judgment', unit, at: fx.now(), reason: `integrate failed: ${lastLine(e.message)}` }]);
    return { error: e.message };
  }
  const e = r.ok ? { type: 'integrated', sha, head: r.head, ...(sha === u.headSha ? {} : { original: u.headSha }) } : conflictEvent(u, r.conflict.files, plan.integrationHead);
  const { events } = await commitIf(fx, unit, isPassed, () => [{ ...e, unit, at: fx.now() }]);
  // merged: its threads' checkouts only take disk now (with cleanup on, `orq wait` sweeps them right after this poll)
  if (r.ok && events.length && !fx.cleanup) await removeUnitWorktrees(fx, unit);
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
  const u = unitOf(await readState(fx.cwd), a.unit);
  if (!awaiting(u)) return { skipped: 'no longer awaiting feedback' };
  const dir = leasesDir(fx.env);
  const reservation = await reserve(fx, a, run.cap, ttlMs(run.config));
  if (reservation === null) return { skipped: 'cap reached' };
  // ponytail: a crash after sendThread succeeds but before `feedback-sent` is committed re-sends the feedback on
  // the next poll, queueing a second run on the same thread. Accepted: a duplicate nudge is harmless, a lost one
  // strands the unit. Upgrade: record a send intent first and match it against the thread's messages.
  // read before the send, outside any lock. Feedback quotes the previous attempt's gate; a nudge is about this attempt's
  const report = await gateFeedback(fx.cwd, a.unit, a.attempt - (u.nudge ? 0 : 1), a.failures);
  // an old pnpm link in its worktree (orq once shared pnpm node_modules) becomes a real install before it works again
  const old = replaceOldShares(fx, a.threadId);
  const message = feedbackMessage(a.failures, report);
  const runStartedAt = fx.now(); // before the send: a refusal logged at once belongs to this run
  try {
    fx.t3.sendThread(a.threadId, old.installed === false ? [installLine(fx.cwd, run.config.install ?? null), message].filter(Boolean).join('\n\n') : message);
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
    { type: 'feedback-sent', unit: a.unit, at: fx.now(), attempt: a.attempt, threadId: a.threadId, runStartedAt },
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
  'lease-abandon': (fx, a) => lease(fx, (dir) => abandonLease(dir, a.threadId)),
  'record-success': (fx, a) => updateRegistry(fx, (r) => recordSuccess(r, a.key, { now: fx.now(), jobClass: a.job, firstPass: a.firstPass })),
  'record-result': (fx, a) => updateRegistry(fx, (r) => (r.models[a.key] ? recordResult(r, a.key, { now: fx.now(), jobClass: a.job, pass: a.pass }) : r)),
  'record-failure': (fx, a) => updateRegistry(fx, (r) => recordFailure(r, a.key, { now: fx.now(), jobClass: a.job, kind: a.kind })),
  'record-limit': (fx, a) => updateRegistry(fx, (r) => (r.models[a.key] ? recordLimit(r, a.key, a.limit, fx.now()) : r)),
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
