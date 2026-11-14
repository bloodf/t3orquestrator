import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../store.mjs';
import { validatePlan } from '../plan.mjs';
import { planPath } from '../paths.mjs';
import { archivePlan, ArchiveRefused } from '../archive.mjs';
import { assertNotArchiving, readState, unitOf } from '../ledger.mjs';
import { planShape, shapeLines } from '../plan-shape.mjs';
import { replacedPlan } from '../plan-guard.mjs';
import { CliError, parseFlags, playbook, usage } from './common.mjs';
import { unsettled } from './settle.mjs';
import { readGoal } from './project.mjs';
import { goalLines } from '../goal.mjs';

export async function plan(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['json'] }, 'plan');
  if (positional.length === 1 && positional[0] === 'archive' && !flags.json) return archive(ctx);
  if (positional.length !== 1 || positional[0] !== 'check') throw usage('plan: usage: plan check [--json] | plan archive');
  await assertNotArchiving(ctx.cwd);
  const file = planPath(ctx.cwd);
  const data = await readJson(file, null);
  if (data === null) throw new CliError(`no plan at ${file}`);
  const state = await readState(ctx.cwd);
  const replaced = replacedPlan(data, state); // appending units, or editing a running goal, is fine
  if (replaced) {
    ctx.stdout.write(`error: ${replaced}\n`);
    return 4;
  }
  const at = (f) => path.join(ctx.cwd, f);
  const result = validatePlan(data, {
    cwd: ctx.cwd,
    jobs: playbook('routing.json').jobs,
    exists: (f) => fs.existsSync(at(f)),
    readFile: (f) => fs.readFileSync(at(f), 'utf8'),
  });
  // only a valid plan has units to look at: a malformed one is reported by its errors below
  const over = result.ok ? data.units.filter((u) => ['integrated', 'dropped'].includes(unitOf(state, u.id).state)).map((u) => u.id) : [];
  // printed, never fatal; nothing can be done about a unit that is finished, so it is not warned about again
  const kept = result.warnings.filter((w) => !over.some((id) => w.startsWith(`${id}: `)));
  const warnings = kept.map((w) => `warning: ${w}`);
  if (flags.json) ctx.stdout.write(`${JSON.stringify({ ...result, warnings: kept })}\n`);
  else if (result.ok) {
    const shape = shapeLines(planShape(data.units, over));
    ctx.stdout.write(`${[...warnings, ...shape, `plan ok: ${data.units.length} units, order: ${result.order.join(' ')}`].join('\n')}\n`);
  }
  else ctx.stdout.write(`${result.errors.map((e) => `error: ${e}`).join('\n')}\n`);
  return result.ok ? 0 : 4;
}

// After the archive, outside every lock: one t3 call says whether archived plans left threads to settle. Advice only.
async function settleHint(ctx) {
  try {
    return (await unsettled(ctx, { all: true, current: false })).length ? ['settle: run "orq settle --all"'] : [];
  } catch {
    return [];
  }
}

async function archive(ctx) {
  try {
    const lines = await archivePlan(ctx);
    ctx.stdout.write(`${[...lines, ...(await settleHint(ctx)), ...goalLines(await readGoal(ctx.cwd), 'archive')].join('\n')}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ArchiveRefused)) throw e;
    throw new CliError(e.message === 'nothing to archive' ? 'plan: nothing to archive' : `plan: cannot archive: ${e.message}`, 4);
  }
}
