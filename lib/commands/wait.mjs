// orq wait: drive the plan until something needs the orchestrator, then print one summary line.
import fs from 'node:fs';
import path from 'node:path';
import { createT3, needsShow } from '../t3.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { validatePlan } from '../plan.mjs';
import { loadMachineConfig, loadProjectConfig } from '../config.mjs';
import { resolveCap } from '../probe.mjs';
import { withLock } from '../lock.mjs';
import { readJson } from '../store.mjs';
import { emptyRegistry } from '../registry.mjs';
import { listLeases } from '../leases.mjs';
import {
  commit, readState, unitOf, FINAL,
} from '../ledger.mjs';
import { tick } from '../tick.mjs';
import { perform } from '../effects.mjs';
import { collectGate, spawnGateRun, pidAlive } from '../gaterun.mjs';
import { adoptLaunches, tendLeases } from '../reconcile.mjs';
import { parseWorkerStatus } from '../worker-status.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath, registryPath, runnerLockPath,
} from '../paths.mjs';
import {
  CliError, parseFlags, playbook, usage,
} from './common.mjs';
import { decide, timeoutLines } from './wait-report.mjs';

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function prepare(ctx) {
  const plan = await readJson(planPath(ctx.cwd), null);
  const at = (f) => path.join(ctx.cwd, f);
  const rules = playbook('routing.json');
  const checked = plan && validatePlan(plan, { jobs: rules.jobs, exists: (f) => fs.existsSync(at(f)), readFile: (f) => fs.readFileSync(at(f), 'utf8') });
  if (!checked?.ok) throw new CliError('no valid plan; run "orq plan check"', 4);
  if (plan.units.some((u) => u.id === FINAL)) throw new CliError(`unit id "${FINAL}" is reserved for the final gate; rename it`, 4);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const { cap } = resolveCap({ machine: ctx.deps.readMachine(), config: machine.cap ? { cap: machine.cap } : {} });
  const fx = {
    cwd: ctx.cwd, env: ctx.env, now: ctx.now, t3: createT3({ bin: config.t3.bin, exec: ctx.deps.exec }),
    git: createGit({ exec: ctx.deps.gitExec ?? gitExec }), spawnGate: ctx.deps.spawnGate ?? spawnGateRun, isAlive: ctx.deps.isAlive ?? pidAlive,
  };
  const tickConfig = defined({
    stallMinutes: config.stallMinutes, gateConcurrency: config.gateConcurrency, leaseTtlMinutes: config.leaseTtlMinutes,
    perInstanceLimit: machine.perInstanceLimit,
  });
  return {
    fx, plan, config, cap, rules, tickConfig, pollMs: (config.pollSeconds ?? 15) * 1000,
  };
}

// Threads of running/blocked units, with `pending` known. Runs t3 outside every lock.
function observeThreads(fx, plan, state, rows) {
  const wanted = plan.units.map((u) => unitOf(state, u.id)).filter((u) => u.state === 'running' || u.state === 'blocked');
  const listed = new Map(rows.map((t) => [t.id, t]));
  const out = {};
  for (const u of wanted) {
    const t = listed.get(u.threadId);
    if (!t) continue;
    const fresh = t.status === 'completed' && (u.since === null || t.updatedAt > u.since);
    if (fresh) out[u.threadId] = { ...t, report: readReport(fx, u.threadId) };
    else out[u.threadId] = needsShow(t) ? fx.t3.showThread(u.threadId).thread : t;
  }
  return out;
}

// The status line of a just-completed worker's last reply. Unreadable means unknown: the unit is gated as usual.
function readReport(fx, threadId) {
  try {
    const { messages } = fx.t3.showThread(threadId, { messages: 1 });
    const last = messages.filter((m) => m?.role === 'assistant').at(-1);
    return last ? parseWorkerStatus(last.text) : null;
  } catch {
    return null; // the gate still judges the work; a missing reply must not block it
  }
}

async function collectGates(fx, plan, state) {
  const out = {};
  for (const { id } of plan.units) {
    const u = unitOf(state, id);
    if (u.state === 'gating' && u.gateStarts > 0) out[id] = await collectGate(fx, id, u.attempt, u.headSha);
  }
  if (state.plan.finalGateStarts > 0 && state.plan.final?.head !== state.plan.integrationHead) out[FINAL] = await collectGate(fx, FINAL, 1, state.plan.integrationHead);
  return out;
}

async function poll(run) {
  const { fx, plan } = run;
  const listed = fx.t3.listThreads({ project: fx.cwd }); // t3 runs outside every lock
  await adoptLaunches(fx, listed);
  const before = await readState(fx.cwd);
  const threads = observeThreads(fx, plan, before, listed);
  const tended = await tendLeases(fx, before, { ...Object.fromEntries(listed.map((t) => [t.id, t])), ...threads });
  run.notes.push(...tended.notes);
  const gates = await collectGates(fx, plan, before);
  let out;
  await commit(fx.cwd, async (state) => {
    const leases = await listLeases(leasesDir(fx.env));
    const registry = await readJson(registryPath(fx.env), emptyRegistry());
    out = tick({
      plan, state, threads, registry, rules: run.rules, leases, cap: run.cap, gates, config: run.tickConfig, now: fx.now(),
    });
    return out.events;
  });
  let launched = 0;
  for (const a of out.actions) {
    const r = await perform(fx, a, run);
    if (a.type === 'launch' && (r?.threadId || r?.orphaned)) launched += 1;
    if (r?.note) run.notes.push(r.note);
  }
  return { report: out.report, launched };
}

async function loop(ctx, run, maxSeconds) {
  const deadline = ctx.now() + maxSeconds * 1000;
  const sleep = ctx.sleep ?? realSleep;
  for (;;) {
    const { report, launched } = await poll(run);
    const state = await readState(ctx.cwd);
    const lines = decide({
      plan: run.plan, cap: run.cap, report, state, launched,
    });
    const left = deadline - ctx.now();
    const out = lines ?? (left <= 0 ? timeoutLines(run.plan, state, report) : null);
    if (out) return [out[0], ...run.notes, ...out.slice(1)];
    await sleep(Math.min(run.pollMs, left));
  }
}

export async function wait(args, ctx) {
  const { flags } = parseFlags(args, { value: ['max-seconds'] }, 'wait');
  const maxSeconds = flags['max-seconds'] === undefined ? 480 : Number(flags['max-seconds']);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw usage('wait: --max-seconds must be a positive integer');
  const run = { ...(await prepare(ctx)), notes: [] };
  const lockFile = runnerLockPath(ctx.cwd);
  let lines;
  try {
    lines = await withLock(lockFile, () => loop(ctx, run, maxSeconds), { timeoutMs: 0 });
  } catch (e) {
    if (!e.message.startsWith(`lock busy: ${lockFile}`)) throw e;
    const held = await readJson(lockFile, null);
    throw new CliError(`another orq wait is running (pid ${held?.pid ?? 'unknown'})`, 5);
  }
  ctx.stdout.write(`${lines.slice(0, 7).join('\n')}\n`);
  return 0;
}
