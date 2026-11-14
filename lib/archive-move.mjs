// The crash-safe part of `orq plan archive`. Under the project lock a marker (.orq/archiving.json) is written
// FIRST: while it exists every other command refuses (ledger.assertNotArchiving), so the plan state cannot change
// until the archive completes. The state is copied into a staging directory that is renamed into place (whole or
// not at all); the live ledger is byte-compared with the archived copy before anything is deleted; the originals
// go ledger last, and the marker is removed LAST. A re-run reads the marker and finishes from wherever it stopped.
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './store.mjs';
import {
  archiveRoot, archivingPath, ledgerPath, projectDir,
} from './paths.mjs';

export const PLAN_STATE = ['plan.json', 'units', 'orders', 'reviews.json', 'asks.json', 'summary.md', 'ledger.jsonl']; // ledger last
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

export class ArchiveRefused extends Error {}

// Appended to any failure once the marker exists: the project stays frozen, so say how to get out.
export const wayOut = (name) => 'The project is frozen until this finishes. Fix the cause and run "orq plan archive" again. '
  + 'To unfreeze without archiving, delete .orq/archiving.json: whatever plan state is still under .orq/ stays in use, '
  + `and a partial copy may remain under .orq/archive/${name}/.`;

export const exists = (f) => fs.stat(f).then(() => true, (e) => {
  if (e.code === 'ENOENT') return false;
  throw e;
});

async function bytes(file) {
  try {
    return await fs.readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// `base`, or `base-2`, `base-3`, … when an earlier archive already owns the name.
async function freeName(cwd, base) {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(path.join(archiveRoot(cwd), name)))) return name;
  }
}

// keep: plan-state paths that belong to the next request (plan.json replaced before the archive): plan.json is
// neither archived nor removed; the work orders are archived and also left in place.
export async function writeMarker(cwd, {
  planId, base, now, keep = [],
}) {
  const marker = {
    planId, name: await freeName(cwd, base), startedAt: now, keep,
  };
  await writeJsonAtomic(archivingPath(cwd), marker);
  return marker;
}

async function copyToArchive(cwd, name, now, onStep, keep) {
  const final = path.join(archiveRoot(cwd), name);
  if (await exists(final)) return; // renamed into place by the interrupted run
  const staging = path.join(archiveRoot(cwd), `.${name}.tmp`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  for (const f of PLAN_STATE.filter((x) => !(x === 'plan.json' && keep.includes(x)))) {
    const from = path.join(projectDir(cwd), f);
    if (await exists(from)) await fs.cp(from, path.join(staging, f), { recursive: true });
  }
  await writeJsonAtomic(path.join(staging, 'archive.json'), { name, archivedAt: now });
  await onStep('copied');
  await fs.rename(staging, final);
}

export async function moveState(cwd, marker, now, onStep) {
  if (!NAME.test(marker.name ?? '')) throw new ArchiveRefused(`invalid archive name "${marker.name}" in ${archivingPath(cwd)}`);
  const keep = Array.isArray(marker.keep) ? marker.keep : [];
  await copyToArchive(cwd, marker.name, now, onStep, keep);
  await onStep('renamed');
  const live = await bytes(ledgerPath(cwd));
  const kept = await bytes(path.join(archiveRoot(cwd), marker.name, 'ledger.jsonl'));
  if (live !== null && (kept === null || !live.equals(kept))) {
    throw new ArchiveRefused(`archive mismatch for ${marker.name}: .orq/ledger.jsonl differs from .orq/archive/${marker.name}/ledger.jsonl; nothing deleted`);
  }
  for (const f of PLAN_STATE.filter((x) => !keep.includes(x))) {
    await fs.rm(path.join(projectDir(cwd), f), { recursive: true, force: true });
    await onStep(`removed ${f}`);
  }
  await fs.rm(path.join(projectDir(cwd), 'gate'), { recursive: true, force: true });
  await onStep('before marker removal');
  await fs.rm(archivingPath(cwd), { force: true });
}
