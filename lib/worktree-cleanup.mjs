// The worktrees of an integrated unit's threads are no longer needed: its commits are merged and its branches stay.
// A long plan otherwise keeps every worktree (and each one's own dependency install) until `orq plan archive`.
import { spawn, spawnSync } from 'node:child_process';
import { readLines } from './store.mjs';
import { listLeases } from './leases.mjs';
import { ledgerPath, leasesDir } from './paths.mjs';
import { HARDEN } from './git.mjs';
import { readState } from './ledger.mjs';
import { lastSafeLine } from './gaterun.mjs';

// No --force: git refuses a worktree with modified or untracked files, or a locked one. It decides that with
// `git status`, which follows the repository's config: untracked files must count whatever that config says.
export const removeArgs = (dir) => [...HARDEN, '-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', '--end-of-options', dir];

// Deleting an install can take a while: git runs detached, so it neither holds up the poll nor is cut off half way.
function removeDetached(cwd, dir) {
  spawn('git', removeArgs(dir), { cwd, detached: true, stdio: 'ignore' }).unref();
}

// Waited for, with no time limit: a removal cut off half way would leave a worktree git then refuses to remove.
function removeNow(cwd, dir) {
  const r = spawnSync('git', removeArgs(dir), { cwd, encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, error: lastSafeLine(r.stderr || r.error?.message || `git ended on ${r.signal ?? `exit ${r.status}`}`) };
}

// The worktrees of every launch of `units` in the running plan, except a thread that still holds a lease (one orq
// gave up on may still run there).
async function launchWorktrees(fx, units) {
  const held = new Set((await listLeases(leasesDir(fx.env))).map((l) => l.threadId));
  const launches = (await readLines(ledgerPath(fx.cwd))).filter((e) => e.type === 'launched' && units.has(e.unit) && e.branch && !held.has(e.threadId));
  const branches = new Set(launches.map((e) => `refs/heads/${e.branch}`));
  return fx.git.listWorktrees(fx.cwd).filter((w) => branches.has(w.branch));
}

/**
 * Start removing the worktrees of every launch of `unit` in the running plan. Never --force and never a branch
 * delete: git refuses a worktree with modified or untracked files and it is kept; ignored files go with it. Never
 * under a lock. Best effort: whatever stays is removed by `orq worktree prune` or `orq plan archive`.
 * -> how many removals were started.
 */
export async function removeUnitWorktrees(fx, unit) {
  try {
    const mine = await launchWorktrees(fx, new Set([unit]));
    for (const w of mine) (fx.removeDetached ?? removeDetached)(fx.cwd, w.path);
    return mine.length;
  } catch {
    return 0;
  }
}

/**
 * `orq worktree prune`: the same removal for every integrated unit of the running plan, one worktree at a time and
 * waited for. For units an older orq integrated, and for a removal at integration that did not happen (a lease
 * still held then, a machine that went down). Same limits as above. Never under a lock.
 * -> { paths: found, removed: n, kept: [{ path, error }] }; with dryRun nothing is removed.
 */
export async function pruneIntegrated(fx, { dryRun = false } = {}) {
  const { units } = await readState(fx.cwd);
  const done = new Set(Object.keys(units).filter((id) => units[id].state === 'integrated'));
  const paths = (await launchWorktrees(fx, done)).map((w) => w.path);
  if (dryRun) return { paths, removed: 0, kept: [] };
  const results = paths.map((p) => ({ path: p, ...(fx.removeNow ?? removeNow)(fx.cwd, p) }));
  return { paths, removed: results.filter((r) => r.ok).length, kept: results.filter((r) => !r.ok).map((r) => ({ path: r.path, error: r.error })) };
}
