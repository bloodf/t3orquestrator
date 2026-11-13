// Continuation after a provider failure: the next worker starts where the failed one stopped, not from zero.
// Only provider failures hand work on; the quality ladder starts fresh (bad work must not be inherited).
import fs from 'node:fs';

const short = (sha) => sha.slice(0, 12);

/**
 * The hand-over block that precedes the work order (pure). commits: commits the failed worker left on top of
 * the base; oldPath: its worktree, when T3 reported one that exists (and, with no commits, has changes).
 */
export function handOver({
  commits, base, head, failedKey, oldPath, status,
}) {
  const lines = ['## Hand-over'];
  // `stalled`: orq gave up a thread T3 still showed as running; anything else: its provider ended it
  const stopped = status === 'stalled' ? 'stopped responding and was given up' : 'stopped because its provider failed';
  if (commits > 0) {
    lines.push(
      `A previous worker (${failedKey}) ${stopped}. Its committed work (${commits} commits, ${short(base)}..${short(head)}) is already in this branch.`,
      `Read it first with \`git log ${short(base)}..HEAD\` and \`git diff ${short(base)}..HEAD\`: keep what is right, fix what is not, then finish the work order below.`,
      'Do not start over.',
    );
  } else {
    lines.push(`A previous worker (${failedKey}) ${stopped} and committed nothing; this branch starts fresh.`);
  }
  if (oldPath) lines.push(`Uncommitted files it left may still be in ${oldPath}: you may read them, never rely on them.`);
  return lines.join('\n');
}

// T3's worktree of the failed thread, if it reports one that still exists. Best effort: no path is fine.
function oldWorktree(fx, threadId) {
  if (!threadId) return null;
  try {
    const p = fx.t3.showThread(threadId, { messages: 0 }).thread.worktreePath;
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

const dirty = (fx, dir) => {
  try {
    return !fx.git.isClean(dir).clean;
  } catch {
    return false;
  }
};

/**
 * What the unit's failed launch left (runs git and t3: never under a lock), or null when its last launch did not
 * end in a provider failure on this attempt. head: the failed branch's head, or what that launch itself continued
 * from when its branch was never created (a failed start).
 */
export function continuation(fx, u, attempt) {
  const f = u.failedLaunch;
  if (!f || f.attempt !== attempt) return null;
  let head = f.continues;
  try {
    head = fx.git.resolveSha(fx.cwd, `refs/heads/${f.branch}`);
  } catch {
    // the branch was never created: keep what that launch continued from, if anything
  }
  let commits = 0;
  try {
    commits = head ? fx.git.commitsAhead(fx.cwd, f.baseSha, head) : 0;
  } catch {
    commits = 0; // unreadable history: start fresh rather than fail the launch
  }
  const path = oldWorktree(fx, f.threadId);
  return {
    commits, base: f.baseSha, head, failedKey: f.key, status: f.status, oldPath: path && (commits > 0 || dirty(fx, path)) ? path : null,
  };
}
