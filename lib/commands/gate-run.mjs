// Internal: run one gate and write its result atomically. Spawned detached by `orq wait`.
import fs from 'node:fs/promises';
import { runGate, defaultRun } from '../gate.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import {
  assertNotArchiving, readState, unitOf, FINAL,
} from '../ledger.mjs';
import { loadProjectConfig, DEFAULT_FINAL_TIMEOUT_MINUTES } from '../config.mjs';
import { readJson, writeJsonAtomic } from '../store.mjs';
import {
  gateFile, gateWorkDir, planPath, projectConfigPath,
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
    const result = await runGate({
      repo: ctx.cwd, headSha, git: createGit({ exec: ctx.deps.gitExec ?? gitExec }), run: ctx.deps.run ?? defaultRun,
      workDir: gateWorkDir(ctx.cwd, id), ...s,
    });
    await writeJsonAtomic(gateFile(ctx.cwd, id, attempt, 'json'), id === FINAL ? withTimeoutAdvice(result, s.timeoutMs) : result);
    ctx.stdout.write(`gate ${id} attempt ${attempt}: ${result.verdict}${result.cleanup ? ` (checkout not removed: ${result.cleanup})` : ''}\n`);
    return 0;
  } finally {
    // this gate is over: a pid file left behind would read as running once the OS reuses the pid
    await fs.rm(gateFile(ctx.cwd, id, attempt, 'pid'), { force: true });
  }
}
