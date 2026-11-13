// orq ask --show, and the polling `orq ask` itself does: read a decision thread, record its outcome once.
import { createT3 } from '../t3.mjs';
import { assertNotArchiving } from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
import { refreshSideLease, settleSideThread } from '../side-thread.mjs';
import {
  endAsk, findAsk, noDecision, outcomeOf, pendingLine, readAsks, updateAsks,
} from '../ask.mjs';
import { projectConfigPath } from '../paths.mjs';

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function print(ctx, lines) {
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

// Record the outcome once; the call that ends the decision frees its slot and counts the model's health.
async function conclude(ctx, rec, threadStatus, out) {
  const fx = { cwd: ctx.cwd, env: ctx.env, now: ctx.now };
  const ended = await updateAsks(ctx.cwd, (doc) => {
    const r = endAsk(doc, rec.n, out, ctx.now());
    return { doc: r.doc, result: r.ended };
  });
  if (ended) await settleSideThread(fx, { key: rec.key, threadId: rec.threadId, jobClass: 'decide', ok: threadStatus === 'completed' });
}

// One look at the thread: the outcome lines when it ended, null while it runs or cannot be read.
async function look(ctx, t3, rec) {
  let shown;
  try {
    shown = t3.showThread(rec.threadId, { messages: 1 });
  } catch {
    return null; // a read error is not an outcome: try again, or report it as pending
  }
  const reply = shown.messages.filter((m) => m?.role === 'assistant').at(-1)?.text ?? '';
  const out = outcomeOf(shown.thread.status, reply);
  if (out.status === 'running') {
    await refreshSideLease({ env: ctx.env, now: ctx.now }, rec.threadId);
    return null;
  }
  await conclude(ctx, rec, shown.thread.status, out);
  return out.lines;
}

export async function waitFor(ctx, t3, rec, deadline, pollMs) {
  for (;;) {
    const lines = await look(ctx, t3, rec);
    if (lines) return lines;
    const left = deadline - ctx.now();
    if (left <= 0) return [pendingLine(rec.n)];
    await (ctx.sleep ?? realSleep)(Math.min(pollMs, left));
  }
}

// The stored outcome, for a decision that ended and whose thread cannot be read again.
const stored = (rec) => [rec.status === 'answered' ? `answer: ${rec.outcome}` : `escalate: ${rec.outcome}`];

export async function show(ctx, n) {
  await assertNotArchiving(ctx.cwd);
  const rec = findAsk(await readAsks(ctx.cwd), n);
  if (!rec) return print(ctx, noDecision(n === undefined ? 'no decision in this plan' : `decision ${n} is not in this plan`).lines);
  if (rec.status === 'starting') {
    return print(ctx, ctx.now() <= (rec.until ?? 0) ? [pendingLine(rec.n)] : noDecision(`decision ${rec.n} never started`).lines);
  }
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const lines = config.t3 && rec.threadId ? await look(ctx, createT3({ bin: config.t3.bin, exec: ctx.deps.exec }), rec) : null;
  return print(ctx, lines ?? (rec.status === 'running' ? [pendingLine(rec.n)] : stored(rec)));
}
