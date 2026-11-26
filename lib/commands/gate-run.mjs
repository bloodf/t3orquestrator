// Internal: run one gate and write its result atomically. Spawned detached by `orq wait`.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { runGate, defaultRun } from '../gate.mjs';
import { baselineOf, excuse } from '../baseline.mjs';
import { envFiles, gateEnv } from '../gate-env.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import {
  assertNotArchiving, readState, unitOf, FINAL,
} from '../ledger.mjs';
import {
  loadMachineConfig, loadProjectConfig, DEFAULT_FINAL_TIMEOUT_MINUTES, DEFAULT_UNIT_TIMEOUT_MINUTES,
} from '../config.mjs';
import { gatePrefix } from '../gate-priority.mjs';
import { createDepCache, onlyPnpmInstalls, realKeyOf } from '../dep-cache.mjs';
import { confirmGateLease, processStart, removeGateLease } from '../leases.mjs';
import { readJson, writeJsonAtomic } from '../store.mjs';
import { pnpmInstall } from '../share.mjs';
import {
  depCacheDir, gateFile, gateLeasesDir, gateWorkDir, machineConfigPath, planPath, projectConfigPath, unitDir,
} from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

// A pnpm project's checkout is never linked (share.mjs): without a setup step of its own the gate installs from the
// pnpm store, unless sharing was turned off (`share null`: the gate has always run without dependencies then).
const setupOf = (cwd, config) => config.checks.setup ?? (config.share === null ? null : pnpmInstall(cwd));

async function spec(cwd, id, state, config) {
  if (id === FINAL) {
    return {
      unit: { id, paths: ['**'], forbidden: [], evidence: null },
      baseSha: state.plan.baseSha,
      sinceSha: state.plan.green ?? null, // the last head that passed: the changed-file lists start there
      checks: { setup: setupOf(cwd, config), unit: config.checks.full },
      share: { paths: config.share ?? [], unit: null },
      // capped at a day: past 24.8 days Node runs a timer after 1 ms, and every step would time out at once
      timeoutMs: Math.min(config.finalTimeoutMinutes ?? DEFAULT_FINAL_TIMEOUT_MINUTES, 1440) * 60000,
      // a full suite that failed is not run again to tell flaky from real: that doubled every failed final gate
      // (15-20 minutes in a real project); the playbook has the orchestrator rerun the failing test instead
      retry: false,
    };
  }
  const plan = await readJson(planPath(cwd), null);
  const unit = plan?.units?.find((u) => u.id === id);
  if (!unit) throw new CliError(`gate-run: unit ${id} is not in the plan`);
  const setup = unit.setup === false ? null : setupOf(cwd, config); // the unit opted out of the install step
  return {
    unit, baseSha: unitOf(state, id).baseSha, checks: { setup, unit: config.checks.unit }, share: { paths: config.share ?? [], unit },
    timeoutMs: Math.min(config.unitTimeoutMinutes ?? DEFAULT_UNIT_TIMEOUT_MINUTES, 1440) * 60000,
  };
}

// A final gate that ran out of time is not a verdict on the work: say which setting moves the limit.
function withTimeoutAdvice(result, timeoutMs) {
  const raise = '"orq config set finalTimeoutMinutes <minutes>"';
  const advise = (f) => {
    if (f === 'checks timed out') return `${f} after ${timeoutMs / 60000} min: raise the limit with ${raise} or narrow checks.full, then "orq unit retry integration"`;
    return f.startsWith('setup timed out') ? `${f} (the limit is ${timeoutMs / 60000} min a step; ${raise} raises it)` : f;
  };
  return { ...result, failures: result.failures.map(advise) };
}

async function removeLogs(dir) {
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(names.filter((n) => /^head-[0-9a-f]{12}\.log$/.test(n)).map((n) => fs.rm(path.join(dir, n), { force: true }).catch(() => {}))); // never at the cost of the verdict
}

// A unit whose checks fail only what the final run on its base head failed is not failed for them (baseline.mjs).
// Never a fix unit: it exists to fix those failures.
async function baselined(cwd, result, s, logFile) {
  if (result.verdict !== 'fail' || s.unit.job === 'fix') return result;
  const text = (f) => fs.readFile(f, 'utf8').catch(() => null);
  const at = path.join(unitDir(cwd, FINAL), `head-${s.baseSha.slice(0, 12)}`);
  const base = await readJson(`${at}.json`, null).catch(() => null);
  return excuse(result, await text(logFile), base && { sha: s.baseSha, result: base, log: await text(`${at}.log`) });
}

export async function gateRun(args, ctx) {
  const { positional } = parseFlags(args, {}, 'gate-run');
  const [id, attemptText, headSha] = positional;
  const attempt = Number(attemptText);
  if (positional.length !== 3 || !Number.isInteger(attempt) || attempt < 1) {
    throw usage('gate-run: usage: gate-run <unit> <attempt> <headSha>');
  }
  await assertNotArchiving(ctx.cwd);
  const leaseId = ctx.env.ORQ_GATE_LEASE; // the machine gate budget's lease `orq wait` reserved for this gate
  await confirmGateLease(gateLeasesDir(ctx.env), leaseId, { pid: process.pid, pidStart: processStart(process.pid), startedAt: Date.now() }).catch(() => {});
  try {
    const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
    const s = await spec(ctx.cwd, id, await readState(ctx.cwd), config);
    // a final run keeps its whole output while it runs: the 15 lines in the result rarely name the failing test,
    // and without them the orchestrator reruns the full suite to find it. Kept only when the run failed.
    // A unit gate's output is read for its failing tests (baseline.mjs), then removed.
    const head = `head-${headSha.slice(0, 12)}`;
    const logFile = id === FINAL ? path.join(unitDir(ctx.cwd, FINAL), `${head}.log`) : gateFile(ctx.cwd, id, attempt, 'output.log');
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.rm(logFile, { force: true });
    const exec = ctx.deps.gitExec ?? gitExec;
    const git = createGit({ exec });
    const env = await gateEnv({
      git, cwd: ctx.cwd, id, attempt, baseSha: s.baseSha, headSha, job: s.unit.job, final: id === FINAL, sinceSha: s.sinceSha,
    });
    // machine settings only tune how the gate runs: an unreadable machine config must not cost the verdict
    const machine = await loadMachineConfig(machineConfigPath(ctx.env)).catch(() => ({}));
    const prefix = gatePrefix(machine.gatePriority, ctx.deps.gatePriority ?? {}); // low CPU and I/O priority
    const run = ctx.deps.run ?? defaultRun;
    const depCache = machine.depCache !== false && onlyPnpmInstalls(s.checks.setup) ? createDepCache({
      root: depCacheDir(ctx.env),
      keyOf: ctx.deps.depCacheKey ?? realKeyOf({
        git, repo: ctx.cwd, sha: headSha, setup: s.checks.setup, env: { ...process.env, ...env }, log: (line) => ctx.stdout.write(`${line}\n`),
      }),
      ...(ctx.deps.clone !== undefined ? { clone: ctx.deps.clone } : {}),
      log: (line) => ctx.stdout.write(`${line}\n`),
    }) : null;
    const result = await runGate({
      repo: ctx.cwd, headSha, git, run: (command, o) => run(command, { ...o, prefix }),
      workDir: gateWorkDir(ctx.cwd, id), ...s, logFile, env, depCache,
    });
    const final = id === FINAL;
    const failed = final && result.verdict === 'fail' && fsSync.existsSync(logFile);
    // a pass makes every older head's log moot: only failures since the last pass are worth reading
    if (final && result.verdict === 'pass') await removeLogs(path.dirname(logFile));
    else if (final && !failed) await fs.rm(logFile, { force: true }).catch(() => {});
    const out = final ? {
      ...withTimeoutAdvice(result, s.timeoutMs), checks: s.checks.unit,
      ...(failed ? { output: path.relative(ctx.cwd, logFile), baseline: baselineOf(await fs.readFile(logFile, 'utf8').catch(() => null)) } : {}),
    } : await baselined(ctx.cwd, result, s, logFile);
    // a final result is also kept per head: the next run (continuous mode starts one at once) removes gate-1.json
    if (id === FINAL) await writeJsonAtomic(path.join(unitDir(ctx.cwd, FINAL), `${head}.json`), out);
    await writeJsonAtomic(gateFile(ctx.cwd, id, attempt, 'json'), out);
    ctx.stdout.write(`gate ${id} attempt ${attempt}: ${result.verdict}${result.cleanup ? ` (checkout not removed: ${result.cleanup})` : ''}\n`);
    return 0;
  } finally {
    // this gate is over: a pid file left behind would read as running once the OS reuses the pid, and its slot in the
    // machine's gate budget is free (`orq wait` started it as this process: the lease is named by this pid)
    await fs.rm(gateFile(ctx.cwd, id, attempt, 'pid'), { force: true });
    await removeGateLease(gateLeasesDir(ctx.env), leaseId).catch(() => {});
    // read, never kept
    const done = [...(id === FINAL ? [] : [gateFile(ctx.cwd, id, attempt, 'output.log')]), ...envFiles(ctx.cwd, id, attempt)];
    await Promise.all(done.map((f) => fs.rm(f, { force: true }).catch(() => {})));
  }
}
