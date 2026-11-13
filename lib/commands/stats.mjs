import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNotArchiving } from '../ledger.mjs';
import { readLines } from '../store.mjs';
import { archiveRoot, ledgerPath } from '../paths.mjs';
import { computeStats, renderStats } from '../stats.mjs';
import { parseFlags, usage } from './common.mjs';

async function archivedLedgers(cwd) {
  const names = await fs.readdir(archiveRoot(cwd)).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return names.filter((n) => !n.startsWith('.')).sort().map((n) => path.join(archiveRoot(cwd), n, 'ledger.jsonl'));
}

export async function stats(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['all', 'json'] }, 'stats');
  if (positional.length > 0) throw usage('stats: usage: stats [--all] [--json]');
  await assertNotArchiving(ctx.cwd);
  const files = [...(flags.all ? await archivedLedgers(ctx.cwd) : []), ledgerPath(ctx.cwd)];
  const events = (await Promise.all(files.map(readLines))).flat();
  const result = computeStats(events);
  ctx.stdout.write(flags.json ? `${JSON.stringify(result)}\n` : renderStats(result));
  return 0;
}
