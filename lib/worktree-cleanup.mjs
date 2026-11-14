// The worktrees of an integrated unit's threads are no longer needed: its commits are merged and its branches stay.
// A long plan otherwise keeps every worktree (and each one's own dependency install) until `orq plan archive`.
import { readLines } from './store.mjs';
import { ledgerPath } from './paths.mjs';

/**
 * Remove the worktrees of every launch of `unit` in the running plan. Never --force and never a branch delete: git
 * refuses a worktree with modified or untracked files and it is kept. Runs git: never under a lock. Best effort:
 * whatever stays is removed by `orq plan archive`. -> how many were removed.
 */
export async function removeUnitWorktrees(fx, unit) {
  try {
    const events = await readLines(ledgerPath(fx.cwd));
    const branches = new Set(events.filter((e) => e.type === 'launched' && e.unit === unit && e.branch).map((e) => `refs/heads/${e.branch}`));
    return fx.git.listWorktrees(fx.cwd).filter((w) => branches.has(w.branch))
      .filter((w) => fx.git.tryRemoveWorktree(fx.cwd, w.path).ok).length;
  } catch {
    return 0;
  }
}
