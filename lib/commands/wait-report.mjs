// What `orq wait` prints when it returns: one summary line, then detail lines.
import { unitOf, FINAL } from '../ledger.mjs';
import { awaitsFeedback } from '../tick-util.mjs';

const BUSY = ['running', 'blocked', 'gating', 'passed'];

export function countStates(plan, state) {
  const counts = {
    queued: 0, running: 0, blocked: 0, gating: 0, passed: 0, integrated: 0, failed: 0, dropped: 0,
  };
  for (const { id } of plan.units) counts[unitOf(state, id).state] += 1;
  return counts;
}

function finalPending(plan, state, counts) {
  return counts.integrated > 0 && counts.integrated + counts.dropped === plan.units.length
    && state.plan.final?.head !== state.plan.integrationHead;
}

function idleLines(report, counts) {
  if (report.unroutable.length) {
    const [first, ...rest] = report.unroutable;
    const times = report.unroutable.map((u) => u.retryAt).filter((x) => x !== null);
    const retry = times.length ? `; retry at ${new Date(Math.min(...times)).toISOString()}` : '';
    return [`idle: no model for ${first.unit}: ${first.reason}${retry}`, ...rest.map((u) => `${u.unit}: ${u.reason}`)];
  }
  if (counts.queued > 0) return [`idle: ${counts.queued} queued units wait on dependencies that will not finish`];
  return ['idle: nothing left to launch'];
}

export function decide({
  plan, report, state, launched,
}) {
  const counts = countStates(plan, state);
  if (report.done) {
    const head = (state.plan.integrationHead ?? state.plan.baseSha ?? '-').slice(0, 12);
    const { final } = state.plan;
    // never "done" on a failed run: it is the first word a script or a model reads
    if (final?.verdict === 'fail') return [`final-fail: ${counts.integrated} units integrated at ${head}; ${final.failures.join('; ')}`];
    return [`done: ${counts.integrated} units integrated at ${head}; final checks ${final?.verdict ?? 'none'}`];
  }
  const judgment = [
    ...plan.units.filter((u) => unitOf(state, u.id).state === 'failed').map((u) => ({ unit: u.id, reason: unitOf(state, u.id).reason })),
    ...report.judgment.filter((j) => j.unit === FINAL),
  ];
  if (judgment.length) return judgment.map((j, i) => `${i === 0 ? 'judgment: ' : ''}${j.unit}: ${j.reason}`);
  if (report.newlyBlocked.length) {
    return report.newlyBlocked.map((b, i) => `${i === 0 ? 'blocked: ' : ''}${b.unit} waiting on a request in thread ${b.threadId}`);
  }
  const feedbackDue = plan.units.some((u) => awaitsFeedback(unitOf(state, u.id))); // in flight, waiting for a slot
  // a full machine cap frees up when other projects' threads end: keep polling, like in-flight work
  const busy = BUSY.some((s) => counts[s] > 0) || launched > 0 || feedbackDue || report.noSlots || finalPending(plan, state, counts);
  return busy ? null : idleLines(report, counts);
}

export function timeoutLines(plan, state, report, cap) {
  const c = countStates(plan, state);
  return [
    `timeout: ${c.running} running, ${c.blocked} blocked, ${c.gating} gating, ${c.queued} queued, ${c.passed} passed`,
    ...(report.noSlots ? [`waiting: ${report.slotWaiting.length} ready units wait for a free slot (machine cap ${cap}, or a provider instance limit)`] : []),
    ...report.stalled.map((s) => `stalled: ${s.unit} thread ${s.threadId} quiet for ${s.minutes} min`),
  ];
}

// Notes go after the summary line and are trimmed first: a decision line is never cut to fit the cap.
// lead: how many lines come before the notes (the summary line, and a `settle:` line when there is one).
export function withNotes(out, notes, max = 7, lead = 1) {
  const room = max - out.length;
  if (notes.length <= room) return [...out.slice(0, lead), ...notes, ...out.slice(lead)];
  const shown = Math.max(0, room - 1);
  return [...out.slice(0, lead), ...notes.slice(0, shown), `note: ${notes.length - shown} more notes omitted`, ...out.slice(lead)];
}
