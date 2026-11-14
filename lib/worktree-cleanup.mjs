// The worktrees of an integrated unit's threads are no longer needed: its commits are merged and its branches stay.
// A long plan otherwise keeps every worktree (and each one's own dependency install) until `orq plan archive`.
import { spawn } from 'node:child_process';
import { readLines } from './store.mjs';
import { listLeases } from './leases.mjs';
import { ledgerPath, leasesDir } from './paths.mjs';
import { HARDEN } from './git.mjs';

// Deleting an install can take a while: git runs detached, so it neither holds up the poll nor is cut off half way.
function removeDetached(cwd, dir) {
  spawn('git', [...HARDEN, 'worktree', 'remove', '--end-of-options', dir], { cwd, detached: true, stdio: 'ignore' }).unref();
}

/**
 * Start removing the worktrees of every launch of `unit` in the running plan, except a thread that still holds a
 * lease (one orq gave up on may still run there). Never --force and never a branch delete: git refuses a worktree
 * with modified or untracked files and it is kept; ignored files go with it. Never under a lock. Best effort:
 * whatever stays is removed by `orq plan archive`. -> how many removals were started.
 */
export async function removeUnitWorktrees(fx, unit) {
  try {
    const held = new Set((await listLeases(leasesDir(fx.env))).map((l) => l.threadId));
    const launches = (await readLines(ledgerPath(fx.cwd))).filter((e) => e.type === 'launched' && e.unit === unit && e.branch && !held.has(e.threadId));
    const branches = new Set(launches.map((e) => `refs/heads/${e.branch}`));
    const mine = fx.git.listWorktrees(fx.cwd).filter((w) => branches.has(w.branch));
    for (const w of mine) (fx.removeDetached ?? removeDetached)(fx.cwd, w.path);
    return mine.length;
  } catch {
    return 0;
  }
}
