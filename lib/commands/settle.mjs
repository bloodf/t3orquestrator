// orq settle [--all]: the threads orq started that are done for good and still unsettled in T3, one per line.
// T3 has no CLI to settle; the orchestrator settles each with its thread-organize tool.
import fs from 'node:fs';
import { createT3 } from '../t3.mjs';
import { assertNotArchiving } from '../ledger.mjs';
import { loadProjectConfig } from '../config.mjs';
import {
  archivedDirs, byId, readPlanFiles, settleList,
} from '../settle.mjs';
import {
  archiveRoot, ledgerPath, projectConfigPath, projectDir,
} from '../paths.mjs';
import { CliError, parseFlags, usage } from './common.mjs';

// Every finished, unsettled thread of the current plan and, with all, of the archived plans. One t3 call, no lock.
export async function unsettled(ctx, { all, current = true }) {
  const config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  if (!config.t3) throw new CliError('no usable t3; run "orq init"');
  const threads = byId(createT3({ bin: config.t3.bin, exec: ctx.deps.exec }).listThreads({ project: ctx.cwd }));
  const dirs = [
    ...(current && fs.existsSync(ledgerPath(ctx.cwd)) ? [projectDir(ctx.cwd)] : []),
    ...(all ? await archivedDirs(archiveRoot(ctx.cwd)) : []),
  ];
  const lists = await Promise.all(dirs.map(async (d) => settleList({ ...(await readPlanFiles(d)), threads })));
  return lists.flat();
}

export async function settle(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['all'] }, 'settle');
  if (positional.length > 0) throw usage('settle: usage: settle [--all]');
  await assertNotArchiving(ctx.cwd);
  const list = await unsettled(ctx, { all: flags.all === true });
  ctx.stdout.write(list.length ? `${list.map((x) => `${x.threadId} ${x.what}`).join('\n')}\n` : 'nothing to settle\n');
  return 0;
}
