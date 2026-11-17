// orq worktree prune [--force] [--dry-run]: remove the worktrees that finished work left behind.
// It takes no project lock: it reads the ledger, then runs git. --force: the cleanup `orq wait` runs, on everything.
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { pruneIntegrated } from '../worktree-cleanup.mjs';
import { cleanAll } from '../cleanup.mjs';
import { cleanupLines, t3Threads } from '../sweep.mjs';
import { assertNotArchiving } from '../ledger.mjs';
import { parseFlags, refuseWorker, usage } from './common.mjs';

// Without T3's view of the threads, nothing is forced: a plain `git worktree remove` keeps any dirty worktree.
async function forced(fx, ctx, dryRun) {
  const threads = await t3Threads(ctx);
  const r = await cleanAll(fx, { threads, force: threads !== null, dryRun });
  if (!dryRun || r.busy) return cleanupLines(r);
  return [...[...r.removed, ...r.gates].map((w) => `would remove ${w.path}`), ...r.kept.map((k) => `would keep ${k.path}: ${k.why}`), ...r.notes];
}

export async function worktree(args, ctx) {
  await refuseWorker(ctx);
  const { flags, positional } = parseFlags(args, { bool: ['dry-run', 'force'] }, 'worktree');
  if (positional.length !== 1 || positional[0] !== 'prune') throw usage('worktree: usage: worktree prune [--force] [--dry-run]');
  await assertNotArchiving(ctx.cwd);
  const dryRun = flags['dry-run'] === true;
  const fx = {
    cwd: ctx.cwd, env: ctx.env, now: ctx.now ?? Date.now, git: createGit({ exec: ctx.deps.gitExec ?? gitExec }),
  };
  if (flags.force) {
    const lines = await forced(fx, ctx, dryRun);
    ctx.stdout.write(`${lines.length ? lines.join('\n') : 'nothing to clean'}\n`);
    return 0;
  }
  const { paths, removed, kept } = await pruneIntegrated(fx, { dryRun });
  const lines = dryRun ? paths.map((p) => `would remove ${p}`) : [
    ...(removed ? [`removed ${removed} worktrees of integrated units`] : []),
    ...kept.map((k) => `note: kept worktree ${k.path}: ${k.error}`),
  ];
  ctx.stdout.write(`${lines.length ? lines.join('\n') : 'nothing to prune'}\n`);
  return 0;
}
