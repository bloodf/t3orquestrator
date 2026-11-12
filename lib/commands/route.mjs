import { route as pick } from '../route.mjs';
import { loadMachineConfig } from '../config.mjs';
import { listLeases, runningByInstance, DEFAULT_LEASE_TTL_MINUTES } from '../leases.mjs';
import { authorsOf, readState } from '../ledger.mjs';
import { readJson } from '../store.mjs';
import {
  leasesDir, ledgerPath, machineConfigPath, planPath,
} from '../paths.mjs';
import fs from 'node:fs';
import { parseFlags, playbook, readRegistry, usage } from './common.mjs';

function line(c, n) {
  const extra = `${c.sameFamily ? ' same-family' : ''}${c.belowTier ? ' below-tier' : ''}`;
  return `${n} ${c.instance} ${c.model} tier=${c.tier} family=${c.family} ${c.confirmed ? 'confirmed' : 'unconfirmed'}${extra}`;
}

// For jobs routed on the author: fill missing --author-* from the project ledger, if there is one.
async function authorDefaults(job, rules, ctx, given) {
  if (rules.jobs[job]?.minTier !== 'author' || !fs.existsSync(ledgerPath(ctx.cwd))) return given;
  const state = await readState(ctx.cwd);
  const plan = await readJson(planPath(ctx.cwd), null);
  const authors = authorsOf(plan?.units?.map((u) => u.id) ?? Object.keys(state.units), state);
  if (!authors) return given;
  return { authorTier: given.authorTier ?? authors.maxTier, authorFamily: given.authorFamily ?? authors.family };
}

export async function route(args, ctx) {
  const { flags } = parseFlags(args, { bool: ['json'], value: ['job', 'author-tier', 'author-family'] }, 'route');
  if (!flags.job) throw usage('route: --job is required');
  const authorTier = flags['author-tier'] === undefined ? undefined : Number(flags['author-tier']);
  if (authorTier !== undefined && !Number.isInteger(authorTier)) throw usage('route: --author-tier must be an integer');
  const config = await loadMachineConfig(machineConfigPath(ctx.env));
  const stored = await readRegistry(ctx.env);
  const rules = playbook('routing.json');
  const author = await authorDefaults(flags.job, rules, ctx, { authorTier, authorFamily: flags['author-family'] });
  const result = pick({
    registry: stored,
    defaultLimit: config.perInstanceLimit,
    rules,
    job: flags.job,
    ...author,
    running: runningByInstance(await listLeases(leasesDir(ctx.env)), ctx.now(), DEFAULT_LEASE_TTL_MINUTES * 60_000),
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
