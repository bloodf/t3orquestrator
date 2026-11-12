import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readState, unitOf } from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
import { renderSummary } from '../summary.mjs';
import { underOrq } from '../plan.mjs';
import { readReviews } from '../review.mjs';
import { readJson } from '../store.mjs';
import { gateFile, planPath, projectConfigPath } from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

const isDir = (f) => { try { return statSync(f).isDirectory(); } catch { return false; } };
const DEFAULT_OUT = '.orq/summary.md';

export async function summary(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['out'] }, 'summary');
  if (positional.length > 0) throw usage('summary: usage: summary [--out <file>]');
  const out = flags.out ?? DEFAULT_OUT;
  const file = path.join(ctx.cwd, out);
  if (!/^\.orq\/[^/]+\.md$/.test(path.posix.normalize(out)) || !underOrq(out, ctx.cwd) || isDir(file)) {
    throw usage('summary: --out must be a .md file directly under .orq/');
  }
  const plan = await readJson(planPath(ctx.cwd), null);
  if (!Array.isArray(plan?.units)) throw new CliError(`no plan at ${planPath(ctx.cwd)}; run "orq plan check"`);
  const state = await readState(ctx.cwd);
  if (state.plan.planId === null) throw new CliError('summary: plan has not started', 4);
  const gates = {};
  for (const s of plan.units) {
    const u = unitOf(state, s.id);
    if (u.attempt > 0) gates[s.id] = await readJson(gateFile(ctx.cwd, s.id, u.attempt, 'json'), null);
  }
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const text = renderSummary({
    plan, state, gates, reviews: await readReviews(ctx.cwd), checks: config.checks.full,
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  ctx.stdout.write(`summary: ${out} (${text.trimEnd().split('\n').length} lines)\n`);
  return 0;
}
