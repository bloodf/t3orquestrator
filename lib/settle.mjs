// Which threads orq started are done for good and still unsettled in T3. T3 has no CLI to settle a thread
// (only the orchestrator's `t3_thread_organize` tool can), so orq names them and the orchestrator settles them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { reduce, unitOf } from './ledger.mjs';
import { readJson, readLines } from './store.mjs';
import { ACTIVE } from './t3.mjs';

const MAX_IDS = 20;
const ENDED_UNIT = ['integrated', 'dropped']; // nothing will be sent to their threads again

// Every thread a unit ever had, in launch order (feedback reuses a thread: listed once).
function unitThreads(events) {
  const out = new Map();
  for (const e of events) {
    if (e.type !== 'launched' || !e.threadId) continue;
    const ids = out.get(e.unit) ?? [];
    if (!ids.includes(e.threadId)) out.set(e.unit, [...ids, e.threadId]);
  }
  return out;
}

/**
 * Pure. events: the plan's ledger; reviews/asks: their files; threads: T3's rows by id ({status, settled}).
 * Listed: a thread T3 reports `settled === false` and not active, that is any thread (the last one, and earlier,
 * replaced ones) of an integrated or dropped unit, or the thread of a review or decision no longer running.
 * Never the current thread of an open or failed unit: feedback, a retry or the orchestrator may still need it.
 */
export function settleList({
  events, reviews, asks, threads,
}) {
  const done = (id) => threads[id]?.settled === false && !ACTIVE.includes(threads[id].status);
  const state = reduce(events);
  const out = [];
  for (const [unit, ids] of unitThreads(events)) {
    const { state: s } = unitOf(state, unit);
    // until the unit is integrated or dropped, its worker may still read a replaced thread's worktree (hand-over)
    if (!ENDED_UNIT.includes(s)) continue;
    ids.forEach((id, i) => {
      const current = i === ids.length - 1;
      if (done(id)) out.push({ threadId: id, what: `unit ${unit} ${current ? s : 'replaced'}` });
    });
  }
  const finished = (list, label) => (Array.isArray(list) ? list : [])
    .filter((r) => r?.threadId && r.status !== 'running' && r.status !== 'starting' && done(r.threadId))
    .map((r) => ({ threadId: r.threadId, what: `${label} ${r.n}` }));
  return [...out, ...finished(reviews?.reviews, 'review'), ...finished(asks?.asks, 'decision')];
}

export function settleLine(list) {
  if (list.length === 0) return null;
  const more = list.length > MAX_IDS ? ` +${list.length - MAX_IDS} more` : '';
  return `settle: ${list.slice(0, MAX_IDS).map((x) => x.threadId).join(' ')}${more}`;
}

// A plan's state as files: the live .orq/ or an archived .orq/archive/<name>/ (same layout).
export async function readPlanFiles(dir) {
  return {
    events: await readLines(path.join(dir, 'ledger.jsonl')),
    reviews: await readJson(path.join(dir, 'reviews.json'), { reviews: [] }),
    asks: await readJson(path.join(dir, 'asks.json'), { asks: [] }),
  };
}

export async function archivedDirs(root) {
  try {
    return (await fs.readdir(root)).filter((n) => !n.startsWith('.')).sort().map((n) => path.join(root, n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export const byId = (rows) => Object.fromEntries(rows.map((t) => [t.id, t]));
