// orq wait: drive the plan until something needs the orchestrator, then print one summary line.
import fs from 'node:fs';
import path from 'node:path';
import { createT3 } from '../t3.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import { validatePlan } from '../plan.mjs';
import { replacedPlan } from '../plan-guard.mjs';
import { loadMachineConfig, loadProjectConfig } from '../config.mjs';
import { overrideNote, resolveCap } from '../probe.mjs';
import { withLock } from '../lock.mjs';
import { readJson } from '../store.mjs';
import { emptyRegistry } from '../registry.mjs';
import { DEFAULT_LEASE_TTL_MINUTES, listLeases } from '../leases.mjs';
import {
  assertNotArchiving, commit, readState, unitOf, FINAL,
} from '../ledger.mjs';
import { tick } from '../tick.mjs';
import { perform } from '../effects.mjs';
import { collectGate, spawnGateRun, pidAlive } from '../gaterun.mjs';
import { adoptLaunches, tendLeases } from '../reconcile.mjs';
import { observeThreads } from '../wait-threads.mjs';
import { goalLines } from '../goal.mjs';
import {
  leasesDir, machineConfigPath, planPath, projectConfigPath, projectDir, registryPath, runnerLockPath,
} from '../paths.mjs';
import {
  CliError, parseFlags, playbook, usage,
} from './common.mjs';
import {
  decide, evidenceNote, timeoutLines, withNotes,
} from './wait-report.mjs';
import { playbookNotice } from './kit-info.mjs';
import { readGoal } from './project.mjs';
import {
  byId, readPlanFiles, settleLine, settleList,
} from '../settle.mjs';

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function prepare(ctx) {
  const plan = await readJson(planPath(ctx.cwd), null);
  const at = (f) => path.join(ctx.cwd, f);
  const rules = playbook('routing.json');
  const checked = plan && validatePlan(plan, {
    cwd: ctx.cwd, jobs: rules.jobs, exists: (f) => fs.existsSync(at(f)), readFile: (f) => fs.readFileSync(at(f), 'utf8'),
  });
  if (!checked?.ok) throw new CliError(['no valid plan; run "orq plan check"', ...goalLines(await readGoal(ctx.cwd), 'noPlan')].join('\n'), 4);
  if (plan.units.some((u) => u.id === FINAL)) throw new CliError(`unit id "${FINAL}" is reserved for the final gate; rename it`, 4);
  const replaced = replacedPlan(plan, await readState(ctx.cwd));
  if (replaced) throw new CliError(replaced, 4);
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const machine = await loadMachineConfig(machineConfigPath(ctx.env));
  const facts = ctx.deps.readMachine();
  const capConfig = machine.cap ? { cap: machine.cap } : {};
  const { cap } = resolveCap({ machine: facts, config: capConfig });
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
    capNote: overrideNote({ machine: facts, config: capConfig }), playbookLine: playbookNotice(ctx, config), evidence: evidenceNote(checked.warnings),
  };
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

// Once per call per thread: T3 reported a status this version does not know (the thread is treated as running).
function noteUnknownStatus(run, threads) {
  for (const t of threads) {
    if (!t.unknownStatus || run.unknown.has(t.id)) continue;
    run.unknown.add(t.id);
    run.notes.push(`note: thread ${t.id} has status "${t.unknownStatus}" that this version does not know; treated as running`);
  }
}

async function poll(run) {
  const { fx, plan } = run;
  const listed = fx.t3.listThreads({ project: fx.cwd }); // t3 runs outside every lock
  run.listed = listed; // read again for the settle line, without another t3 call
  await adoptLaunches(fx, listed);
  const before = await readState(fx.cwd);
  const threads = observeThreads(fx, plan, before, listed);
  noteUnknownStatus(run, [...listed, ...Object.values(threads)]);
  const tended = await tendLeases(fx, before, { ...Object.fromEntries(listed.map((t) => [t.id, t])), ...threads }, {
    ttlMs: (run.tickConfig.leaseTtlMinutes ?? DEFAULT_LEASE_TTL_MINUTES) * 60_000,
  });
  run.notes.push(...tended.notes);
  const gates = await collectGates(fx, plan, before);
  let out;
  await commit(fx.cwd, async (state) => {
    const leases = await listLeases(leasesDir(fx.env));
    const registry = await readJson(registryPath(fx.env), emptyRegistry());
    out = tick({
      plan, state, threads, registry, rules: run.rules, leases, cap: run.cap, projectCap: run.config.cap, project: fx.cwd, gates, config: run.tickConfig, now: fx.now(),
    });
    return out.events;
  });
  run.notes.push(...out.report.notes);
  let launched = 0;
  const capped = []; // the slot was taken (by another project or a review) between this tick and the reservation
  for (const a of out.actions) {
    const r = await perform(fx, a, run);
    if (a.type === 'launch' && (r?.threadId || r?.orphaned)) launched += 1;
    if (r?.skipped === 'cap reached') capped.push(a.unit);
    if (r?.note) run.notes.push(r.note);
    run.notes.push(...(r?.notes ?? []));
  }
  const slotWaiting = [...new Set([...out.report.slotWaiting, ...capped])];
  return { report: { ...out.report, noSlots: slotWaiting.length > 0, slotWaiting }, launched };
}

// The decision line, then `settle:` (threads done for good, to settle in T3) when there is one, then notes and details.
async function finish(ctx, run, out) {
  let line = null;
  try {
    line = settleLine(settleList({ ...(await readPlanFiles(projectDir(ctx.cwd))), threads: byId(run.listed ?? []) }));
  } catch {
    line = null; // advice only: an unreadable file must not hide the decision
  }
  // decision line, then the playbook line (a kit update), then settle: neither is a note, neither is ever trimmed
  const lead = [out[0], ...[run.playbookLine, line].filter(Boolean)];
  return withNotes([...lead, ...out.slice(1)], run.notes, 7, lead.length);
}

async function loop(ctx, run, maxSeconds) {
  const deadline = ctx.now() + maxSeconds * 1000;
  const sleep = ctx.sleep ?? realSleep;
  for (;;) {
    const { report, launched } = await poll(run);
    const state = await readState(ctx.cwd);
    const lines = decide({
      plan: run.plan, report, state, launched, goal: run.config.goal,
    });
    const left = deadline - ctx.now();
    const out = lines ?? (left <= 0 ? timeoutLines(run.plan, state, report, run.cap, run.config.cap) : null);
    if (out) return finish(ctx, run, out);
    await sleep(Math.min(run.pollMs, left));
  }
}

export async function wait(args, ctx) {
  const { flags } = parseFlags(args, { value: ['max-seconds'] }, 'wait');
  const maxSeconds = flags['max-seconds'] === undefined ? 480 : Number(flags['max-seconds']);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw usage('wait: --max-seconds must be a positive integer');
  await assertNotArchiving(ctx.cwd);
  const prepared = await prepare(ctx);
  const run = { ...prepared, unknown: new Set(), notes: [prepared.capNote, prepared.evidence].filter(Boolean) }; // once per call
  const lockFile = runnerLockPath(ctx.cwd);
  let lines;
  try {
    lines = await withLock(lockFile, () => loop(ctx, run, maxSeconds), { timeoutMs: 0 });
  } catch (e) {
    if (!e.message.startsWith(`lock busy: ${lockFile}`)) throw e;
    const held = await readJson(lockFile, null);
    throw new CliError(`another orq wait is running (pid ${held?.pid ?? 'unknown'})`, 5);
  }
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
