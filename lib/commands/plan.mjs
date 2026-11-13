import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../store.mjs';
import { validatePlan } from '../plan.mjs';
import { planPath } from '../paths.mjs';
import { archivePlan, ArchiveRefused } from '../archive.mjs';
import { assertNotArchiving } from '../ledger.mjs';
import { CliError, parseFlags, playbook, usage } from './common.mjs';

export async function plan(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['json'] }, 'plan');
  if (positional.length === 1 && positional[0] === 'archive' && !flags.json) return archive(ctx);
  if (positional.length !== 1 || positional[0] !== 'check') throw usage('plan: usage: plan check [--json] | plan archive');
  await assertNotArchiving(ctx.cwd);
  const file = planPath(ctx.cwd);
  const data = await readJson(file, null);
  if (data === null) throw new CliError(`no plan at ${file}`);
  const at = (f) => path.join(ctx.cwd, f);
  const result = validatePlan(data, {
    jobs: playbook('routing.json').jobs,
    exists: (f) => fs.existsSync(at(f)),
    readFile: (f) => fs.readFileSync(at(f), 'utf8'),
  });
  if (flags.json) ctx.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) ctx.stdout.write(`plan ok: ${data.units.length} units, order: ${result.order.join(' ')}\n`);
  else ctx.stdout.write(`${result.errors.map((e) => `error: ${e}`).join('\n')}\n`);
  return result.ok ? 0 : 4;
}

async function archive(ctx) {
  try {
    const lines = await archivePlan(ctx);
    ctx.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ArchiveRefused)) throw e;
    throw new CliError(e.message === 'nothing to archive' ? 'plan: nothing to archive' : `plan: cannot archive: ${e.message}`, 4);
  }
}
