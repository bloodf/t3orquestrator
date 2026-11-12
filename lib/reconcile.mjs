// Start-of-poll reconciliation of this project's leases with the ledger: adopt launches a crash left
// unrecorded, keep live leases' heartbeats fresh, and reap leases nothing references any more.
import { commit, unitOf } from './ledger.mjs';
import { listLeases, removeLease, writeLease } from './leases.mjs';
import { readJson } from './store.mjs';
import { leasesDir, reviewsPath } from './paths.mjs';
import { withMachine } from './launch.mjs';

const RESERVATION_TTL_MS = 2 * 60_000;
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];

const launchedFromLease = (l, at) => ({
  type: 'launched', unit: l.unit, at, attempt: l.attempt, launch: l.launch, threadId: l.threadId, key: l.key,
  instance: l.instance, model: l.model, branch: l.branch, baseSha: l.baseSha, tier: l.tier, family: l.family ?? null,
});

// listed: the project's threads from `t3 thread list`. Returns the ids of the units adopted.
export async function adoptLaunches(fx, listed) {
  const alive = new Set(listed.map((t) => t.id));
  const candidates = (await listLeases(leasesDir(fx.env)))
    .filter((l) => l.project === fx.cwd && !l.reservation && Number.isInteger(l.launch) && alive.has(l.threadId));
  if (candidates.length === 0) return [];
  const { events } = await commit(fx.cwd, (state) => {
    const taken = new Set();
    return candidates.filter((l) => {
      const u = unitOf(state, l.unit);
      const ok = !taken.has(l.unit) && u.state === 'queued' && Math.max(1, u.attempt) === l.attempt && u.launches + 1 === l.launch;
      if (ok) taken.add(l.unit);
      return ok;
    }).map((l) => launchedFromLease(l, fx.now()));
  });
  return events.map((e) => e.unit);
}

// Is this lease's thread still doing work for a running or blocked unit?
function referenced(lease, units, threads) {
  const u = units.find((x) => (x.state === 'running' || x.state === 'blocked') && x.threadId === lease.threadId);
  const t = threads[lease.threadId];
  if (!u || !t) return false;
  const feedbackPending = t.status === 'completed' && u.since !== null && t.updatedAt <= u.since;
  return feedbackPending || !TERMINAL.includes(t.status);
}

// Review threads (`orq review`) hold leases named review-<n> while .orq/reviews.json lists them as running.
async function runningReviews(cwd) {
  const doc = await readJson(reviewsPath(cwd), { reviews: [] });
  const reviews = Array.isArray(doc?.reviews) ? doc.reviews : [];
  return new Set(reviews.filter((r) => r?.status === 'running').map((r) => `review-${r.n}`));
}

function keep(l, { now, units, threads, reviews }) {
  if (l.reservation) return now - l.startedAt <= RESERVATION_TTL_MS;
  if (l.kind === 'review') { // `review show` records the outcome; a finished review must not hold a slot
    const t = threads[l.threadId];
    // a review started after this poll listed threads is not listed yet: same grace as a reservation
    if (t === undefined) return reviews.has(l.unit) && now - l.startedAt <= RESERVATION_TTL_MS;
    return reviews.has(l.unit) && !TERMINAL.includes(t.status);
  }
  return referenced(l, units, threads);
}

// One machine-locked pass over this project's leases. threads: every listed thread by id (absent = gone).
export async function tendLeases(fx, state, threads) {
  const ctx = {
    now: fx.now(), units: Object.values(state.units), threads, reviews: await runningReviews(fx.cwd),
  };
  return withMachine(fx, async () => {
    const dir = leasesDir(fx.env);
    const out = { refreshed: [], removed: [], notes: [] };
    for (const l of (await listLeases(dir)).filter((x) => x.project === fx.cwd)) {
      if (keep(l, ctx)) {
        if (!l.reservation) {
          await writeLease(dir, { ...l, heartbeatAt: ctx.now });
          out.refreshed.push(l.threadId);
        }
        continue;
      }
      await removeLease(dir, l.threadId);
      out.removed.push(l.threadId);
      const t = threads[l.threadId];
      if (t && !TERMINAL.includes(t.status)) out.notes.push(`note: unit ${l.unit} is no longer running; thread ${l.threadId} left running — interrupt it`);
    }
    return out;
  });
}
