// `orq plan archive`: put a finished plan away so the next request starts a fresh plan, ledger and integration
// branch. The checks and side jobs live here; the crash-safe move and its marker are in archive-move.mjs.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { reduce, unitOf, FINAL } from './ledger.mjs';
import { readJson, readLines } from './store.mjs';
import { withLock } from './lock.mjs';
import { collectGate, pidAlive, lastSafeLine } from './gaterun.mjs';
import { createGit, defaultExec as gitExec } from './git.mjs';
import { listLeases, removeLease } from './leases.mjs';
import {
  ArchiveRefused, NAME, exists, moveState, wayOut, writeMarker,
} from './archive-move.mjs';
import {
  archiveRoot, archivingPath, integrationDir, leasesDir, ledgerPath, machineLockPath, planPath, projectLockPath, reviewsPath, runnerLockPath,
} from './paths.mjs';

export { ArchiveRefused };
const IN_FLIGHT = ['running', 'blocked', 'gating', 'passed'];

// Everything archive needs to decide, read from disk (call it under the project lock to act on it).
async function inspect(cwd, now) {
  const has = (await exists(planPath(cwd))) || (await exists(ledgerPath(cwd)));
  const plan = await readJson(planPath(cwd), null);
  const state = reduce(await readLines(ledgerPath(cwd)));
  const ids = [...new Set([...(Array.isArray(plan?.units) ? plan.units.map((u) => u.id) : []), ...Object.keys(state.units)])];
  const busy = ids.find((id) => IN_FLIGHT.includes(unitOf(state, id).state));
  const finalRunning = state.plan.finalGateStarts > 0 && (await collectGate({ cwd, isAlive: pidAlive }, FINAL, 1)).running;
  const review = (await readJson(reviewsPath(cwd), { reviews: [] }))?.reviews?.find((r) => r?.status === 'running');
  const blocker = (busy && `unit ${busy} is ${unitOf(state, busy).state}`)
    || (finalRunning && 'the final gate is running')
    || (review && `review ${review.n} is running`) || null;
  const { planId } = state.plan;
  if (planId !== null && !NAME.test(planId)) throw new ArchiveRefused(`invalid planId "${planId}" in the ledger`);
  return {
    has, blocker, planId, base: planId ?? `unstarted-${now.toString(36)}`,
  };
}

// The integration worktree belongs to the archived plan; its branch is kept. Runs git: never under the project lock.
async function removeIntegrationWorktree(cwd, git) {
  const dir = integrationDir(cwd);
  if (!(await exists(dir))) return;
  if (!(await exists(path.join(dir, '.git')))) throw new ArchiveRefused(`${dir} exists but is not a git worktree`);
  const { clean, files } = git.isClean(dir);
  if (!clean) throw new ArchiveRefused(`the integration worktree has uncommitted changes (${files.slice(0, 3).join(', ')})`);
  git.removeWorktree(cwd, dir);
}

// Worker and review worktrees (branch orq/*) of this and earlier plans. Never --force, never a branch delete: git refuses
// dirty or locked ones and they are kept with a note. Runs git: never under the project lock; must not fail the archive.
function removeWorkerWorktrees(cwd, git) {
  try {
    const skip = [realpathSync(cwd), path.join(realpathSync(cwd), '.orq', 'integration')];
    const mine = git.listWorktrees(cwd).filter((w) => w.branch?.startsWith('refs/heads/orq/') && !skip.includes(w.path));
    const notes = [];
    let removed = 0;
    for (const w of mine) {
      const r = git.tryRemoveWorktree(cwd, w.path);
      if (r.ok) removed += 1;
      else notes.push(`note: kept worktree ${w.path}: ${lastSafeLine(r.error)}`);
    }
    return [...(removed ? [`removed ${removed} worker worktrees`] : []), ...notes];
  } catch (e) {
    return [`note: worker worktree cleanup failed: ${lastSafeLine(e.message)}`];
  }
}

// Holding the runner lock keeps `orq wait` out for the whole archive; a running wait refuses it.
async function withRunnerLock(cwd, fn) {
  const file = runnerLockPath(cwd);
  try {
    return await withLock(file, fn, { timeoutMs: 0 });
  } catch (e) {
    if (!String(e.message).startsWith(`lock busy: ${file}`)) throw e;
    const held = await readJson(file, null);
    throw new ArchiveRefused(`orq wait is running (pid ${held?.pid ?? 'unknown'})`);
  }
}

async function removeProjectLeases(ctx) {
  return withLock(machineLockPath(ctx.env), async () => {
    const dir = leasesDir(ctx.env);
    const mine = (await listLeases(dir)).filter((l) => l.project === ctx.cwd);
    for (const l of mine) await removeLease(dir, l.threadId);
    return mine.length;
  });
}

// Decisions archived while their thread still ran: nothing will read their outcome now.
const runningAsks = (doc) => (Array.isArray(doc?.asks) ? doc.asks : []).filter((a) => a?.status === 'running')
  .map((a) => `note: decision ${a.n} is still running in thread ${a.threadId}; its outcome will not be recorded`);

// What the archive holds, read back from it: the ledger and plan as they were when archived.
async function report(cwd, { planId, name }, notes) {
  const dir = path.join(archiveRoot(cwd), name);
  const plan = await readJson(path.join(dir, 'plan.json'), null);
  const state = reduce(await readLines(path.join(dir, 'ledger.jsonl')));
  const ids = [...new Set([...(Array.isArray(plan?.units) ? plan.units.map((u) => u.id) : []), ...Object.keys(state.units)])];
  const integrated = ids.filter((id) => unitOf(state, id).state === 'integrated');
  const open = ids.filter((id) => ['queued', 'failed'].includes(unitOf(state, id).state));
  return [
    `archived: plan ${planId ?? name} (${integrated.length} integrated, ${ids.length - integrated.length} not) -> .orq/archive/${name}/`,
    ...(state.plan.integrationBranch ? [`integration branch kept: ${state.plan.integrationBranch}`] : []),
    ...(open.length ? [`note: ${open.length} units were not integrated: ${open.join(', ')}`] : []),
    ...runningAsks(await readJson(path.join(dir, 'asks.json'), null)),
    ...notes,
  ];
}

function prune(cwd) {
  try {
    const r = gitExec('git', ['worktree', 'prune'], { cwd }); // drop registrations of gate worktrees removed with .orq/gate
    return r.code === 0 ? [] : [`note: git worktree prune failed: ${String(r.stderr).trim().split('\n').at(-1)}`];
  } catch (e) {
    return [`note: git worktree prune failed: ${e.message}`];
  }
}

// Under the project lock: start a new archive (checks, then the marker first) or resume an interrupted one.
async function markOrResume(ctx, onStep) {
  const resumed = await readJson(archivingPath(ctx.cwd), null);
  if (resumed) return resumed;
  const now = await inspect(ctx.cwd, ctx.now());
  if (!now.has) throw new ArchiveRefused('nothing to archive');
  if (now.blocker) throw new ArchiveRefused(now.blocker);
  const marker = await writeMarker(ctx.cwd, { planId: now.planId, base: now.base, now: ctx.now() });
  await onStep('marker written');
  return marker;
}

// Lock order: runner lock (whole run) -> project lock (the move only); machine lock after the project lock is released.
export function archivePlan(ctx, { onStep = async () => {} } = {}) {
  const { cwd } = ctx;
  return withRunnerLock(cwd, async () => {
    if (!(await exists(archivingPath(cwd)))) {
      const before = await inspect(cwd, ctx.now());
      if (!before.has) throw new ArchiveRefused('nothing to archive');
      if (before.blocker) throw new ArchiveRefused(before.blocker);
    }
    await removeIntegrationWorktree(cwd, createGit({ exec: ctx.deps?.gitExec ?? gitExec }));
    const marker = await withLock(projectLockPath(cwd), async () => {
      const m = await markOrResume(ctx, onStep);
      try {
        await moveState(cwd, m, ctx.now(), onStep);
      } catch (e) {
        const cause = String(e.message).trim().split('\n').at(-1).replace(/\.$/, '');
        throw new ArchiveRefused(`${cause}. ${wayOut(m.name)}`);
      }
      return m;
    });
    const notes = [...removeWorkerWorktrees(cwd, createGit({ exec: ctx.deps?.gitExec ?? gitExec })), ...prune(cwd)];
    const leases = await removeProjectLeases(ctx);
    if (leases) notes.push(`note: removed ${leases} lease${leases === 1 ? '' : 's'} left by the archived plan`);
    return report(cwd, marker, notes);
  });
}

// {count, latest} of the archived plans; latest by archive time.
export async function listArchives(cwd) {
  let names = [];
  try {
    names = (await fs.readdir(archiveRoot(cwd))).filter((n) => !n.startsWith('.'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const marks = await Promise.all(names.map((n) => readJson(path.join(archiveRoot(cwd), n, 'archive.json'), { name: n, archivedAt: 0 })));
  const latest = marks.reduce((a, b) => (b.archivedAt > (a?.archivedAt ?? -1) ? b : a), null);
  return { count: names.length, latest: latest?.name ?? null };
}
