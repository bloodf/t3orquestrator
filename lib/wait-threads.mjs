// What `orq wait` learns about running threads from T3. Runs t3 outside every lock.
import { needsShow } from './t3.mjs';
import { unitOf } from './ledger.mjs';
import { parseWorkerStatus } from './worker-status.mjs';

// Threads of running/blocked units, with `pending` known. Runs t3 outside every lock.
export function observeThreads(fx, plan, state, rows) {
  const wanted = plan.units.map((u) => unitOf(state, u.id)).filter((u) => u.state === 'running' || u.state === 'blocked');
  const listed = new Map(rows.map((t) => [t.id, t]));
  const out = {};
  for (const u of wanted) {
    const t = listed.get(u.threadId);
    if (!t) continue;
    const fresh = t.status === 'completed' && (u.since === null || t.updatedAt > u.since);
    if (fresh) out[u.threadId] = { ...t, report: readReport(fx, u.threadId) };
    else out[u.threadId] = needsShow(t) ? fx.t3.showThread(u.threadId).thread : t;
  }
  return out;
}

// The status line of a just-completed worker's last reply. Unreadable means unknown: the unit is gated as usual.
function readReport(fx, threadId) {
  try {
    const { messages } = fx.t3.showThread(threadId, { messages: 1 });
    const last = messages.filter((m) => m?.role === 'assistant').at(-1);
    return last ? parseWorkerStatus(last.text) : null;
  } catch {
    return null; // the gate still judges the work; a missing reply must not block it
  }
}
