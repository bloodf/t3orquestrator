import { createT3, isTerminal } from '../t3.mjs';
import { loadProjectConfig } from '../config.mjs';
import { recordFailure, recordSuccess } from '../health.mjs';
import { listLeases, removeLease, writeLease } from '../leases.mjs';
import { updateRegistry, withMachine } from '../launch.mjs';
import {
  endReview, findReview, lastMessage, readReviews, updateReviews,
} from '../review.mjs';
import { leasesDir, projectConfigPath } from '../paths.mjs';
import { CliError } from './common.mjs';

async function refreshLease(fx, threadId) {
  await withMachine(fx, async () => {
    const lease = (await listLeases(leasesDir(fx.env))).find((l) => l.threadId === threadId);
    if (lease) await writeLease(leasesDir(fx.env), { ...lease, heartbeatAt: fx.now() });
  });
}

// Record the outcome exactly once: only the call that moved the review out of "running" does it.
async function conclude(fx, r, status) {
  const ended = await updateReviews(fx.cwd, (doc) => {
    const out = endReview(doc, r.n, status, fx.now());
    return { doc: out.doc, result: out.ended };
  });
  if (!ended) return;
  await updateRegistry(fx, (reg) => (status === 'completed'
    ? recordSuccess(reg, r.key, { now: fx.now(), jobClass: 'review', firstPass: false })
    : recordFailure(reg, r.key, { now: fx.now(), jobClass: 'review', kind: 'unknown' })));
  await withMachine(fx, () => removeLease(leasesDir(fx.env), r.threadId));
}

export async function show(n, ctx) {
  const r = findReview(await readReviews(ctx.cwd), n);
  if (!r) throw new CliError(n === undefined ? 'review: none started' : `review: no review ${n}`, 4);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const { thread, messages } = createT3({ bin: config.t3.bin, exec: ctx.deps.exec }).showThread(r.threadId, { messages: 1 });
  const fx = { cwd: ctx.cwd, env: ctx.env, now: ctx.now };
  if (!isTerminal(thread)) {
    await refreshLease(fx, r.threadId);
    ctx.stdout.write(`review ${r.n}: running\n`);
    return 0;
  }
  if (thread.status === 'completed') {
    await conclude(fx, r, 'completed');
    ctx.stdout.write(`review ${r.n}: completed\n${lastMessage(messages)}\n`);
    return 0;
  }
  await conclude(fx, r, 'failed');
  ctx.stdout.write(`review ${r.n}: failed; run "orq review start" again\n`);
  return 4;
}
