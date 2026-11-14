import { createT3, isTerminal } from '../t3.mjs';
import { loadProjectConfig } from '../config.mjs';
import { refreshSideLease, settleSideThread } from '../side-thread.mjs';
import {
  endReview, findReview, lastMessage, readReviews, REVIEW_ORDER, updateReviews,
} from '../review.mjs';
import { projectConfigPath } from '../paths.mjs';
import { quoteLines } from '../worker-status.mjs';
import { readJson } from '../store.mjs';
import { readState } from '../ledger.mjs';
import { planPath } from '../paths.mjs';
import { CliError } from './common.mjs';
import { launchReview, readOrder } from './review-launch.mjs';

const MAX_REPLACEMENTS = 2;

// The reviews this one replaced, newest first, ending with the original.
function chain(doc, r) {
  const out = [r];
  for (let cur = r; cur.replaces; cur = findReview(doc, cur.replaces)) {
    const prev = findReview(doc, cur.replaces);
    if (!prev || out.includes(prev)) break;
    out.push(prev);
  }
  return out;
}

// A review whose thread failed is the provider's problem: run the same order on the same head on another model.
// Best effort: when nothing can replace it, the caller reports the failure as before.
async function replace(ctx, config, r) {
  const doc = await readReviews(ctx.cwd);
  const earlier = chain(doc, r);
  if (earlier.length > MAX_REPLACEMENTS) return null;
  try {
    const order = await readOrder(ctx.cwd, r.orderFile ?? REVIEW_ORDER);
    const plan = await readJson(planPath(ctx.cwd), null);
    const state = await readState(ctx.cwd);
    const next = await launchReview(ctx, {
      plan, state, config, order, orderFile: r.orderFile ?? REVIEW_ORDER, head: r.head, exclude: earlier.map((x) => x.key), replaces: r.n,
    });
    if (!next.n) return null;
    await updateReviews(ctx.cwd, (d) => ({ doc: { reviews: d.reviews.map((x) => (x.n === r.n ? { ...x, replacedBy: next.n } : x)) }, result: null }));
    return next;
  } catch {
    return null;
  }
}

// Record the outcome exactly once: only the call that moved the review out of "running" does it.
async function conclude(fx, r, status) {
  const ended = await updateReviews(fx.cwd, (doc) => {
    const out = endReview(doc, r.n, status, fx.now());
    return { doc: out.doc, result: out.ended };
  });
  if (ended) await settleSideThread(fx, {
    key: r.key, threadId: r.threadId, jobClass: 'review', ok: status === 'completed', done: status === 'completed',
  });
  return ended;
}

export async function show(n, ctx) {
  const r = findReview(await readReviews(ctx.cwd), n);
  if (!r) throw new CliError(n === undefined ? 'review: none started' : `review: no review ${n}`, 4);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const { thread, messages } = createT3({ bin: config.t3.bin, exec: ctx.deps.exec }).showThread(r.threadId, { messages: 1 });
  const fx = { cwd: ctx.cwd, env: ctx.env, now: ctx.now };
  if (!isTerminal(thread)) {
    await refreshSideLease(fx, r.threadId);
    ctx.stdout.write(`review ${r.n}: running\n`);
    return 0;
  }
  if (thread.status === 'completed') {
    await conclude(fx, r, 'completed');
    // the reviewer's report is quoted, so no line of it can pose as an orq line
    ctx.stdout.write(`${[`review ${r.n}: completed`, ...quoteLines(lastMessage(messages).split('\n'), 40, 300)].join('\n')}\n`);
    return 0;
  }
  const ended = await conclude(fx, r, 'failed'); // only the call that ended it may start a replacement
  const by = r.replacedBy ? findReview(await readReviews(ctx.cwd), r.replacedBy) : null;
  const next = by ? { n: by.n, c: { key: by.key }, threadId: by.threadId } : ended && await replace(ctx, config, r);
  if (next) {
    ctx.stdout.write(`review ${r.n}: failed on ${r.key}; replaced by review ${next.n} on ${next.c.key} (thread ${next.threadId})\n`);
    return 0;
  }
  ctx.stdout.write(`review ${r.n}: failed; run "orq review start" again\n`);
  return 4;
}
