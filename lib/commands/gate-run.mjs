// Internal: run one gate and write its result atomically. Spawned detached by `orq wait`.
import fs from 'node:fs/promises';
import { runGate, defaultRun } from '../gate.mjs';
import { createGit, defaultExec as gitExec } from '../git.mjs';
import {
  assertNotArchiving, readState, unitOf, FINAL,
} from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
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
    };
  }
  const plan = await readJson(planPath(cwd), null);
  const unit = plan?.units?.find((u) => u.id === id);
  if (!unit) throw new CliError(`gate-run: unit ${id} is not in the plan`);
  const setup = unit.setup === false ? null : config.checks.setup; // the unit opted out of the install step
  return { unit, baseSha: unitOf(state, id).baseSha, checks: { setup, unit: config.checks.unit } };
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
    await writeJsonAtomic(gateFile(ctx.cwd, id, attempt, 'json'), result);
    ctx.stdout.write(`gate ${id} attempt ${attempt}: ${result.verdict}\n`);
    return 0;
  } finally {
    // this gate is over: a pid file left behind would read as running once the OS reuses the pid
    await fs.rm(gateFile(ctx.cwd, id, attempt, 'pid'), { force: true });
  }
}
