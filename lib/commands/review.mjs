// orq review start|show: a reviewer thread on another model family reads the integrated result.
import { assertNotArchiving, authorsOf, readState } from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
import { readJson } from '../store.mjs';
import { REVIEW_ORDER } from '../review.mjs';
import { planPath, projectConfigPath } from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';
import { show } from './review-show.mjs';
import { launchReview, none, readOrder } from './review-launch.mjs';

async function start(flags, ctx) {
  const plan = await readJson(planPath(ctx.cwd), null);
  const state = await readState(ctx.cwd);
  if (state.plan.planId === null || !plan?.units || !authorsOf(plan.units.map((u) => u.id), state)) {
    throw new CliError('review: nothing integrated yet', 4);
  }
  const orderFile = flags.order ?? REVIEW_ORDER;
  const order = await readOrder(ctx.cwd, orderFile);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const r = await launchReview(ctx, {
    plan, state, config, order, orderFile, head: state.plan.integrationHead,
  });
  if (r.none) return none(ctx, r.none);
  if (r.error) throw new CliError(`review: start failed on ${r.c.key}; run it again for the next candidate`, 4);
  ctx.stdout.write(`review ${r.n}: thread=${r.threadId} model=${r.c.key} head=${state.plan.integrationHead.slice(0, 12)}\n`);
  return 0;
}

export async function review(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['order'] }, 'review');
  const [sub, n] = positional;
  const usageText = 'review: usage: review start [--order <file>] | review show [<n>]';
  await assertNotArchiving(ctx.cwd);
  if (sub === 'start' && positional.length === 1) return start(flags, ctx);
  if (sub === 'show' && positional.length <= 2 && flags.order === undefined) {
    if (n !== undefined && !/^[1-9]\d*$/.test(n)) throw usage(usageText);
    return show(n === undefined ? undefined : Number(n), ctx);
  }
  throw usage(usageText);
}
