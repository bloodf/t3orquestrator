import { createT3, isTerminal } from '../t3.mjs';
import { loadProjectConfig } from '../config.mjs';
import { refreshSideLease, settleSideThread } from '../side-thread.mjs';
import {
  endReview, findReview, lastMessage, readReviews, updateReviews,
} from '../review.mjs';
import { projectConfigPath } from '../paths.mjs';
import { quoteLines } from '../worker-status.mjs';
import { CliError } from './common.mjs';

// Record the outcome exactly once: only the call that moved the review out of "running" does it.
async function conclude(fx, r, status) {
  const ended = await updateReviews(fx.cwd, (doc) => {
    const out = endReview(doc, r.n, status, fx.now());
    return { doc: out.doc, result: out.ended };
  });
  if (ended) await settleSideThread(fx, { key: r.key, threadId: r.threadId, jobClass: 'review', ok: status === 'completed' });
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
  await conclude(fx, r, 'failed');
  ctx.stdout.write(`review ${r.n}: failed; run "orq review start" again\n`);
  return 4;
}
