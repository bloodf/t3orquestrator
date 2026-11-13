import {
  assertNotArchiving, readState, unitOf, authorsOf,
} from '../ledger.mjs';
import { listLeases, liveLeases, DEFAULT_LEASE_TTL_MINUTES } from '../leases.mjs';
import { loadMachineConfig, loadProjectConfig } from '../config.mjs';
import { overrideNote, resolveCap } from '../probe.mjs';
import { readJson } from '../store.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath,
} from '../paths.mjs';
import { CliError, parseFlags, readRegistry } from './common.mjs';
import { countStates } from './wait-report.mjs';
import { listArchives } from '../archive.mjs';
import { readAsks } from '../ask.mjs';

const NOTE = 'note: cap covers threads orq started; threads started by hand are not counted';
const short = (sha) => (sha ? sha.slice(0, 12) : 'none');

function unitLine(u) {
  const parts = [u.id, u.state];
  if (u.attempt > 0) parts.push(`attempt=${u.attempt}`);
  if (u.key) parts.push(`model=${u.key}`);
  if (u.tier !== null) parts.push(`tier=${u.tier}`);
  if (u.wantedTier) parts.push(`wanted_tier=${u.wantedTier}`);
  if (u.continues) parts.push('continued'); // its worker took over the commits of one whose provider failed // launched below its tier: no model at it was usable
  if (u.threadId) parts.push(`thread=${u.threadId}`);
  if (u.flagKinds.length) parts.push(`flags=${u.flagKinds.join(',')}`);
  if (u.state === 'failed' && u.reason) parts.push(u.reason);
  return parts.join(' ');
}

async function slots(ctx) {
  const leases = await listLeases(leasesDir(ctx.env));
  const ttl = ((await loadProjectConfig(projectConfigPath(ctx.cwd))).leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;
  const live = liveLeases(leases, ctx.now(), ttl).length;
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const facts = ctx.deps.readMachine();
  const config = machine.cap ? { cap: machine.cap } : {};
  const { cap } = resolveCap({ machine: facts, config });
  // threads orq gave up on that still hold a slot until T3 shows them ended (or their lease TTL runs out)
  const abandoned = liveLeases(leases, ctx.now(), ttl).filter((l) => l.abandoned && l.project === ctx.cwd)
    .map((l) => `abandoned: thread ${l.threadId} of unit ${l.unit} holds a slot until it ends`);
  return {
    cap, live, expired: leases.length - live, note: overrideNote({ machine: facts, config }), abandoned,
  };
}

const capLine = ({ cap, live, expired }, c) => `cap=${cap} active=${c.running} blocked=${c.blocked} gates=${c.gating} machine_leases=${live}${expired ? ` expired_leases=${expired}` : ''}`;

// Between requests: the previous plan was archived and no new plan.json exists yet.
async function noPlan(ctx, json) {
  const s = await slots(ctx);
  const archives = await listArchives(ctx.cwd);
  if (json) {
    ctx.stdout.write(`${JSON.stringify({ plan: null, cap: s.cap, machineLeases: s.live, expiredLeases: s.expired, archives })}\n`);
    return 0;
  }
  ctx.stdout.write(`${[
    'plan: none', capLine(s, { running: 0, blocked: 0, gating: 0 }),
    ...(archives.count ? [`archives: ${archives.count} (latest ${archives.latest})`] : []), ...(s.note ? [s.note] : []), NOTE,
  ].join('\n')}\n`);
  return 0;
}

export async function status(args, ctx) {
  const { flags } = parseFlags(args, { bool: ['json'] }, 'status');
  await assertNotArchiving(ctx.cwd);
  const plan = await readJson(planPath(ctx.cwd), null);
  if (plan === null) return noPlan(ctx, flags.json);
  if (!Array.isArray(plan.units)) throw new CliError(`invalid plan at ${planPath(ctx.cwd)}; run "orq plan check"`);
  const state = await readState(ctx.cwd);
  const {
    cap, live, expired, note: capNote, abandoned,
  } = await slots(ctx);
  const units = plan.units.map((u) => {
    const s = unitOf(state, u.id);
    return { id: u.id, ...s, flagKinds: [...new Set(s.flags.map((f) => f.kind))] };
  });
  const p = state.plan;
  const integration = p.planId ? { branch: p.integrationBranch, head: p.integrationHead, base: p.baseSha } : null;
  const cooling = Object.entries((await readRegistry(ctx.env)).instances) // display only: read outside the lock
    .filter(([, i]) => i.cooldownUntil != null && i.cooldownUntil > ctx.now())
    .map(([instance, i]) => ({ instance, until: i.cooldownUntil }));
  const who = authorsOf(plan.units.map((u) => u.id), state); // the same value tick routes review/fix on
  const deciding = (await readAsks(ctx.cwd)).asks.filter((a) => a.status === 'running')
    .map((a) => ({ n: a.n, threadId: a.threadId, key: a.key }));
  if (flags.json) {
    ctx.stdout.write(`${JSON.stringify({
      goal: plan.goal, plan: p, integration, authors: who, decisions: deciding, cap, machineLeases: live, expiredLeases: expired, cooling, units,
    })}\n`);
    return 0;
  }
  const c = countStates(plan, state);
  ctx.stdout.write(`${[
    `plan: ${plan.goal} (${p.planId ?? 'not started'})`,
    ...(integration ? [`integration: ${integration.branch} head=${short(integration.head)} base=${short(integration.base)}`] : []),
    capLine({ cap, live, expired }, c),
    ...units.map(unitLine),
    ...(who ? [`authors: max_tier=${who.maxTier} family=${who.family}`] : []),
    ...deciding.map((a) => `ask: decision ${a.n} running thread=${a.threadId} model=${a.key}`),
    ...abandoned,
    ...(cooling.length ? [`cooling: ${cooling.map((c) => `${c.instance} until ${new Date(c.until).toISOString()}`).join(', ')}`] : []),
    ...(capNote ? [capNote] : []),
    NOTE,
  ].join('\n')}\n`);
  return 0;
}
