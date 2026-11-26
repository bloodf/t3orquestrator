// orq maint: the machine maintenance shipped with the kit (maint.mjs, maint/*.sh).
//   maint install [--dry-run]: install or update the cron (Linux) or launchd (macOS) entries for tmp-churn (hourly)
//     and disk-clean (every 6 hours), at minutes staggered per machine. Idempotent; never RunAtLoad.
//   maint keep [<project>...]: the paths disk-clean must keep, one per line (leased projects, worktrees of leased and
//     working T3 threads). Exit 1 on any doubt: disk-clean and tmp-churn then delete nothing.
import { install, keepPaths } from '../maint.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

export async function maint(args, ctx) {
  const [sub, ...rest] = args;
  if (sub === 'install') {
    const { flags, positional } = parseFlags(rest, { bool: ['dry-run'] }, 'maint install');
    if (positional.length) throw usage('maint install: usage: maint install [--dry-run]');
    const lines = install({
      env: { ...process.env, ...ctx.env }, exec: ctx.deps.exec, dryRun: Boolean(flags['dry-run']), ...(ctx.deps.maint ?? {}),
    });
    ctx.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (sub === 'keep') {
    const { positional } = parseFlags(rest, {}, 'maint keep');
    let paths;
    try {
      paths = await keepPaths(ctx, positional);
    } catch (e) {
      throw new CliError(`maint keep: ${e.message}`, 1);
    }
    if (paths.length) ctx.stdout.write(`${paths.join('\n')}\n`);
    return 0;
  }
  throw usage('maint: usage: maint install [--dry-run] | maint keep [<project>...]');
}
