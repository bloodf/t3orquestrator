// orq unit retry|drop: the orchestrator's judgment, recorded in the ledger under the project lock.
import {
  assertNotArchiving, commit, unitOf, FINAL,
} from '../ledger.mjs';
import { removeLease } from '../leases.mjs';
import { readJson } from '../store.mjs';
import { collectGate, pidAlive } from '../gaterun.mjs';
import { leasesDir, planPath } from '../paths.mjs';
import {
  CliError, parseFlags, usage, withMachineLock,
} from './common.mjs';

const USAGE = 'unit: usage: unit retry <id> [--tier N] | unit drop <id>';

function parseTier(value, sub) {
  if (value === undefined) return undefined;
  if (sub !== 'retry') throw usage(USAGE);
  const tier = Number(value);
  if (!Number.isInteger(tier) || tier < 1 || tier > 4) throw usage(`unit: --tier must be an integer 1-4, got ${value}`);
  return tier;
}

// A gate or a merge in progress would act on dropped work.
async function refuseBusy(ctx, id, u) {
  const gating = u.state === 'gating' && (await collectGate({ cwd: ctx.cwd, isAlive: pidAlive }, id, u.attempt)).running;
  if (u.state === 'passed' || gating) throw new CliError(`cannot drop ${id} while it is being gated or merged; run it again in a moment`, 4);
}

// A dropped unit never integrates, so a unit depending on it could never start.
function refuseDependents(plan, state, id) {
  const deps = plan.units.filter((x) => (x.deps ?? []).includes(id) && unitOf(state, x.id).state !== 'dropped').map((x) => x.id);
  if (deps.length) throw new CliError(`cannot drop ${id}: ${deps.join(', ')} depend on it; drop them first, or remove "${id}" from their deps in .orq/plan.json`, 4);
}

async function event(ctx, sub, id, u, tier) {
  if (sub === 'retry' && u.state !== 'failed') throw new CliError(`unit ${id} is ${u.state}; only a failed unit can be retried`);
  if (sub === 'retry' && u.setupFailed && tier) throw new CliError(`unit ${id} failed its setup: no new worker runs, its branch is gated again; retry without --tier`);
  if (sub === 'drop' && (u.state === 'integrated' || u.state === 'dropped')) throw new CliError(`unit ${id} is ${u.state}; it cannot be dropped`);
  if (sub === 'drop') await refuseBusy(ctx, id, u);
  return sub === 'retry' ? { type: 'retried', unit: id, at: ctx.now(), ...(tier ? { tier } : {}) } : { type: 'dropped', unit: id, at: ctx.now() };
}

// The final gate lost twice, its setup failed, or its checks failed (checks.full may have been narrowed since):
// run it again on the same head, with the config as it is now.
async function retryFinal(ctx) {
  await commit(ctx.cwd, async (s) => {
    const p = s.plan;
    const failed = p.final?.head === p.integrationHead && p.final.verdict === 'fail';
    const setupFailed = p.finalGateStarts > 0
      && (await collectGate({ cwd: ctx.cwd, isAlive: pidAlive }, FINAL, 1, p.integrationHead)).result?.setupFailed === true;
    const stuck = p.final?.head !== p.integrationHead && (p.finalGateStarts >= 2 || setupFailed);
    if (!failed && !stuck) throw new CliError('the final gate is not stuck; nothing to retry');
    return [{ type: 'final-retried', unit: null, at: ctx.now() }];
  });
  ctx.stdout.write(`retried ${FINAL}: the final gate will run again\n`);
  return 0;
}

export async function unit(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['tier'] }, 'unit');
  const [sub, id] = positional;
  if (positional.length !== 2 || !['retry', 'drop'].includes(sub)) throw usage(USAGE);
  const tier = parseTier(flags.tier, sub);
  await assertNotArchiving(ctx.cwd);
  if (sub === 'retry' && id === FINAL) return retryFinal(ctx);
  const plan = await readJson(planPath(ctx.cwd), null);
  if (!plan?.units?.some((u) => u.id === id)) throw new CliError(`unit ${id} is not in the plan`);
  let before;
  const { state: after } = await commit(ctx.cwd, async (state) => {
    before = unitOf(state, id);
    if (sub === 'drop') refuseDependents(plan, state, id);
    return [await event(ctx, sub, id, before, tier)];
  });
  if (sub === 'retry') {
    const kept = unitOf(after, id).failedLaunch;
    const how = before.setupFailed ? 'its branch will be gated again'
      : `queued${tier ? `, minimum tier ${tier}` : ''}${kept ? `, continues from the work left by ${kept.key}` : ''}`;
    ctx.stdout.write(`retried ${id}: ${how}\n`);
    return 0;
  }
  const live = (before.state === 'running' || before.state === 'blocked') && before.threadId;
  if (live) await withMachineLock(ctx, () => removeLease(leasesDir(ctx.env), before.threadId));
  ctx.stdout.write(`dropped ${id}\n${live ? `note: thread ${before.threadId} keeps running in T3; stop it there if needed\n` : ''}`);
  return 0;
}
