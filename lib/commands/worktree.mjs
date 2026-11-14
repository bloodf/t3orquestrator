// orq worktree prune [--dry-run]: remove the worktrees that integrated units of the running plan left behind.
// It takes no lock: it reads the ledger, then runs git.
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { pruneIntegrated } from '../worktree-cleanup.mjs';
import { parseFlags, refuseWorker, usage } from './common.mjs';

export async function worktree(args, ctx) {
  await refuseWorker(ctx);
  const { flags, positional } = parseFlags(args, { bool: ['dry-run'] }, 'worktree');
  if (positional.length !== 1 || positional[0] !== 'prune') throw usage('worktree: usage: worktree prune [--dry-run]');
  const dryRun = flags['dry-run'] === true;
  const fx = { cwd: ctx.cwd, env: ctx.env, git: createGit({ exec: ctx.deps.gitExec ?? gitExec }) };
  const { paths, removed, kept } = await pruneIntegrated(fx, { dryRun });
  const lines = dryRun ? paths.map((p) => `would remove ${p}`) : [
    ...(removed ? [`removed ${removed} worktrees of integrated units`] : []),
    ...kept.map((k) => `note: kept worktree ${k.path}: ${k.error}`),
  ];
  ctx.stdout.write(`${lines.length ? lines.join('\n') : 'nothing to prune'}\n`);
  return 0;
}
