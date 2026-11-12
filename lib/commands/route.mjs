import { route as pick } from '../route.mjs';
import { loadMachineConfig } from '../config.mjs';
import { listLeases, runningByInstance } from '../leases.mjs';
import { leasesDir, machineConfigPath } from '../paths.mjs';
import { parseFlags, playbook, readRegistry, usage } from './common.mjs';

function line(c, n) {
  const extra = `${c.sameFamily ? ' same-family' : ''}${c.belowTier ? ' below-tier' : ''}`;
  return `${n} ${c.instance} ${c.model} tier=${c.tier} family=${c.family} ${c.confirmed ? 'confirmed' : 'unconfirmed'}${extra}`;
}

export async function route(args, ctx) {
  const { flags } = parseFlags(args, { bool: ['json'], value: ['job', 'author-tier', 'author-family'] }, 'route');
  if (!flags.job) throw usage('route: --job is required');
  const authorTier = flags['author-tier'] === undefined ? undefined : Number(flags['author-tier']);
  if (authorTier !== undefined && !Number.isInteger(authorTier)) throw usage('route: --author-tier must be an integer');
  const config = await loadMachineConfig(machineConfigPath(ctx.env));
  const stored = await readRegistry(ctx.env);
  const result = pick({
    registry: stored,
    defaultLimit: config.perInstanceLimit,
    rules: playbook('routing.json'),
    job: flags.job,
    authorTier,
    authorFamily: flags['author-family'],
    running: runningByInstance(await listLeases(leasesDir(ctx.env))),
    now: ctx.now(),
  });
  if (flags.json) ctx.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.candidates.length) ctx.stdout.write(`${result.candidates.map((c, i) => line(c, i + 1)).join('\n')}\n`);
  else {
    const retry = result.retryAt === null ? '-' : new Date(result.retryAt).toISOString();
    ctx.stdout.write(`none blocked=${result.blocked} retry_at=${retry} reason="${result.reason}"\n`);
  }
  return result.candidates.length ? 0 : 4;
}
