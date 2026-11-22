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
import { CliError, parseFlags, playbook, usage } from './common.mjs';
import { applyUsage, readUsage } from '../usage-source.mjs';
import { provenProject } from '../archive-move.mjs';
import { decide, evidenceNote, staleNote, timeoutLines, withNotes } from './wait-report.mjs';
import { staleBase, syncBase } from './wait-sync.mjs';
import { sweepNotes } from '../sweep.mjs';
import { playbookNotice } from './kit-info.mjs';
import { readGoal } from './project.mjs';
import { takeInbox } from './inbox.mjs';
import {
  byId, readPlanFiles, settleLine, settleList,
} from '../settle.mjs';
import { holdText, machineAdmission } from '../admission.mjs';
import { attention, ownQueue } from '../attention.mjs';

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function prepare(ctx) {
  const plan = await readJson(planPath(ctx.cwd), null);
  const at = (f) => path.join(ctx.cwd, f);
  const rules = playbook('routing.json');
  const checked = plan && validatePlan(plan, {
    cwd: ctx.cwd, jobs: rules.jobs, exists: (f) => fs.existsSync(at(f)), readFile: (f) => fs.readFileSync(at(f), 'utf8'),
  });
  if (!checked?.ok) {
    // only a missing plan is told to plan its next part: an invalid one may have units in flight
    const goal = plan === null ? await readGoal(ctx.cwd).catch(() => undefined) : undefined;
    throw new CliError(['no valid plan; run "orq plan check"', ...goalLines(goal, 'noPlan')].join('\n'), 4);
  }
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
    git: createGit({ exec: ctx.deps.gitExec ?? gitExec }), spawnGate: ctx.deps.spawnGate ?? spawnGateRun, isAlive: ctx.deps.isAlive ?? pidAlive, deps: ctx.deps, cleanup: config.cleanup !== false,
  };
  const tickConfig = defined({
    stallMinutes: config.stallMinutes, gateConcurrency: config.gateConcurrency, leaseTtlMinutes: config.leaseTtlMinutes,
    perInstanceLimit: machine.perInstanceLimit, continuous: config.autonomy === 'continuous' || undefined, proven: (await provenProject(ctx.cwd)) || undefined,
  });
  return {
    fx, plan, config, cap, rules, tickConfig, pollMs: (config.pollSeconds ?? 15) * 1000, machine,
    capNote: overrideNote({ machine: facts, config: capConfig }), playbookLine: playbookNotice(ctx, config), evidence: evidenceNote(checked.warnings),
  };
}

async function collectGates(fx, plan, state, continuous) {
  const out = {};
  for (const { id } of plan.units) {
    const u = unitOf(state, id);
    if (u.state === 'gating' && u.gateStarts > 0) out[id] = await collectGate(fx, id, u.attempt, u.headSha);
  }
  const p = state.plan;
  // continuous: a final run belongs to the head it started on, wherever the integration head is now
  const head = continuous ? p.finalHead : p.integrationHead;
  const started = continuous ? (p.finalHeadStarts ?? 0) > 0 : p.finalGateStarts > 0;
  if (started && p.final?.head !== head) out[FINAL] = await collectGate(fx, FINAL, 1, head);
  return out;
}

// An early final-fail is reported once per head: record it, so the next one printed is for a newer head.
async function noteFinalFail(fx, lines, state) {
  const head = state.plan.final?.head;
  if (!lines[0].startsWith('final-fail: ') || !head) return;
  await commit(fx.cwd, (s) => (s.plan.noted === head ? [] : [{ type: 'final-noted', unit: null, at: fx.now(), head }]));
}

// Once per call per thread: T3 reported a status this version does not know (the thread is treated as running).
function noteUnknownStatus(run, threads) {
  for (const t of threads) {
    if (!t.unknownStatus || run.unknown.has(t.id)) continue;
    run.unknown.add(t.id);
    run.notes.push(`note: thread ${t.id} has status "${t.unknownStatus}" that this version does not know; treated as running`);
  }
}

// This machine's pressure and protected services, read on every poll. It must never stop the plan: unreadable is
// said once and nothing is held.
async function admit(run) {
  try {
    return await machineAdmission(run.fx, run.machine);
  } catch (e) {
    const note = `note: this machine's pressure could not be read (${String(e.message).split('\n')[0]}); nothing is held for it`;
    if (!run.notes.includes(note)) run.notes.push(note);
    return null;
  }
}

// Own queue, pending requests and peers are advice: a failure is said once and the plan goes on. What could not be
// recorded as told is not told, so a failing disk cannot make every call return at once.
const advice = (run, what, promise) => promise.catch((e) => {
  const note = `note: ${what} could not be checked (${e.code ?? String(e.message).split('\n')[0]})`; // a code: the message names a temp file
  if (!run.notes.includes(note)) run.notes.push(note);
  return null;
});

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
  const gates = await collectGates(fx, plan, before, run.tickConfig.continuous);
  const usage = await readUsage(fx, await readJson(registryPath(fx.env), emptyRegistry()), run.machine); // outside the lock
  run.admission = await admit(run); // probes outside the lock
  const hold = run.admission?.held ? { reasons: run.admission.reasons } : null;
  let out;
  await commit(fx.cwd, async (state) => {
    const leases = await listLeases(leasesDir(fx.env));
    const registry = applyUsage(await readJson(registryPath(fx.env), emptyRegistry()), usage, run.machine, fx.now());
    out = tick({
      plan, state, threads, registry, rules: run.rules, leases, cap: run.cap, projectCap: run.config.cap, project: fx.cwd, gates, config: run.tickConfig, now: fx.now(), hold,
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
    run.notes.push(...[r?.note, ...(r?.notes ?? [])].filter(Boolean));
  }
  const slotWaiting = [...new Set([...out.report.slotWaiting, ...capped])];
  return { report: { ...out.report, noSlots: slotWaiting.length > 0, slotWaiting }, launched };
}

// The decision line, then `settle:` (threads done for good, to settle in T3) when there is one, then notes and details.
async function finish(ctx, run, out) {
  let line = null;
  try {
    line = settleLine(settleList({ ...(await readPlanFiles(projectDir(ctx.cwd))), threads: byId(run.listed ?? []) }));
  } catch { /* advice only: an unreadable file must not hide the decision */ }
  // decision line, then the playbook line (a kit update), then settle: neither is a note, neither is ever trimmed
  const lead = [out[0], ...[run.playbookLine, line].filter(Boolean)];
  return withNotes([...lead, ...out.slice(1)], run.notes, 7, lead.length);
}

async function loop(ctx, run, maxSeconds) {
  const deadline = ctx.now() + maxSeconds * 1000;
  const sleep = ctx.sleep ?? realSleep;
  for (;;) {
    // within one poll of its arrival; the thread's own queue within a minute
    const message = await takeInbox(ctx, run) ?? await advice(run, 'this thread\'s own queue', ownQueue(ctx, run));
    if (message) return message;
    const { continuous } = run.tickConfig;
    if (continuous) await syncBase(ctx, run); // before the tick: a merged base is this poll's integration head
    const { report, launched } = await poll(run);
    const state = await readState(ctx.cwd);
    if (run.fx.cleanup) run.notes.push(...await sweepNotes(run.fx, state, run.listed)); // after integrations, before any return
    const waits = await advice(run, 'pending requests and peers', attention(ctx, run, state, report)); // a request, or a peer with room
    if (waits) return finish(ctx, run, waits);
    const stale = continuous ? staleBase(ctx, run.config, state.plan) : null;
    const lines = decide({ plan: run.plan, report, state, launched, goal: run.config.goal, continuous, stale });
    const note = stale && !lines?.[0].startsWith('ship-blocked:') ? staleNote(state.plan.green, stale) : null; // once per call
    if (note && !run.notes.includes(note)) run.notes.push(note);
    if (lines && continuous) await noteFinalFail(run.fx, lines, state);
    const left = deadline - ctx.now();
    const out = lines ?? (left <= 0 ? timeoutLines(run.plan, state, report, run.cap, run.config.cap, ctx.now(), continuous) : null);
    // a timeout says it in its own `waiting:` line
    if (lines && report.held) run.notes.unshift(`note: this machine starts nothing new (${holdText(run.admission, ctx.now())}); ${report.heldBack} launches or checks wait`);
    if (out) return finish(ctx, run, out);
    await sleep(Math.min(run.pollMs, left));
  }
}

// early: notes from the inbox check before the plan was read; they also follow a refusal.
async function runPlan(ctx, early, maxSeconds) {
  await assertNotArchiving(ctx.cwd);
  const prepared = await prepare(ctx).catch((e) => { throw early.length ? new CliError([e.message, ...early].join('\n'), e.exitCode) : e; });
  const run = { ...prepared, unknown: new Set(), notes: [...early, prepared.capNote, prepared.evidence].filter(Boolean) }; // once per call
  const lockFile = runnerLockPath(ctx.cwd);
  try {
    return await withLock(lockFile, () => loop(ctx, run, maxSeconds), { timeoutMs: 0 });
  } catch (e) {
    if (!e.message.startsWith(`lock busy: ${lockFile}`)) throw e;
    const held = await readJson(lockFile, null);
    throw new CliError(`another orq wait is running (pid ${held?.pid ?? 'unknown'})`, 5);
  }
}

export async function wait(args, ctx) {
  const { flags } = parseFlags(args, { value: ['max-seconds'] }, 'wait');
  const maxSeconds = flags['max-seconds'] === undefined ? 480 : Number(flags['max-seconds']);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1) throw usage('wait: --max-seconds must be a positive integer');
  const early = { notes: [] };
  const lines = await takeInbox(ctx, early) ?? await runPlan(ctx, early.notes, maxSeconds); // the inbox first: with or without a plan
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
