// orq review start|show: a reviewer thread on another model family reads the integrated result.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createT3 } from '../t3.mjs';
import { route as pick } from '../route.mjs';
import { authorsOf, readState } from '../ledger.mjs';
import { loadMachineConfig, loadProjectConfig } from '../config.mjs';
import { resolveCap } from '../probe.mjs';
import { markUsed, recordFailure } from '../health.mjs';
import {
  DEFAULT_LEASE_TTL_MINUTES, listLeases, removeLease, runningByInstance, writeLease,
} from '../leases.mjs';
import { reserve, updateRegistry, withMachine } from '../launch.mjs';
import { underOrq } from '../plan.mjs';
import { readJson } from '../store.mjs';
import {
  addReview, leaseMark, lineCount, MAX_ORDER_LINES, readReviews, REVIEW_ORDER, updateReviews,
} from '../review.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath,
} from '../paths.mjs';
import {
  CliError, parseFlags, playbook, readRegistry, usage,
} from './common.mjs';
import { show } from './review-show.mjs';

async function readOrder(cwd, file) {
  if (!underOrq(file, cwd) || !path.posix.normalize(file).startsWith('.orq/orders/')) {
    throw usage('review: --order must be a file under .orq/orders/');
  }
  let text;
  try {
    const full = path.join(cwd, file);
    if (!(await fs.stat(full)).isFile()) throw new CliError(`review: order ${file} is not a regular file`, 4);
    text = await fs.readFile(full, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(`review: order file ${file} is missing`, 4);
    throw e;
  }
  const lines = lineCount(text);
  if (lines > MAX_ORDER_LINES) throw new CliError(`review: order file ${file} has ${lines} lines, limit is ${MAX_ORDER_LINES}`, 4);
  return text;
}

function none(ctx, { blocked, retryAt, reason }) {
  ctx.stdout.write(`none blocked=${blocked} retry_at=${retryAt === null ? '-' : new Date(retryAt).toISOString()} reason="${reason}"\n`);
  return 4;
}

async function chooseCandidate(ctx, plan, state, config) {
  const author = authorsOf(plan.units.map((u) => u.id), state);
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const ttl = (config.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;
  const result = pick({
    registry: await readRegistry(ctx.env),
    defaultLimit: machine.perInstanceLimit,
    rules: playbook('routing.json'),
    job: 'review',
    authorTier: author.maxTier,
    authorFamily: author.family,
    running: runningByInstance(await listLeases(leasesDir(ctx.env)), ctx.now(), ttl),
    now: ctx.now(),
  });
  const { cap } = resolveCap({ machine: ctx.deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  return { result, cap, ttl };
}

async function start(flags, ctx) {
  const plan = await readJson(planPath(ctx.cwd), null);
  const state = await readState(ctx.cwd);
  if (state.plan.planId === null || !plan?.units || !authorsOf(plan.units.map((u) => u.id), state)) {
    throw new CliError('review: nothing integrated yet', 4);
  }
  const order = await readOrder(ctx.cwd, flags.order ?? REVIEW_ORDER);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const { result, cap, ttl } = await chooseCandidate(ctx, plan, state, config);
  if (result.candidates.length === 0) return none(ctx, result);
  const c = result.candidates[0];
  const fx = { cwd: ctx.cwd, env: ctx.env, now: ctx.now };
  const n = (await readReviews(ctx.cwd)).reviews.length + 1;
  const unit = `review-${n}`;
  const reservation = await reserve(fx, {
    unit, attempt: 1, instance: c.instance, model: c.model, mark: leaseMark(n),
  }, cap, ttl);
  if (reservation === null) return none(ctx, { blocked: 'limit', retryAt: null, reason: 'cap reached' });
  const head = state.plan.integrationHead;
  let threadId;
  try { // t3 runs outside every lock
    ({ threadId } = createT3({ bin: config.t3.bin, exec: ctx.deps.exec }).startThread({
      project: ctx.cwd, message: order, provider: c.instance, model: c.model, worktree: head, branch: `orq/${state.plan.planId}/review-${n}`, title: `orq review ${n}`,
    }));
  } catch {
    await withMachine(fx, () => removeLease(leasesDir(ctx.env), reservation));
    await updateRegistry(fx, (r) => recordFailure(r, c.key, { now: ctx.now(), jobClass: 'review', kind: 'unknown' }));
    throw new CliError(`review: start failed on ${c.key}; run it again for the next candidate`, 4);
  }
  await withMachine(fx, async () => {
    await writeLease(leasesDir(ctx.env), {
      threadId, project: ctx.cwd, unit, instance: c.instance, model: c.model, startedAt: ctx.now(), heartbeatAt: ctx.now(), blocked: false, ...leaseMark(n),
    });
    await removeLease(leasesDir(ctx.env), reservation);
  });
  // ponytail: n is read before the launch; two concurrent starts could share a branch name. Serialize starts if it bites.
  const added = await updateReviews(ctx.cwd, (doc) => {
    const next = addReview(doc, {
      threadId, key: c.key, instance: c.instance, model: c.model, tier: c.tier, family: c.family, head, startedAt: ctx.now(), status: 'running', endedAt: null,
    });
    return { doc: next, result: next.reviews.at(-1).n };
  });
  await updateRegistry(fx, (r) => markUsed(r, c.key, ctx.now()));
  ctx.stdout.write(`review ${added}: thread=${threadId} model=${c.key} head=${head.slice(0, 12)}\n`);
  return 0;
}

export async function review(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['order'] }, 'review');
  const [sub, n] = positional;
  const usageText = 'review: usage: review start [--order <file>] | review show [<n>]';
  if (sub === 'start' && positional.length === 1) return start(flags, ctx);
  if (sub === 'show' && positional.length <= 2 && flags.order === undefined) {
    if (n !== undefined && !/^[1-9]\d*$/.test(n)) throw usage(usageText);
    return show(n === undefined ? undefined : Number(n), ctx);
  }
  throw usage(usageText);
}
