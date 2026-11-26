// What orq leaves on disk, removed once nothing uses it: worktrees on orq/* branches of finished work of THIS project
// (their branches stay; uncommitted work is first saved under .orq/salvage/), gate checkouts no gate uses, and
// registrations of worktrees whose directory is gone. Only branches this project's ledgers, reviews or decisions
// name: another orq project in a linked worktree, or a person's own orq/* worktree, is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reduce, unitOf } from './ledger.mjs';
import { listLeases } from './leases.mjs';
import { withLock } from './lock.mjs';
import { ACTIVE } from './t3.mjs';
import { HARDEN } from './git.mjs';
import { lastSafeLine } from './gaterun.mjs';
import { gateLeftovers, removeGate } from './gate-leftovers.mjs';
import { archivedDirs, readPlanFiles } from './settle.mjs';
import { removeArgs } from './worktree-cleanup.mjs';
import { loadProjectConfig } from './config.mjs';
import { repairShares } from './share.mjs';
import { diskBytes, pruneSalvage, savePatch } from './salvage.mjs';
import {
  archiveRoot, cleanupLockPath, integrationDir, leasesDir, projectConfigPath, projectDir, salvageDir,
} from './paths.mjs';

export const ENDED = ['integrated', 'dropped'];
const LIVE = ['running', 'starting']; // a review or decision whose thread is (about to be) at work
const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p);

// branch -> { threads, live, dropped } for one plan's files; `current`: the running plan, whose open work is live.
function planBranches({ events, reviews, asks }, current) {
  const state = reduce(events);
  const id = state.plan.planId;
  const out = new Map();
  for (const e of events) {
    if (e.type !== 'launched' || !e.branch) continue;
    const s = unitOf(state, e.unit).state;
    const had = out.get(e.branch)?.threads ?? [];
    out.set(e.branch, { threads: [...had, e.threadId], live: current && !ENDED.includes(s), dropped: s === 'dropped' });
  }
  const side = (list, kind) => (Array.isArray(list) ? list : []).filter(Boolean).forEach((r) => {
    const k = { threads: r.threadId ? [r.threadId] : [], live: current && LIVE.includes(r.status), dropped: false };
    // a decision records its branch; before that was recorded, only one asked in a running plan had a known one
    if (kind === 'ask' && r.branch) out.set(r.branch, k);
    else if (id) out.set(`orq/${id}/${kind}-${r.n}`, k);
  });
  side(reviews?.reviews, 'review');
  side(asks?.asks, 'ask');
  return out;
}

// An archive whose files cannot be read is skipped with a note; its worktrees then count as unknown and stay.
async function archivedBranches(fx) {
  const notes = [];
  const maps = await Promise.all((await archivedDirs(archiveRoot(fx.cwd))).map(async (dir) => {
    try {
      return planBranches(await readPlanFiles(dir), false);
    } catch {
      notes.push(`note: skipped archive ${path.basename(dir)}: its files cannot be read`);
      return new Map();
    }
  }));
  return { maps, notes };
}

async function readFacts(fx, threads) {
  const current = await readPlanFiles(projectDir(fx.cwd));
  const { maps, notes } = await archivedBranches(fx);
  // a branch named by two plans' files counts as both
  const known = new Map();
  for (const [k, v] of [...maps, planBranches(current, true)].flatMap((m) => [...m])) {
    const had = known.get(k);
    known.set(k, had ? { threads: [...had.threads, ...v.threads], live: had.live || v.live, dropped: had.dropped || v.dropped } : v);
  }
  const busy = (threads ?? []).filter((t) => ACTIVE.includes(t.status));
  return {
    state: reduce(current.events), known, notes,
    leased: new Set((await listLeases(leasesDir(fx.env))).map((l) => l.threadId)),
    threads: threads && Object.fromEntries(threads.map((t) => [t.id, t])),
    busyAt: new Set(busy.flatMap((t) => [t.branch, t.worktreePath && real(t.worktreePath)]).filter(Boolean)), // known or not
  };
}

// null when the worktree can go, else why it stays.
function keepReason(w, f) {
  const known = f.known.get(w.branch);
  if (!known) return 'no ledger of this project names its branch'; // a launch being recorded, or not this project's
  if (w.locked) return 'locked';
  if (known.live) return 'in use';
  if (f.busyAt.has(w.branch) || f.busyAt.has(w.path)) return 'T3 shows a thread at work in it';
  if (known.threads.some((t) => f.leased.has(t))) return 'its thread holds a lease';
  const recorded = known.threads.map((t) => f.threads?.[t]?.worktreePath).filter(Boolean).map(real);
  if (recorded.length && !recorded.includes(w.path)) return 'it is not the worktree T3 recorded for its thread';
  // a dropped unit's thread is left running by `orq unit drop`: only T3 can tell it has stopped
  if (f.threads === null ? known.dropped : known.threads.some((t) => ACTIVE.includes(f.threads[t]?.status))) return 'its thread may still run';
  return null;
}

function candidates(fx, f) {
  const skip = new Set([fx.cwd, integrationDir(fx.cwd)].map(real));
  return fx.git.listWorktrees(fx.cwd)
    .filter((w) => w.branch?.startsWith('refs/heads/orq/') && !w.branch.endsWith('/integration') && !skip.has(w.path))
    .map((w) => ({ ...w, branch: w.branch.slice('refs/heads/'.length) }))
    .filter((w) => keepReason(w, f) === null);
}

const prune = (cwd) => spawnSync('git', [...HARDEN, 'worktree', 'prune'], { cwd }); // registrations of missing paths

function removeWorktree(cwd, dir, force) {
  const args = force ? [...HARDEN, 'worktree', 'remove', '--force', '--end-of-options', dir] : removeArgs(dir);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? null : lastSafeLine(r.stderr || r.error?.message || `exit ${r.status}`);
}

// Salvage (with force), then remove. When git refused before touching it (still registered), its patch is dropped so
// the next sweep does not save it twice; when git removed part of it, the patch is all that is left and stays.
function removeOne(fx, w, { force, measure }) {
  const bytes = measure ? diskBytes(w.path) : 0;
  const saved = force ? savePatch(fx.cwd, w, fx.now()) : { patch: null, skipped: 0 };
  if (saved.error) return saved;
  const error = removeWorktree(fx.cwd, w.path, force);
  if (error && saved.patch && fx.git.listWorktrees(fx.cwd).some((x) => x.path === w.path)) fs.rmSync(path.join(fx.cwd, saved.patch), { force: true });
  return error ? { error } : {
    path: w.path, branch: w.branch, bytes, ...saved,
  };
}

// The dry run: what the run would remove and what it would keep for want of a safe patch. Changes nothing.
function preview(fx, found, gates, force, notes) {
  const checked = found.map((w) => ({ w, why: force ? savePatch(fx.cwd, w, 0, true).error : undefined }));
  return {
    removed: checked.filter((c) => !c.why).map(({ w }) => ({ path: w.path, branch: w.branch, patch: null })),
    gates: gates.map((g) => ({ path: g })),
    kept: checked.filter((c) => c.why).map(({ w, why }) => ({ path: w.path, why })),
    freed: 0, left: 0, notes,
  };
}

async function clean(fx, {
  threads, force, dryRun, measure, budgetMs, clock,
}) {
  if (!dryRun) prune(fx.cwd);
  const f = await readFacts(fx, threads);
  const found = candidates(fx, f);
  if (dryRun) return preview(fx, found, gateLeftovers(fx.cwd, f.state), force, f.notes);
  const deadline = clock() + budgetMs; // what is left goes on the next run
  const timeUp = () => clock() >= deadline;
  const results = [];
  let left = 0;
  for (const w of found) {
    if (timeUp()) left += 1;
    else results.push({ path: w.path, ...removeOne(fx, w, { force, measure }) });
  }
  for (const g of gateLeftovers(fx.cwd, f.state)) { // listed after the worktrees went; each is checked again before it goes
    if (timeUp()) left += 1;
    else results.push({ gate: true, path: g, ...(await removeGate(fx.cwd, g, measure)) });
  }
  prune(fx.cwd);
  // links a removed worktree's pnpm wrote into the shared directories through its own link now dangle
  if (results.length) repairShares(fx.cwd, (await loadProjectConfig(projectConfigPath(fx.cwd)).catch(() => ({}))).share ?? []);
  pruneSalvage(salvageDir(fx.cwd), fx.now());
  const ok = results.filter((r) => !r.error);
  return {
    removed: ok.filter((r) => !r.gate),
    gates: ok.filter((r) => r.gate),
    kept: results.filter((r) => r.error).map((r) => ({ path: r.path, why: r.error })),
    freed: ok.reduce((n, r) => n + r.bytes, 0),
    left,
    notes: f.notes,
  };
}

/**
 * Remove every orq worktree of this project no live work uses, and gate leftovers. threads: T3's rows when known;
 * force: false runs a plain `git worktree remove` (no salvage; git keeps a dirty one); measure: false skips the sizes;
 * budgetMs: no new removal starts after it (by `clock`). One cleanup at a time.
 * -> { removed: [{path, branch, bytes, patch, skipped}], gates: [{path, bytes}], kept: [{path, why}], freed, left, notes }
 *  | { busy: true }
 */
export async function cleanAll(fx, {
  threads = null, force = true, dryRun = false, measure = true, budgetMs = Infinity, clock = Date.now,
} = {}) {
  try {
    return await withLock(cleanupLockPath(fx.cwd), () => clean(fx, {
      threads, force, dryRun, measure, budgetMs, clock,
    }), { timeoutMs: 0 });
  } catch (e) {
    if (String(e.message).startsWith('lock busy')) return { busy: true };
    throw e;
  }
}
