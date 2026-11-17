// What orq leaves on disk, removed once nothing uses it: worktrees on orq/* branches of finished work (their branches
// stay; uncommitted work is first saved under .orq/salvage/), gate checkouts no gate uses, and registrations of
// worktrees whose directory is gone. Picked by branch and path, never by guessing; never under the project lock.
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
import {
  diskBytes, formatBytes, salvagePatch, PATCH_CAP,
} from './salvage.mjs';
import {
  archiveRoot, cleanupLockPath, integrationDir, leasesDir, projectDir, salvageDir,
} from './paths.mjs';

export const ENDED = ['integrated', 'dropped'];
const LIVE = ['running', 'starting']; // a review or decision whose thread is (about to be) at work
const PRE_PLAN_ASK = /^orq\/ask-(\d+)(-[0-9a-z]+)?$/; // a decision asked before the plan started

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
    if (id) out.set(`orq/${id}/${kind}-${r.n}`, k);
    if (kind === 'ask') out.set(`ask:${r.n}`, k); // a decision asked before its plan started: orq/ask-<n>-<time>
  });
  side(reviews?.reviews, 'review');
  side(asks?.asks, 'ask');
  return out;
}

async function readFacts(fx, threads) {
  const current = await readPlanFiles(projectDir(fx.cwd));
  const archived = await Promise.all((await archivedDirs(archiveRoot(fx.cwd))).map(readPlanFiles));
  // keys can repeat across plans (a decision asked before its plan started is `ask:<n>`, and n restarts per plan)
  const known = new Map();
  for (const [k, v] of [...archived.map((f) => planBranches(f, false)), planBranches(current, true)].flatMap((m) => [...m])) {
    const had = known.get(k);
    known.set(k, had ? { threads: [...had.threads, ...v.threads], live: had.live || v.live, dropped: had.dropped || v.dropped } : v);
  }
  const busy = (threads ?? []).filter((t) => ACTIVE.includes(t.status));
  return {
    state: reduce(current.events), known,
    leased: new Set((await listLeases(leasesDir(fx.env))).map((l) => l.threadId)),
    threads: threads && Object.fromEntries(threads.map((t) => [t.id, t])),
    busyAt: new Set(busy.flatMap((t) => [t.branch, t.worktreePath]).filter(Boolean)), // T3 at work there, known or not
  };
}

// null when the worktree can go, else why it stays.
function keepReason(w, branch, f) {
  const known = f.known.get(branch) ?? f.known.get(`ask:${PRE_PLAN_ASK.exec(branch)?.[1]}`);
  if (w.locked) return 'locked';
  if (known?.live) return 'in use';
  if (f.busyAt.has(branch) || f.busyAt.has(w.path)) return 'T3 shows a thread at work in it';
  if (!known && f.state.plan.planId && branch.startsWith(`orq/${f.state.plan.planId}/`)) return 'not in the ledger yet';
  const threads = known?.threads ?? [];
  if (threads.some((t) => f.leased.has(t))) return 'its thread holds a lease';
  // a dropped unit's thread is left running by `orq unit drop`: only T3 can tell it has stopped
  if (f.threads === null ? known?.dropped : threads.some((t) => ACTIVE.includes(f.threads[t]?.status))) return 'its thread may still run';
  return null;
}

function candidates(fx, f) {
  const skip = new Set([fx.cwd, integrationDir(fx.cwd)].map((p) => (fs.existsSync(p) ? fs.realpathSync(p) : p)));
  return fx.git.listWorktrees(fx.cwd)
    .filter((w) => w.branch?.startsWith('refs/heads/orq/') && !w.branch.endsWith('/integration') && !skip.has(w.path))
    .map((w) => ({ ...w, branch: w.branch.slice('refs/heads/'.length) }))
    .filter((w) => keepReason(w, w.branch, f) === null);
}

const prune = (cwd) => spawnSync('git', [...HARDEN, 'worktree', 'prune'], { cwd }); // registrations of missing paths

function removeWorktree(cwd, dir, force) {
  const args = force ? [...HARDEN, 'worktree', 'remove', '--force', '--end-of-options', dir] : removeArgs(dir);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? null : lastSafeLine(r.stderr || r.error?.message || `exit ${r.status}`);
}

// The worktree's uncommitted work as .orq/salvage/<branch tail>-<ms>.patch -> { patch, skipped } | { error }.
function save(fx, w) {
  try {
    const saved = salvagePatch(w.path, w.branch);
    if (saved.nested) return { error: `it holds a nested repository (${saved.nested}) a patch cannot save` };
    if (saved.over) return { error: `its uncommitted work (${formatBytes(saved.over)}) is over the ${formatBytes(PATCH_CAP)} salvage cap` };
    if (!saved.patch) return { patch: null, skipped: 0 };
    const patch = path.join('.orq', 'salvage', `${w.branch.split('/').at(-1).replace(/[^\w.-]/g, '-')}-${fx.now()}.patch`);
    fs.mkdirSync(salvageDir(fx.cwd), { recursive: true });
    fs.writeFileSync(path.join(fx.cwd, patch), saved.patch, { flag: 'wx' }); // never over an earlier patch
    return { patch, skipped: saved.skipped.length };
  } catch (e) {
    return { error: `its uncommitted work could not be saved: ${lastSafeLine(e.message)}` };
  }
}

// Salvage (with force), then remove. When git refused before touching it (still registered), its patch is dropped so
// the next sweep does not save it twice; when git removed part of it, the patch is all that is left and stays.
function removeOne(fx, w, { force, measure }) {
  const bytes = measure ? diskBytes(w.path) : 0;
  const saved = force ? save(fx, w) : { patch: null, skipped: 0 };
  if (saved.error) return saved;
  const error = removeWorktree(fx.cwd, w.path, force);
  if (error && saved.patch && fx.git.listWorktrees(fx.cwd).some((x) => x.path === w.path)) fs.rmSync(path.join(fx.cwd, saved.patch), { force: true });
  return error ? { error } : {
    path: w.path, branch: w.branch, bytes, ...saved,
  };
}

async function clean(fx, { threads, force, dryRun, measure }) {
  if (!dryRun) prune(fx.cwd);
  const f = await readFacts(fx, threads);
  const found = candidates(fx, f);
  if (dryRun) {
    const gates = gateLeftovers(fx.cwd, f.state);
    return {
      removed: found.map((w) => ({ path: w.path, branch: w.branch, patch: null })), gates: gates.map((g) => ({ path: g })), kept: [], freed: 0,
    };
  }
  const worktrees = found.map((w) => ({ path: w.path, ...removeOne(fx, w, { force, measure }) }));
  // read after the worktrees went, which can take minutes: a gate started meanwhile is seen
  const gates = gateLeftovers(fx.cwd, f.state).map((g) => ({ gate: true, path: g, ...removeGate(g, measure) }));
  const results = [...worktrees, ...gates];
  prune(fx.cwd);
  const ok = results.filter((r) => !r.error);
  return {
    removed: ok.filter((r) => !r.gate),
    gates: ok.filter((r) => r.gate),
    kept: results.filter((r) => r.error).map((r) => ({ path: r.path, why: r.error })),
    freed: ok.reduce((n, r) => n + r.bytes, 0),
  };
}

/**
 * Remove every orq worktree no live work uses, and gate leftovers. threads: T3's rows ({id, status}) when known;
 * force: false runs a plain `git worktree remove` (no salvage; git keeps a dirty one); measure: false skips the sizes.
 * One cleanup at a time. -> { removed: [{path, branch, bytes, patch, skipped}], gates: [{path, bytes}], kept: [{path, why}],
 * freed } | { busy: true }
 */
export async function cleanAll(fx, {
  threads = null, force = true, dryRun = false, measure = true,
} = {}) {
  try {
    return await withLock(cleanupLockPath(fx.cwd), () => clean(fx, {
      threads, force, dryRun, measure,
    }), { timeoutMs: 0 });
  } catch (e) {
    if (String(e.message).startsWith('lock busy')) return { busy: true };
    throw e;
  }
}
