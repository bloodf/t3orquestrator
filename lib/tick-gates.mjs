// Tick passes after the threads are observed: gate results, feedback, and integration of passed units.
import { unitOf, FINAL } from './ledger.mjs';
import {
  unitIds, jobOf, emit, awaitsFeedback,
} from './tick-util.mjs';

const MAX_GATE_STARTS = 2;
const NO_GATE = { running: false, result: null };
const MAX_NUDGES = 1; // per launch: a thread that ends a second turn with nothing committed has failed its gate
const NO_COMMITS = 'no commits on top of ';
const NO_EVIDENCE = { kind: 'no-evidence', path: '', detail: 'passed without an evidence command' };

function onResult(t, id, unit, result) {
  const { verdict, failures } = result;
  // the project's setup failed, not the unit: no feedback, no relaunch, no rung of the quality ladder
  if (result.setupFailed) {
    emit(t, 'needs-judgment', id, { reason: failures.join('; '), setup: true });
    return;
  }
  // nothing committed and nothing else wrong: the worker ended its turn early (seen in one gate out of four)
  const noCommits = verdict === 'fail' && failures.length === 1 && failures[0].startsWith(NO_COMMITS);
  if (noCommits && unit.nudges < MAX_NUDGES && unit.threadId) {
    emit(t, 'unfinished', id, { failures, headSha: result.headSha });
    return;
  }
  const flags = verdict === 'no-evidence' ? [...result.flags, NO_EVIDENCE] : result.flags;
  // told once already and again nothing committed: saying it a third time is no rung, a new thread is
  const unanswered = noCommits && unit.nudges > 0 && unit.attempt === 1;
  emit(t, 'gated', id, { attempt: unit.attempt, verdict, failures, flags, headSha: result.headSha, ...(unanswered ? { unanswered } : {}) });
  // the model's record: the first verdict of each launch, on work it began (not feedback, not a continuation)
  if (!unit.judged && !unit.continues) t.actions.push({ type: 'record-result', unit: id, key: unit.key, job: jobOf(t, id), pass: verdict !== 'fail' });
  if (verdict !== 'fail') {
    t.actions.push({ type: 'record-success', unit: id, key: unit.key, job: jobOf(t, id), firstPass: unit.attempt === 1 && unit.nudges === 0 });
  } else if (unit.attempt >= 3) {
    emit(t, 'needs-judgment', id, { reason: `gate failed 3 times: ${failures.join('; ')}` });
  }
  // attempt 1 failed: the unit now awaits feedback (feedback pass); attempt 2 failed: it relaunches one tier up
}

// A result is trusted only for the commit recorded when this attempt's gate started.
function gateOf(t, id, unit) {
  const g = unit.gateStarts > 0 ? t.gates[id] ?? NO_GATE : NO_GATE;
  return g.result && g.result.headSha !== unit.headSha ? { running: g.running, result: null } : g;
}

export function gates(t) {
  const want = [];
  let running = t.gates[FINAL]?.running ? 1 : 0;
  for (const id of unitIds(t, ['gating'])) {
    const unit = unitOf(t.st, id);
    const g = gateOf(t, id, unit);
    if (g.result) onResult(t, id, unit, g.result);
    else if (g.running) running += 1;
    else if (unit.gateStarts >= MAX_GATE_STARTS) emit(t, 'needs-judgment', id, { reason: `gate could not complete${g.error ? `: ${g.error}` : ''}`, regate: true });
    else want.push(id);
  }
  t.gateFree = t.config.gateConcurrency - running;
  for (const id of want.slice(0, Math.max(0, t.gateFree))) {
    t.actions.push({ type: 'gate-start', unit: id, attempt: unitOf(t.st, id).attempt });
    t.gateFree -= 1;
  }
}

// Feedback restarts the same thread, so it takes a slot; without one it waits for a later poll.
export function feedback(t) {
  for (const id of unitIds(t, ['queued'])) {
    const u = unitOf(t.st, id);
    if (!awaitsFeedback(u)) continue;
    if (t.slots < 1) {
      t.slotWaiting.push(id); // still in flight: `wait` keeps polling until a slot frees
      continue;
    }
    t.slots -= 1;
    t.actions.push({
      type: 'send-feedback', unit: id, attempt: u.attempt, threadId: u.threadId, failures: u.lastFailure, key: u.key, instance: u.instance, model: u.model,
    });
  }
}

// Every poll: the merge is idempotent, so a passed unit is never stranded by a crash or an error.
export function integrations(t) {
  for (const id of unitIds(t, ['passed'])) t.actions.push({ type: 'integrate', unit: id });
}

export function finalGate(t) {
  const p = t.st.plan;
  const g = p.finalGateStarts > 0 ? t.gates[FINAL] ?? NO_GATE : NO_GATE;
  if (g.result?.setupFailed && g.result.headSha === p.integrationHead) {
    t.finalJudgment = g.result.failures.join('; '); // not a verdict on the integrated work
    return false;
  }
  if (g.result && g.result.headSha === p.integrationHead) {
    emit(t, 'final-gated', null, { verdict: g.result.verdict, failures: g.result.failures, head: g.result.headSha });
    return true;
  }
  if (g.running) return false;
  if (p.finalGateStarts >= MAX_GATE_STARTS) t.finalJudgment = `final gate could not complete${g.error ? `: ${g.error}` : ''}`;
  else if (t.gateFree > 0) t.actions.push({ type: 'final-gate' });
  return false;
}
