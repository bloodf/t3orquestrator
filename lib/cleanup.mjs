// What orq leaves on disk, removed once nothing uses it: worktrees on orq/* branches of finished work (their branches
// stay; uncommitted work is first saved under .orq/salvage/), gate checkouts no gate uses, and registrations of
// worktrees whose directory is gone. Picked by branch and path, never by guessing; never under the project lock.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reduce, unitOf } from './ledger.mjs';
import { listLeases } from './leases.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
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
  archiveRoot, cleanupLockPath, cleanupPath, integrationDir, leasesDir, projectDir, salvageDir,
} from './paths.mjs';

export const SWEEP_MINUTES = 10;
const ENDED = ['integrated', 'dropped'];
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
  const known = new Map([...archived.flatMap((f) => [...planBranches(f, false)]), ...planBranches(current, true)]);
  return {
    state: reduce(current.events), known,
    leased: new Set((await listLeases(leasesDir(fx.env))).map((l) => l.threadId)),
    threads: threads && Object.fromEntries(threads.map((t) => [t.id, t])),
  };
}

// null when the worktree can go, else why it stays.
function keepReason(w, branch, f) {
  const known = f.known.get(branch) ?? f.known.get(`ask:${PRE_PLAN_ASK.exec(branch)?.[1]}`);
  if (w.locked) return 'locked';
  if (known?.live) return 'in use';
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

// Salvage (with force), then remove. A patch is kept only when its worktree went: a later sweep never doubles it.
function removeOne(fx, w, force) {
  const bytes = diskBytes(w.path);
  let patch = null;
  if (force) {
    let saved;
    try {
      saved = salvagePatch(w.path, w.branch);
    } catch (e) {
      return { error: `its uncommitted work could not be saved: ${lastSafeLine(e.message)}` };
    }
    if (saved.over) return { error: `its uncommitted work (${formatBytes(saved.over)}) is over the ${formatBytes(PATCH_CAP)} salvage cap` };
    if (saved.patch) {
      patch = path.join('.orq', 'salvage', `${w.branch.split('/').at(-1).replace(/[^\w.-]/g, '-')}-${fx.now()}.patch`);
      fs.mkdirSync(salvageDir(fx.cwd), { recursive: true });
      fs.writeFileSync(path.join(fx.cwd, patch), saved.patch);
    }
  }
  const error = removeWorktree(fx.cwd, w.path, force);
  if (error && patch) fs.rmSync(path.join(fx.cwd, patch), { force: true });
  return error ? { error } : {
    path: w.path, branch: w.branch, bytes, patch,
  };
}

async function clean(fx, { threads, force, dryRun }) {
  prune(fx.cwd);
  const f = await readFacts(fx, threads);
  const found = candidates(fx, f);
  const gates = gateLeftovers(fx.cwd, f.state);
  if (dryRun) {
    return {
      removed: found.map((w) => ({ path: w.path, branch: w.branch, patch: null })), gates: gates.map((g) => ({ path: g })), kept: [], freed: 0,
    };
  }
  const results = [...found.map((w) => ({ path: w.path, ...removeOne(fx, w, force) })), ...gates.map((g) => ({ gate: true, path: g, ...removeGate(g) }))];
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
 * force: false runs a plain `git worktree remove` (no salvage; git keeps a dirty one). One cleanup at a time.
 * -> { removed: [{path, branch, bytes, patch}], gates: [{path, bytes}], kept: [{path, why}], freed } | { busy: true }
 */
export async function cleanAll(fx, { threads = null, force = true, dryRun = false } = {}) {
  try {
    return await withLock(cleanupLockPath(fx.cwd), () => clean(fx, { threads, force, dryRun }), { timeoutMs: 0 });
  } catch (e) {
    if (String(e.message).startsWith('lock busy')) return { busy: true };
    throw e;
  }
}

export function cleanupLines(r) {
  if (r.busy) return ['note: another cleanup is running; it removes what is left'];
  const [n, g] = [r.removed.length, r.gates.length];
  return [
    ...(n || g ? [`removed ${n} worker worktrees${g ? ` and ${g} gate checkouts` : ''}, freed ${formatBytes(r.freed)}`] : []),
    ...r.removed.filter((w) => w.patch).map((w) => `saved uncommitted work of ${w.branch} to ${w.patch}`),
    ...r.kept.map((k) => `note: kept worktree ${k.path}: ${k.why}`),
  ];
}

// From `orq wait`: a cleanup in the poll where a unit ended or a head shipped, and otherwise at most every SWEEP_MINUTES
// otherwise. ponytail: removals run inside the poll; a long backlog delays that one poll. Detach if it ever bites.
export async function sweepIfDue(fx, state, threads = null) {
  const ended = Object.values(state.units).filter((u) => ENDED.includes(u.state)).length + (state.plan.ships ?? 0);
  const last = await readJson(cleanupPath(fx.cwd), null);
  if (last?.ended === ended && fx.now() - last.at < SWEEP_MINUTES * 60_000) return null;
  await writeJsonAtomic(cleanupPath(fx.cwd), { at: fx.now(), ended });
  return cleanAll(fx, { threads });
}

// Never fails a poll: what a sweep saved is one note; what it could not remove waits for the next sweep.
export async function sweepNotes(fx, state, threads) {
  try {
    const r = await sweepIfDue(fx, state, threads);
    const saved = r?.removed?.filter((w) => w.patch).length;
    return saved ? [`note: cleanup saved the uncommitted work of ${saved} removed worktrees under .orq/salvage/`] : [];
  } catch (e) {
    return [`note: worktree cleanup failed: ${lastSafeLine(e.message)}`];
  }
}
