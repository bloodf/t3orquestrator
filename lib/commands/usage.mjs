// orq usage: the real quota of each account (EasyCLI on this machine, or what a peer published) and the instance it
// maps to (quota.mjs). --refresh asks EasyCLI now instead of within 5 minutes; --json prints the snapshot.
import { loadMachineConfig } from '../config.mjs';
import { machineConfigPath } from '../paths.mjs';
import { currentQuota, quotaTable, refreshQuota } from '../quota.mjs';
import { parseFlags, readRegistry, usage as usageError } from './common.mjs';

export async function usage(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['refresh', 'json'] }, 'usage');
  if (positional.length) throw usageError('usage: usage [--refresh] [--json]');
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const tried = await refreshQuota(ctx, machine, { force: flags.refresh === true });
  const quota = await currentQuota(ctx, machine);
  const now = ctx.now();
  if (flags.json) {
    ctx.stdout.write(`${JSON.stringify(quota)}\n`);
    return 0;
  }
  if (!quota) {
    ctx.stdout.write(`quota: none read (${tried.error ?? 'no fresh snapshot'}); routing uses T3's usage readings and refusals\n`);
    return 0;
  }
  const age = Math.max(0, Math.round((now - quota.at) / 60_000));
  const lines = quotaTable(quota, await readRegistry(ctx.env), machine.quotaSource?.accounts, now);
  ctx.stdout.write(`${[`quota: from ${quota.from}, ${age} min old`, ...lines].join('\n')}\n`);
  return 0;
}
