// When and how the cleanup of cleanup.mjs runs: the sweep inside `orq wait`, T3's view of the threads it needs, and the
// lines `orq worktree prune --force` and `orq plan archive` print.
import { createT3 } from './t3.mjs';
import { loadProjectConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { lastSafeLine } from './gaterun.mjs';
import { formatBytes } from './salvage.mjs';
import { cleanAll, ENDED } from './cleanup.mjs';
import { cleanupPath, projectConfigPath } from './paths.mjs';

export const SWEEP_MINUTES = 10;

// T3's rows for this project's threads, so a dropped unit's worktree goes once its thread stopped; null when unknown.
export async function t3Threads(ctx) {
  try {
    const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
    return config.t3 ? createT3({ bin: config.t3.bin, exec: ctx.deps.exec }).listThreads({ project: ctx.cwd }) : null;
  } catch {
    return null;
  }
}

export function cleanupLines(r) {
  if (r.busy) return ['note: another cleanup is running; it removes what is left'];
  const [n, g] = [r.removed.length, r.gates.length];
  const skipped = (w) => (w.skipped ? ` (${w.skipped} new files over 256 KiB not saved, named in it)` : '');
  return [
    ...(n || g ? [`removed ${n} worker worktrees${g ? ` and ${g} gate checkouts` : ''}, freed ${formatBytes(r.freed)}`] : []),
    ...r.removed.filter((w) => w.patch).map((w) => `saved uncommitted work of ${w.branch} to ${w.patch}${skipped(w)}`),
    ...r.kept.map((k) => `note: kept worktree ${k.path}: ${k.why}`),
  ];
}

// From `orq wait`: a cleanup in the poll where a unit ended or a head shipped, and otherwise at most every SWEEP_MINUTES.
// ponytail: removals run inside the poll; a long backlog delays that one poll. Detach if it ever bites.
export async function sweepIfDue(fx, state, threads = null) {
  const ended = Object.values(state.units).filter((u) => ENDED.includes(u.state)).length + (state.plan.ships ?? 0);
  const last = await readJson(cleanupPath(fx.cwd), null);
  if (last?.ended === ended && fx.now() - last.at < SWEEP_MINUTES * 60_000) return null;
  await writeJsonAtomic(cleanupPath(fx.cwd), { at: fx.now(), ended });
  return cleanAll(fx, { threads, measure: false }); // sizes are only printed by prune --force and archive
}

// Never fails a poll. What a sweep saved, and what it keeps for want of a safe patch, are one note each.
export async function sweepNotes(fx, state, threads) {
  try {
    const r = await sweepIfDue(fx, state, threads);
    const saved = r?.removed?.filter((w) => w.patch).length;
    const kept = r?.kept?.length;
    return [
      ...(saved ? [`note: cleanup saved the uncommitted work of ${saved} removed worktrees under .orq/salvage/`] : []),
      ...(kept ? [`note: cleanup kept ${kept} finished worktrees it could not empty safely; run "orq worktree prune --force" to see why`] : []),
    ];
  } catch (e) {
    return [`note: worktree cleanup failed: ${lastSafeLine(e.message)}`];
  }
}
