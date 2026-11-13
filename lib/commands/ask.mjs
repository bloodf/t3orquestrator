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
import { refreshSideLease, settleSideThread, startSideThread } from '../side-thread.mjs';
import {
  MAX_QUESTION, addAsk, decisionMessage, endAsk, findAsk, noDecision, outcomeOf, pendingLine, questionLine, readAsks, updateAsks,
} from '../ask.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath,
} from '../paths.mjs';
import {
  CliError, parseFlags, playbook, readRegistry, refuseWorker, usage,
} from './common.mjs';

const USAGE = 'ask: usage: ask [--unit <id>] [--max-seconds N] < question | ask --show [<n>]';
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const template = () => fs.readFile(new URL('../../playbook/templates/decision-order.md', import.meta.url), 'utf8');

function print(ctx, lines) {
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

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
function isSelf(registry, orchestrator) {
  const own = orchestrator && registry.models[`${orchestrator.instance}::${orchestrator.model}`];
  const tiers = Object.values(registry.models).filter((m) => m.available && routable(registry.instances[m.instance])).map((m) => m.tier);
  return Boolean(own) && tiers.length > 0 && own.tier >= Math.max(...tiers);
}

async function routeDecide(ctx, registry, config) {
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const ttl = (config.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000;
  const result = pick({
    registry, rules: playbook('routing.json'), job: 'decide', defaultLimit: machine.perInstanceLimit,
    running: runningByInstance(await listLeases(leasesDir(ctx.env)), ctx.now(), ttl), now: ctx.now(),
  });
  const { cap } = resolveCap({ machine: ctx.deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  return { result, cap, ttl };
}

// Where the decider reads the project: the integration head once a plan started, else the configured base.
function checkoutOf(ctx, state, plan, config) {
  if (state.plan.planId !== null) return { worktree: state.plan.integrationHead, prefix: `orq/${state.plan.planId}` };
  const git = createGit({ exec: ctx.deps.gitExec ?? gitExec }); // subprocess: no lock is held here
  return { worktree: git.resolveSha(ctx.cwd, plan?.base || config.base), prefix: 'orq' };
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

async function waitFor(ctx, t3, rec, deadline, pollMs) {
  for (;;) {
    const lines = await look(ctx, t3, rec);
    if (lines) return lines;
    const left = deadline - ctx.now();
    if (left <= 0) return [pendingLine(rec.n)];
    await (ctx.sleep ?? realSleep)(Math.min(pollMs, left));
  }
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

async function decide(ctx, flags) {
  const maxSeconds = flags['max-seconds'] === undefined ? 300 : Number(flags['max-seconds']);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw usage('ask: --max-seconds must be a positive integer');
  const deadline = ctx.now() + maxSeconds * 1000;
  const question = await readQuestion(ctx);
  const plan = await readJson(planPath(ctx.cwd), null);
  const { unit, order } = await unitOf(ctx, plan, flags.unit);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (config.questions === 'user') return print(ctx, ['user: questions are set to user']);
  const registry = await readRegistry(ctx.env);
  if (isSelf(registry, config.orchestrator)) return print(ctx, ['self: you run on the strongest enabled tier; decide it yourself']);
  if (!config.t3) return print(ctx, noDecision('no usable t3; run "orq init"').lines);
  const { result, cap, ttl } = await routeDecide(ctx, registry, config);
  if (result.candidates.length === 0) return print(ctx, noDecision(`no model: ${result.reason}`).lines);
  const c = result.candidates[0];
  let at;
  try {
    at = checkoutOf(ctx, await readState(ctx.cwd), plan, config);
  } catch (e) {
    return print(ctx, noDecision(`no checkout to read: ${e.message.split('\n')[0]}`).lines);
  }
  // ponytail: n is read before the launch; two concurrent asks could share a branch name. Serialize if it bites.
  const n = (await readAsks(ctx.cwd)).asks.length + 1;
  const message = decisionMessage({
    template: await template(), question, plan: Array.isArray(plan?.units) ? plan : null, unit, order,
  });
  const pollMs = (config.pollSeconds ?? 15) * 1000;
  const started = await launch(ctx, {
    bin: config.t3.bin, c, cap, ttl, kind: 'ask', n, jobClass: 'decide', message, worktree: at.worktree, branch: `${at.prefix}/ask-${n}`, title: `orq ask ${n}`,
  }, deadline, pollMs);
  if (started.noSlot) return print(ctx, noDecision('no free machine slot').lines);
  if (started.error) return print(ctx, noDecision(`start failed on ${c.key}`).lines);
  const rec = await updateAsks(ctx.cwd, (doc) => {
    const next = addAsk(doc, {
      key: c.key, tier: c.tier, threadId: started.threadId, unit: unit?.id ?? null, question: questionLine(question), status: 'running', outcome: null, startedAt: ctx.now(), endedAt: null,
    });
    return { doc: next, result: next.asks.at(-1) };
  });
  return print(ctx, await waitFor(ctx, createT3({ bin: config.t3.bin, exec: ctx.deps.exec }), rec, deadline, pollMs));
}

// The stored outcome, for a decision that ended and whose thread cannot be read again.
const stored = (rec) => [rec.status === 'answered' ? `answer: ${rec.outcome}` : `escalate: ${rec.outcome}`];

async function show(ctx, n) {
  const rec = findAsk(await readAsks(ctx.cwd), n);
  if (!rec) throw new CliError(n === undefined ? 'ask: no decision started' : `ask: no decision ${n}`, 4);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const lines = config.t3 ? await look(ctx, createT3({ bin: config.t3.bin, exec: ctx.deps.exec }), rec) : null;
  return print(ctx, lines ?? (rec.status === 'running' ? [pendingLine(rec.n)] : stored(rec)));
}

export async function ask(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['show'], value: ['unit', 'max-seconds'] }, 'ask');
  await refuseWorker(ctx);
  await assertNotArchiving(ctx.cwd);
  if (flags.show) {
    const [n] = positional;
    if (positional.length > 1 || flags.unit !== undefined || flags['max-seconds'] !== undefined || (n !== undefined && !/^[1-9]\d*$/.test(n))) throw usage(USAGE);
    return show(ctx, n === undefined ? undefined : Number(n));
  }
  if (positional.length > 0) throw usage(USAGE);
  return decide(ctx, flags);
}
