// orq share repair [--dry-run]: point links pnpm wrote through removed worktrees back into the main checkout's shared
// directories (see share-repair.mjs). Opt-in and one-off: it refuses while a thread or gate of this project runs, and
// holds the machine lock (which every thread and gate reservation takes) from that check to the end, so none starts.
import path from 'node:path';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { loadProjectConfig } from '../config.mjs';
import { pidAlive } from '../gaterun.mjs';
import {
  DEFAULT_LEASE_TTL_MINUTES, listLeases, liveGateLeases, liveLeases,
} from '../leases.mjs';
import { repairShares } from '../share-repair.mjs';
import { gateLeasesDir, leasesDir, projectConfigPath } from '../paths.mjs';
import {
  CliError, parseFlags, refuseWorker, usage, withMachineLock,
} from './common.mjs';

const EXAMPLES = 5;

async function active(ctx, config) {
  const now = (ctx.now ?? Date.now)();
  const ttlMs = (config.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;
  const threads = liveLeases(await listLeases(leasesDir(ctx.env)), now, ttlMs).filter((l) => l.project === ctx.cwd);
  const gates = (await liveGateLeases(gateLeasesDir(ctx.env), { isAlive: ctx.deps.isAlive ?? pidAlive, now }))
    .filter((l) => l.unreadable || l.project === ctx.cwd);
  return { threads: threads.length, gates: gates.length };
}

export async function share(args, ctx) {
  await refuseWorker(ctx);
  const { flags, positional } = parseFlags(args, { bool: ['dry-run'] }, 'share');
  if (positional.length !== 1 || positional[0] !== 'repair') throw usage('share: usage: share repair [--dry-run]');
  const dryRun = flags['dry-run'] === true;
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const paths = config.share ?? [];
  if (paths.length === 0) {
    ctx.stdout.write('nothing to repair: share is not set\n');
    return 0;
  }
  const git = createGit({ exec: ctx.deps.gitExec ?? gitExec });
  const orqDir = path.join(ctx.cwd, '.orq');
  const worktrees = git.listWorktrees(ctx.cwd)
    .filter((w) => w.branch?.startsWith('refs/heads/orq/') || w.path.startsWith(`${orqDir}/`)).map((w) => w.path);
  // ponytail: the machine lock blocks every project's launches for the repair (well under a second measured)
  const r = await withMachineLock(ctx, async () => {
    const busy = await active(ctx, config);
    if (!dryRun && busy.threads + busy.gates > 0) {
      throw new CliError(`share repair: refused: ${busy.threads} threads and ${busy.gates} gates of this project are running; run it when none is`);
    }
    return repairShares({
      cwd: ctx.cwd, paths, worktrees, dryRun, beforeSwap: ctx.deps.beforeSwap,
    });
  });
  const lines = [
    `${dryRun ? 'would repair' : 'repaired'} ${r.repaired.length} links`,
    ...r.repaired.slice(0, EXAMPLES).map((x) => `  ${x.link} -> ${x.to}`),
    ...(r.repaired.length > EXAMPLES ? [`  ... ${r.repaired.length - EXAMPLES} more`] : []),
    ...Object.entries(r.skipped).map(([why, n]) => `skipped ${n}: ${why}`),
    ...r.refused.map((why) => `refused ${why}`),
  ];
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
