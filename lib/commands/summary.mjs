import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertNotArchiving, readState, reduce, unitOf,
} from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
import { renderSummary } from '../summary.mjs';
import { underOrq } from '../plan.mjs';
import { readReviews } from '../review.mjs';
import { readJson, readLines } from '../store.mjs';
import { archiveRoot } from '../paths.mjs';
import { gateFile, planPath, projectConfigPath } from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

const isDir = (f) => { try { return statSync(f).isDirectory(); } catch { return false; } };
const DEFAULT_OUT = '.orq/summary.md';

// An archived plan, rendered read-only to stdout from .orq/archive/<planId>/ (same layout as .orq/).
async function archived(id, ctx) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw usage('summary: --plan must be an archived plan id');
  const dir = path.join(archiveRoot(ctx.cwd), id);
  const plan = await readJson(path.join(dir, 'plan.json'), null);
  if (!Array.isArray(plan?.units)) throw new CliError(`summary: no archived plan ${id}`);
  const state = reduce(await readLines(path.join(dir, 'ledger.jsonl')));
  const gates = {};
  for (const s of plan.units) {
    const u = unitOf(state, s.id);
    if (u.attempt > 0) gates[s.id] = await readJson(path.join(dir, 'units', s.id, `gate-${u.attempt}.json`), null);
  }
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  const reviews = await readJson(path.join(dir, 'reviews.json'), { reviews: [] });
  ctx.stdout.write(renderSummary({
    plan, state, gates, reviews, checks: config.checks.full,
  }));
  return 0;
}

export async function summary(args, ctx) {
  const { flags, positional } = parseFlags(args, { value: ['out', 'plan'] }, 'summary');
  await assertNotArchiving(ctx.cwd);
  if (positional.length > 0) throw usage('summary: usage: summary [--out <file>] | summary --plan <archived planId>');
  if (flags.plan !== undefined) {
    if (flags.out !== undefined) throw usage('summary: --plan prints to stdout; it does not take --out');
    return archived(flags.plan, ctx);
  }
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
