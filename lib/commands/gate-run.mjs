// Internal: run one gate and write its result atomically. Spawned detached by `orq wait`.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { runGate, defaultRun } from '../gate.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import {
  assertNotArchiving, readState, unitOf, FINAL,
} from '../ledger.mjs';
import { loadProjectConfig, DEFAULT_FINAL_TIMEOUT_MINUTES } from '../config.mjs';
import { readJson, writeJsonAtomic } from '../store.mjs';
import {
  gateFile, gateWorkDir, planPath, projectConfigPath, unitDir,
} from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

async function spec(cwd, id, state, config) {
  if (id === FINAL) {
    return {
      unit: { id, paths: ['**'], forbidden: [], evidence: null },
      baseSha: state.plan.baseSha,
      checks: { setup: config.checks.setup, unit: config.checks.full },
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
  const setup = unit.setup === false ? null : config.checks.setup; // the unit opted out of the install step
  return {
    unit, baseSha: unitOf(state, id).baseSha, checks: { setup, unit: config.checks.unit }, share: { paths: config.share ?? [], unit },
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

export async function gateRun(args, ctx) {
  const { positional } = parseFlags(args, {}, 'gate-run');
  const [id, attemptText, headSha] = positional;
  const attempt = Number(attemptText);
  if (positional.length !== 3 || !Number.isInteger(attempt) || attempt < 1) {
    throw usage('gate-run: usage: gate-run <unit> <attempt> <headSha>');
  }
  await assertNotArchiving(ctx.cwd);
  try {
    const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
    const s = await spec(ctx.cwd, id, await readState(ctx.cwd), config);
    // a final run keeps its whole output while it runs: the 15 lines in the result rarely name the failing test,
    // and without them the orchestrator reruns the full suite to find it. Kept only when the run failed.
    const head = `head-${headSha.slice(0, 12)}`;
    const logFile = id === FINAL ? path.join(unitDir(ctx.cwd, FINAL), `${head}.log`) : undefined;
    if (logFile) {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.rm(logFile, { force: true });
    }
    const result = await runGate({
      repo: ctx.cwd, headSha, git: createGit({ exec: ctx.deps.gitExec ?? gitExec }), run: ctx.deps.run ?? defaultRun,
      workDir: gateWorkDir(ctx.cwd, id), ...s, logFile,
    });
    const failed = logFile && result.verdict === 'fail' && fsSync.existsSync(logFile);
    // a pass makes every older head's log moot: only failures since the last pass are worth reading
    if (logFile && result.verdict === 'pass') await removeLogs(path.dirname(logFile));
    else if (logFile && !failed) await fs.rm(logFile, { force: true }).catch(() => {});
    const out = id === FINAL ? {
      ...withTimeoutAdvice(result, s.timeoutMs), checks: s.checks.unit, ...(failed ? { output: path.relative(ctx.cwd, logFile) } : {}),
    } : result;
    // a final result is also kept per head: the next run (continuous mode starts one at once) removes gate-1.json
    if (id === FINAL) await writeJsonAtomic(path.join(unitDir(ctx.cwd, FINAL), `${head}.json`), out);
    await writeJsonAtomic(gateFile(ctx.cwd, id, attempt, 'json'), out);
    ctx.stdout.write(`gate ${id} attempt ${attempt}: ${result.verdict}${result.cleanup ? ` (checkout not removed: ${result.cleanup})` : ''}\n`);
    return 0;
  } finally {
    // this gate is over: a pid file left behind would read as running once the OS reuses the pid
    await fs.rm(gateFile(ctx.cwd, id, attempt, 'pid'), { force: true });
  }
}
