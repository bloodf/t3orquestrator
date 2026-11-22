// What `orq wait` prints when it returns: one summary line, then detail lines.
import { unitOf, FINAL } from '../ledger.mjs';
import { awaitsFeedback } from '../tick-util.mjs';
import { goalLines } from '../goal.mjs';
import { shipUnits, unshipped } from '../ship.mjs';

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

function doneLines(state, counts, goal) {
  const head = (state.plan.integrationHead ?? state.plan.baseSha ?? '-').slice(0, 12);
  const { final } = state.plan;
  // never "done" on a failed run: it is the first word a script or a model reads
  if (final?.verdict === 'fail') return [`final-fail: ${counts.integrated} units integrated at ${head}; ${final.failures.join('; ')}`];
  return [`done: ${counts.integrated} units integrated at ${head}; final checks ${final?.verdict ?? 'none'}`, ...goalLines(goal, 'wait')];
}

const conflicts = (files) => (files?.length ? ` and merging it conflicts in ${files.join(', ')}` : '');

// continuous: every head that passed ships; the plan is done once its last head is shipped.
// stale: origin's base moved past the passed head (wait-sync.mjs); synced: orq merged it, the final checks are due
function continuousLines(report, state, counts, goal, stale) {
  const p = state.plan;
  if (stale && !stale.synced && report.done && p.final?.verdict !== 'fail') {
    return [`ship-blocked: ${p.green.slice(0, 12)} passed the final checks, but origin/${stale.base} moved past it${conflicts(stale.files)}; append a unit with job "fix" that merges origin/${stale.base} into the integration branch`];
  }
  if (unshipped(p) && !stale) return [`ship-ready: ${p.green.slice(0, 12)} passed the final checks; ${shipUnits(p).length} units not shipped yet; run "orq ship --title <conventional title> --body-file <summary file>"`];
  if (report.done && (p.final?.verdict !== 'pass' || counts.integrated === 0 || p.shipped === p.integrationHead)) return doneLines(state, counts, goal);
  // once per failing head: `orq wait` records it as noted when it prints this
  if (!report.done && p.final?.verdict === 'fail' && p.final.head !== p.noted) {
    const head12 = p.final.head.slice(0, 12);
    return [`final-fail: ${head12} fails the final checks while units are still open; ${p.final.failures.join('; ')}; details in .orq/units/integration/head-${head12}.json`];
  }
  return null;
}

export function decide({
  plan, report, state, launched, goal, continuous = false, stale = null,
}) {
  const counts = countStates(plan, state);
  if (report.done && !continuous) return doneLines(state, counts, goal);
  const judgment = [
    ...plan.units.filter((u) => unitOf(state, u.id).state === 'failed').map((u) => ({ unit: u.id, reason: unitOf(state, u.id).reason })),
    ...report.judgment.filter((j) => j.unit === FINAL),
  ];
  if (judgment.length) return judgment.map((j, i) => `${i === 0 ? 'judgment: ' : ''}${j.unit}: ${j.reason}`);
  const rolling = continuous ? continuousLines(report, state, counts, goal, stale) : null;
  if (rolling) return rolling;
  const feedbackDue = plan.units.some((u) => awaitsFeedback(unitOf(state, u.id))); // in flight, waiting for a slot
  // a full machine cap frees up when other projects' threads end: keep polling, like in-flight work
  // a held machine (pressure, a protected service) goes on once it is free: keep polling, like a full cap
  const busy = BUSY.some((s) => counts[s] > 0) || launched > 0 || feedbackDue || report.noSlots || report.held || finalPending(plan, state, counts);
  return busy ? null : idleLines(report, counts);
}

// Finished units wait in the integration branch until the last one is in: in real plans 80% were integrated
// within 30 minutes and the last unit took hours more. Past that point, say how to ship what is done.
const SHIP_AFTER_MIN = 30;
function shipLine(plan, state, c, now) {
  const last = state.plan.lastIntegratedAt; // unset in ledgers written before this line existed
  const open = plan.units.filter((u) => !['integrated', 'dropped'].includes(unitOf(state, u.id).state)).map((u) => u.id);
  const minutes = Math.floor((now - last) / 60000);
  // never while a unit is in its gate or being merged (it may land in minutes), nor for a small plan (one more PR cycle)
  if (typeof last !== 'number' || open.length === 0 || c.gating + c.passed > 0 || c.integrated < Math.max(6, 3 * open.length)
    || minutes < SHIP_AFTER_MIN) return [];
  return [`ship: ${c.integrated} of ${c.integrated + open.length} units integrated, none for ${minutes} min; still open: ${open.join(', ')}. `
    + 'Drop them to the next plan ("orq unit drop <id>") so the final checks run and the pull request ships now'];
}

// continuous: no ship line; every passed head ships on its own, so dropping open units gains nothing
export function timeoutLines(plan, state, report, cap, projectCap, now = Date.now(), continuous = false) {
  const c = countStates(plan, state);
  const limit = report.capBy === 'project' ? `project cap ${projectCap} of this project, machine cap ${cap}` : `machine cap ${cap}`;
  return [
    `timeout: ${c.running} running, ${c.blocked} blocked, ${c.gating} gating, ${c.queued} queued, ${c.passed} passed`,
    ...(report.noSlots ? [`waiting: ${report.slotWaiting.length} ready units wait for a free slot (${limit}, or a provider instance limit)`] : []),
    ...(report.held ? [`waiting: ${report.heldBack} launches or checks wait for this machine: ${report.hold}`] : []),
    ...report.stalled.map((s) => `stalled: ${s.unit} thread ${s.threadId} quiet for ${s.minutes} min`),
    ...(continuous ? [] : shipLine(plan, state, c, now)),
  ];
}

export function staleNote(green, { base, synced, files }) {
  const next = synced ? `orq merged origin/${base} into the integration branch; the merged head ships once it passes the final checks`
    : `it ships once a unit merges origin/${base}${files.length ? ` (conflicts in ${files.join(', ')})` : ''}`;
  return `note: ${green.slice(0, 12)} passed the final checks but origin/${base} moved past it; ${next}`;
}

// Notes go after the summary line and are trimmed first: a decision line is never cut to fit the cap.
// lead: how many lines come before the notes (the summary line, and a `settle:` line when there is one).
export function withNotes(out, notes, max = 7, lead = 1) {
  const room = max - out.length;
  if (notes.length <= room) return [...out.slice(0, lead), ...notes, ...out.slice(lead)];
  const shown = Math.max(0, room - 1);
  return [...out.slice(0, lead), ...notes.slice(0, shown), `note: ${notes.length - shown} more notes omitted`, ...out.slice(lead)];
}

// `orq plan check` lists every unit whose evidence runs a file outside the repository; `orq wait` says it once.
export function evidenceNote(warnings) {
  if (warnings.length === 0) return null;
  const ids = warnings.map((w) => w.slice(0, w.indexOf(':'))); // each warning starts with its unit id
  const more = ids.length > 3 ? ` +${ids.length - 3} more` : '';
  return `note: ${ids.length} units run evidence outside the repository (${ids.slice(0, 3).join(', ')}${more}); run "orq plan check" for the list`;
}
