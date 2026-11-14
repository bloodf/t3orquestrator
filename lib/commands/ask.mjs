// orq ask: a decision from the strongest enabled model, so a question does not have to wait for the user.
// Every way it can fail ends in an `escalate:` line (ask the user in your own thread), never a failed run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createT3 } from '../t3.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { route as pick } from '../route.mjs';
import { routable } from '../registry.mjs';
import { assertNotArchiving, readState } from '../ledger.mjs';
import { loadMachineConfig, loadProjectConfig } from '../config.mjs';
import { resolveCap } from '../probe.mjs';
import { DEFAULT_LEASE_TTL_MINUTES, listLeases, runningByInstance } from '../leases.mjs';
import { underOrq } from '../plan.mjs';
import { readJson } from '../store.mjs';
import { settleSideThread, startSideThread } from '../side-thread.mjs';
import { print, show, waitFor } from './ask-show.mjs';
import {
  MAX_QUESTION, addAsk, decisionMessage, endAsk, noDecision, questionLine, runAsk, updateAsks,
} from '../ask.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath,
} from '../paths.mjs';
import {
  parseFlags, playbook, readRegistry, refuseWorker, usage,
} from './common.mjs';

const USAGE = 'ask: usage: ask [--unit <id>] [--max-seconds N] < question | ask --show [<n>]';
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const template = () => fs.readFile(new URL('../../playbook/templates/decision-order.md', import.meta.url), 'utf8');

async function readQuestion(ctx) {
  const text = await ctx.stdin();
  if (Buffer.byteLength(text) > MAX_QUESTION) throw usage('ask: question too large (16 KiB at most)');
  if (text.trim() === '') throw usage('ask: expects the question on stdin');
  return text;
}

// The unit named by --unit and its work order; an unknown id is a usage error.
async function unitOf(ctx, plan, id) {
  if (id === undefined) return { unit: null, order: '' };
  const unit = plan?.units?.find((u) => u?.id === id);
  if (!unit) throw usage(`ask: unit ${id} is not in the plan`);
  const order = underOrq(unit.order, ctx.cwd) ? await fs.readFile(path.join(ctx.cwd, unit.order), 'utf8').catch(() => '') : '';
  return { unit, order };
}

// The orchestrator's own model is at least as strong as anything enabled: asking another model gains nothing.
// The record is the one `orq sync` wrote for a thread; it describes the caller only when the caller is that thread.
function isSelf(registry, orchestrator, env) {
  const mine = orchestrator?.threadId !== undefined && env.T3CODE_THREAD_ID === orchestrator.threadId;
  const own = mine && registry.models[`${orchestrator.instance}::${orchestrator.model}`];
  const tiers = Object.values(registry.models).filter((m) => m.available && routable(registry.instances[m.instance])).map((m) => m.tier);
  return Boolean(own) && tiers.length > 0 && own.tier >= Math.max(...tiers);
}

// failed: keys and instances whose decision thread failed in this ask; the next try avoids them.
async function routeDecide(ctx, registry, config, failed = { keys: [], instances: [] }) {
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const ttl = (config.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;
  const result = pick({
    registry, rules: playbook('routing.json'), job: 'decide', defaultLimit: machine.perInstanceLimit,
    exclude: failed.keys, avoidInstances: failed.instances,
    running: runningByInstance(await listLeases(leasesDir(ctx.env)), ctx.now(), ttl), now: ctx.now(),
  });
  const { cap } = resolveCap({ machine: ctx.deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  return { result, cap, ttl };
}

// Where the decider reads the project: the integration head once a plan started, else the configured base.
// Before a plan starts, branch names carry a time suffix: a later plan's decision 1 must not reuse `orq/ask-1`.
function checkoutOf(ctx, state, plan, config) {
  if (state.plan.planId !== null) return { worktree: state.plan.integrationHead, branch: (n) => `orq/${state.plan.planId}/ask-${n}` };
  const git = createGit({ exec: ctx.deps.gitExec ?? gitExec }); // subprocess: no lock is held here
  return { worktree: git.resolveSha(ctx.cwd, plan?.base || config.base), branch: (n) => `orq/ask-${n}-${ctx.now().toString(36)}` };
}

// Reserve a slot, waiting for one until the deadline; a full machine is not worth more than the caller's budget.
async function launch(ctx, spec, deadline, pollMs) {
  for (;;) {
    const started = await startSideThread(ctx, spec);
    if (!started.noSlot) return started;
    const left = deadline - ctx.now();
    if (left <= 0) return started;
    await (ctx.sleep ?? realSleep)(Math.min(pollMs, left));
  }
}

const MAX_TRIES = 3; // decision threads per ask
const START_GRACE_MS = 60_000; // the asker may still be inside startThread when its deadline passes

// Reserve the decision's number under the project lock, so concurrent asks never share a branch or a lease name.
const reserveAsk = (ctx, fields) => updateAsks(ctx.cwd, (doc) => {
  const next = addAsk(doc, { ...fields, threadId: null, status: 'starting', outcome: null, endedAt: null });
  return { doc: next, result: next.asks.at(-1).n };
});

// End a reserved decision that never ran a thread; the caller prints (or retries).
async function giveUp(ctx, n, out) {
  await updateAsks(ctx.cwd, (doc) => ({ doc: endAsk(doc, n, out, ctx.now()).doc, result: null })).catch(() => {}); // the output says it anyway
  return { lines: out.lines };
}

async function decideOrEscalate(ctx, { question, deadline, flags }) {
  await assertNotArchiving(ctx.cwd);
  const plan = await readJson(planPath(ctx.cwd), null);
  const { unit, order } = await unitOf(ctx, plan, flags.unit);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (config.questions === 'user') return print(ctx, ['user: questions are set to user']);
  const registry = await readRegistry(ctx.env);
  if (isSelf(registry, config.orchestrator, ctx.env)) return print(ctx, ['self: you run on the strongest enabled tier; decide it yourself']);
  if (!config.t3) return print(ctx, noDecision('no usable t3; run "orq init"').lines);
  const first = await routeDecide(ctx, registry, config);
  if (first.result.candidates.length === 0) return print(ctx, noDecision(`no model: ${first.result.reason}`).lines);
  let at;
  try {
    at = checkoutOf(ctx, await readState(ctx.cwd), plan, config);
  } catch (e) {
    return print(ctx, noDecision(`no checkout to read: ${e.message}`).lines);
  }
  const job = {
    config, deadline, at, question, unit,
    message: decisionMessage({
      template: await template(), question, plan: Array.isArray(plan?.units) ? plan : null, unit, order,
    }),
  };
  // A thread that fails, or does not start, is a provider's problem: try the next model, up to MAX_TRIES threads.
  const failed = { keys: [], instances: [] };
  let route = first;
  for (;;) {
    const c = route.result.candidates[0];
    const out = await tryOne(ctx, job, c, route);
    if (!out.retry) return print(ctx, out.lines);
    failed.keys.push(c.key);
    failed.instances.push(c.instance);
    const why = `${out.why}; tried ${failed.keys.join(', ')}`;
    if (failed.keys.length >= MAX_TRIES || ctx.now() >= deadline) return print(ctx, noDecision(why).lines);
    route = await routeDecide(ctx, await readRegistry(ctx.env), config, failed);
    if (route.result.candidates.length === 0) return print(ctx, noDecision(why).lines);
  }
}

// One decision thread on candidate c. -> {lines} to print, or {retry: true, why} when its provider failed.
async function tryOne(ctx, job, c, { cap, ttl }) {
  const { config, deadline, at } = job;
  const n = await reserveAsk(ctx, {
    key: c.key, tier: c.tier, unit: job.unit?.id ?? null, question: questionLine(job.question), startedAt: ctx.now(), until: deadline + START_GRACE_MS,
  });
  const pollMs = (config.pollSeconds ?? 15) * 1000;
  const started = await launch(ctx, {
    bin: config.t3.bin, c, cap, ttl, kind: 'ask', n, jobClass: 'decide', message: job.message, worktree: at.worktree, branch: at.branch(n), title: `orq ask ${n}`, share: config.share ?? [],
  }, deadline, pollMs);
  if (started.noSlot) return giveUp(ctx, n, noDecision('no free machine slot'));
  if (started.error) {
    await giveUp(ctx, n, noDecision(`start failed on ${c.key}`));
    return { retry: true, why: `start failed on ${c.key}` };
  }
  try {
    await updateAsks(ctx.cwd, (doc) => ({ doc: runAsk(doc, n, started.threadId), result: null }));
  } catch (e) {
    // no record will ever settle this thread: free its slot now (the thread itself is left to T3)
    await settleSideThread({ cwd: ctx.cwd, env: ctx.env, now: ctx.now }, { key: c.key, threadId: started.threadId, jobClass: 'decide', ok: false });
    return { lines: noDecision(e.message).lines };
  }
  const out = await waitFor(ctx, createT3({ bin: config.t3.bin, exec: ctx.deps.exec }), { n, key: c.key, threadId: started.threadId }, deadline, pollMs);
  return out.threadFailed ? { retry: true, why: 'the decision thread failed' } : { lines: out.lines };
}

// After the arguments are checked, nothing fails the run: an error becomes "ask the user". Usage errors still exit 2.
async function escalateOnError(ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.exitCode === 2) throw e;
    ctx.stderr.write(`orq: ask: ${e.exitCode ? e.message : e.stack ?? e.message}\n`); // the escalate line is cut short; a bug keeps its stack
    return print(ctx, noDecision(e.message).lines);
  }
}

async function decide(ctx, flags) {
  const maxSeconds = flags['max-seconds'] === undefined ? 300 : Number(flags['max-seconds']);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw usage('ask: --max-seconds must be a positive integer');
  const deadline = ctx.now() + maxSeconds * 1000;
  const question = await readQuestion(ctx);
  return escalateOnError(ctx, () => decideOrEscalate(ctx, { question, deadline, flags }));
}

export async function ask(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['show'], value: ['unit', 'max-seconds'] }, 'ask');
  await refuseWorker(ctx);
  if (flags.show) {
    const [n] = positional;
    if (positional.length > 1 || flags.unit !== undefined || flags['max-seconds'] !== undefined || (n !== undefined && !/^[1-9]\d*$/.test(n))) throw usage(USAGE);
    return escalateOnError(ctx, () => show(ctx, n === undefined ? undefined : Number(n)));
  }
  if (positional.length > 0) throw usage(USAGE);
  return decide(ctx, flags);
}
