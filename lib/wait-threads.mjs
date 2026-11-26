// What `orq wait` learns about running threads from T3. Runs t3 outside every lock.
import { needsShow } from './t3.mjs';
import { unitOf } from './ledger.mjs';
import { parseWorkerStatus } from './worker-status.mjs';
import { classifyFailure } from './limits.mjs';

const STOPPED = ['failed', 'cancelled', 'interrupted'];

// Threads of running/blocked units, with `pending` known. A thread that ended, or completed with a reply that is a
// provider's limit error, carries `limit` (limits.mjs): why its provider stopped it. Runs t3 outside every lock.
export function observeThreads(fx, plan, state, rows) {
  const wanted = plan.units.map((u) => unitOf(state, u.id)).filter((u) => u.state === 'running' || u.state === 'blocked');
  const listed = new Map(rows.map((t) => [t.id, t]));
  const out = {};
  for (const u of wanted) {
    const t = listed.get(u.threadId);
    if (!t) continue;
    const fresh = t.status === 'completed' && (u.since === null || t.updatedAt > u.since);
    if (fresh || STOPPED.includes(t.status)) out[u.threadId] = { ...t, ...readReply(fx, t, fresh, u.runStartedAt ?? null) };
    else out[u.threadId] = needsShow(t) ? fx.t3.showThread(u.threadId).thread : t;
  }
  return out;
}

// The thread's last message, when it is a reply: a just-completed worker's status line (report), and a provider's
// limit error (limit). Unreadable means unknown: the unit is gated, or counted as a provider failure, as usual.
// fx.threadError (optional): the error T3 logged for a thread id, or null.
// runStart: when the run that stopped began, taken before the thread was started or sent to; a logged error from before it belongs
// to a run the thread recovered from, so only the reply counts then.
function readReply(fx, thread, completed, runStart) {
  let last;
  try {
    last = fx.t3.showThread(thread.id, { messages: 1 }).messages.at(-1);
  } catch {
    return completed ? { report: null } : {}; // the gate still judges the work; a missing reply must not block it
  }
  const text = last?.role === 'assistant' ? last.text : null;
  // a thread that stopped: the provider's own error, where T3 logged one (t3-log.mjs; Codex's usage limit), comes
  // before the worker's last words, which are often narration from before the refusal. A completed turn is read from
  // its reply alone: the log keeps errors of earlier turns the thread recovered from
  const logged = completed || runStart === null ? null : fx.threadError?.(thread.id, runStart) ?? null;
  // a relative reset counts from when the provider wrote it; a completed turn needs an explicit provider phrasing
  const read = (said) => classifyFailure(said, thread.updatedAt, { now: fx.now(), strict: completed });
  const limit = read(logged) ?? read(text);
  return {
    ...(completed ? { report: text === null ? null : parseWorkerStatus(text) } : {}), ...(limit ? { limit } : {}),
  };
}
