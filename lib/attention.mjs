// What waits on the orchestrator without reaching it. Its own thread's queue: a message sent to a thread that never
// ends its turn stays queued for hours. A pending request in a thread of this project (a worker, a review, a
// decision): nobody else answers it. A machine held for long while a peer has room. `orq wait` returns each as its
// first line, once, and again after a while if it still stands; what was told is kept in .orq/attention.json.
import { ownThreadId } from './t3.mjs';
import { unitOf } from './ledger.mjs';
import { listLeases } from './leases.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { attentionPath, leasesDir } from './paths.mjs';
import { pickPeer, readPeers } from './peers.mjs';
import { holdText } from './admission.mjs';

const CHECK_EVERY_MS = 60_000; // the own thread and each side thread cost one `t3 thread show`
export const PENDING_REPEAT_MS = 10 * 60_000;
export const BALANCE_AFTER_MS = 10 * 60_000; // held this long before a peer is named
export const BALANCE_REPEAT_MS = 30 * 60_000;
const KEEP_MS = 24 * 3600_000;

// Runs queued behind the running one. T3 shows no queue through its CLI; `runCount` counts queued runs too, and the
// active run's id ends in its ordinal (docs/t3-surface.md).
export function queuedRuns(thread) {
  const active = /:ordinal:(\d+)$/.exec(thread?.activeRunId ?? '');
  return active && Number.isInteger(thread.runCount) ? Math.max(0, thread.runCount - Number(active[1])) : 0;
}

const readMarks = (cwd) => readJson(attentionPath(cwd), {}).then((m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : {}), () => ({}));
const writeMarks = (cwd, marks, now) => writeJsonAtomic(attentionPath(cwd), Object.fromEntries(Object.entries(marks).filter(([, m]) => now - (m?.at ?? 0) < KEEP_MS)));

function due(run, key, now) {
  if (run[key] !== undefined && now - run[key] < CHECK_EVERY_MS && now >= run[key]) return false;
  Object.assign(run, { [key]: now });
  return true;
}

// The orchestrator's own thread has messages queued: told once per new message. null when there is nothing to tell.
export async function ownQueue(ctx, run) {
  const own = ownThreadId(ctx.env);
  if (!own || !due(run, 'ownCheckedAt', ctx.now())) return null;
  let thread;
  try {
    ({ thread } = run.fx.t3.showThread(own));
  } catch {
    return null; // not a thread T3 knows, or T3 is busy: looked at again in a minute
  }
  const n = queuedRuns(thread);
  const marks = await readMarks(ctx.cwd);
  const key = `queue:${own}`;
  if (n === 0 || (marks[key]?.runCount ?? 0) >= thread.runCount) return null;
  await writeMarks(ctx.cwd, { ...marks, [key]: { at: ctx.now(), runCount: thread.runCount } }, ctx.now());
  return [`queued: ${n} message${n === 1 ? ' waits' : 's wait'} in your own thread's queue and will not be delivered while your turn lasts: read ${n === 1 ? 'it' : 'them'} now with t3_queue (action "list", then "read"), act on ${n === 1 ? 'it' : 'each'}, then cancel ${n === 1 ? 'it' : 'them'} (action "cancel")`];
}

// Threads of this project that orq started and that are not a unit's current thread: reviews and decisions.
async function sideThreads(ctx, run, state) {
  if (!due(run, 'sideCheckedAt', ctx.now())) return run.sidePending ?? [];
  const units = new Set(run.plan.units.map((u) => unitOf(state, u.id).threadId).filter(Boolean));
  const mine = (await listLeases(leasesDir(ctx.env))).filter((l) => l.project === ctx.cwd && !l.reservation && !l.abandoned && !units.has(l.threadId));
  const pending = [];
  for (const l of mine) {
    const before = (run.sidePending ?? []).find((w) => w.threadId === l.threadId);
    try {
      if (run.fx.t3.showThread(l.threadId).thread.pending > 0) pending.push({ threadId: l.threadId, what: String(l.unit).replace('ask-', 'decision ').replace('review-', 'review ') });
    } catch {
      if (before) pending.push(before); // T3 is busy: what was seen stands until it can be read again
    }
  }
  Object.assign(run, { sidePending: pending });
  return pending;
}

const ANSWER = 'answer it (t3_pending_request, action "respond") or interrupt the thread (t3_thread_interrupt) so orq replaces it';

// Every thread of this project that waits on a request: told when first seen and every PENDING_REPEAT_MS after.
async function pendingLines(ctx, run, state, marks) {
  const now = ctx.now();
  const blocked = run.plan.units.filter((u) => unitOf(state, u.id).state === 'blocked').map((u) => ({ threadId: unitOf(state, u.id).threadId, what: `unit ${u.id}` }));
  const waiting = [...blocked, ...await sideThreads(ctx, run, state)];
  const keys = new Set(waiting.map((w) => `pending:${w.threadId}`));
  const kept = Object.fromEntries(Object.entries(marks).filter(([k]) => !k.startsWith('pending:') || keys.has(k))); // answered: forgotten
  const tell = waiting.filter((w) => now - (kept[`pending:${w.threadId}`]?.at ?? -Infinity) >= PENDING_REPEAT_MS);
  for (const w of tell) kept[`pending:${w.threadId}`] = { at: now, first: kept[`pending:${w.threadId}`]?.first ?? now };
  const lines = tell.map((w) => {
    const waited = Math.floor((now - kept[`pending:${w.threadId}`].first) / 60_000);
    return `pending: ${w.what}: thread ${w.threadId} waits on a request${waited > 0 ? ` (for ${waited} min)` : ''}: ${ANSWER}`;
  });
  return { lines, marks: kept };
}

// Held for long with work waiting, and a peer has room: name it, at most every BALANCE_REPEAT_MS.
async function balanceLines(ctx, run, report, marks) {
  const now = ctx.now();
  const a = run.admission;
  const list = run.machine?.peers;
  if (!a?.held || !report.held || now - a.since < BALANCE_AFTER_MS || !list?.length) return { lines: [], marks };
  if (now - (marks.balance?.at ?? -Infinity) < BALANCE_REPEAT_MS) return { lines: [], marks };
  const peer = pickPeer(await readPeers(ctx, list), now);
  if (!peer) return { lines: [], marks };
  const s = peer.status;
  return {
    marks: { ...marks, balance: { at: now, host: peer.host } },
    lines: [`balance: this machine has started nothing new for ${Math.floor((now - a.since) / 60_000)} min (${holdText({ ...a, since: null }, now)}); ${report.heldBack} launches or checks wait. `
      + `Peer ${peer.host} has ${s.free} free slot${s.free === 1 ? '' : 's'} at load ${s.load.toFixed(1)} per core: hand it work that has not started here`],
  };
}

// After a poll: the lines `orq wait` returns now (`pending:` before `balance:`), or null.
export async function attention(ctx, run, state, report) {
  const before = await readMarks(ctx.cwd);
  const pending = await pendingLines(ctx, run, state, before);
  const balance = pending.lines.length ? { lines: [], marks: pending.marks } : await balanceLines(ctx, run, report, pending.marks);
  if (JSON.stringify(balance.marks) !== JSON.stringify(before)) await writeMarks(ctx.cwd, balance.marks, ctx.now());
  const lines = [...pending.lines, ...balance.lines];
  return lines.length ? lines : null;
}
