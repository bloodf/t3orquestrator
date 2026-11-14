// Starting a review thread: shared by `orq review start` and the replacement `orq review show` starts for a failed one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { route as pick } from '../route.mjs';
import { authorsOf } from '../ledger.mjs';
import { loadMachineConfig } from '../config.mjs';
import { resolveCap } from '../probe.mjs';
import { DEFAULT_LEASE_TTL_MINUTES, listLeases, runningByInstance } from '../leases.mjs';
import { startSideThread } from '../side-thread.mjs';
import { underOrq } from '../plan.mjs';
import {
  addReview, lineCount, MAX_ORDER_LINES, readReviews, updateReviews,
} from '../review.mjs';
import { leasesDir, machineConfigPath } from '../paths.mjs';
import {
  CliError, playbook, readRegistry, usage,
} from './common.mjs';

export async function readOrder(cwd, file) {
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

export function none(ctx, { blocked, retryAt, reason }) {
  ctx.stdout.write(`none blocked=${blocked} retry_at=${retryAt === null ? '-' : new Date(retryAt).toISOString()} reason="${reason}"\n`);
  return 4;
}

async function chooseCandidate(ctx, plan, state, config, exclude = []) {
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
    exclude,
    running: runningByInstance(await listLeases(leasesDir(ctx.env)), ctx.now(), ttl),
    now: ctx.now(),
  });
  const { cap } = resolveCap({ machine: ctx.deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  return { result, cap, ttl };
}

/**
 * Start review n on the best candidate (excluding `exclude` keys). The record keeps the order file and, for a
 * replacement, the review it replaces. -> {n, c, threadId} | {none: route result} | {error, c}.
 */
export async function launchReview(ctx, {
  plan, state, config, order, orderFile, head, exclude = [], replaces = null,
}) {
  const { result, cap, ttl } = await chooseCandidate(ctx, plan, state, config, exclude);
  if (result.candidates.length === 0) return { none: result };
  const c = result.candidates[0];
  const n = (await readReviews(ctx.cwd)).reviews.length + 1;
  const started = await startSideThread(ctx, {
    bin: config.t3.bin, c, cap, ttl, kind: 'review', n, jobClass: 'review', message: order, worktree: head, share: config.share ?? [], branch: `orq/${state.plan.planId}/review-${n}`, title: `orq review ${n}`,
  });
  if (started.noSlot) return { none: { blocked: 'limit', retryAt: null, reason: 'cap reached' } };
  if (started.error) return { error: started.error, c };
  const { threadId } = started;
  // ponytail: n is read before the launch; two concurrent starts could share a branch name. Serialize starts if it bites.
  const added = await updateReviews(ctx.cwd, (doc) => {
    const next = addReview(doc, {
      threadId, key: c.key, instance: c.instance, model: c.model, tier: c.tier, family: c.family, head, orderFile, startedAt: ctx.now(), status: 'running', endedAt: null,
      ...(replaces ? { replaces } : {}),
    });
    return { doc: next, result: next.reviews.at(-1).n };
  });
  return {
    n: added, c, threadId, note: started.note,
  };
}
