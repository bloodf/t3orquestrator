// orq wait, continuous mode: keep the integration branch merged with origin's base, so that a head that passes the
// final checks still fast-forwards the base after another machine shipped. Runs in the wait loop under the runner
// lock (no integrate, `orq ship` or archive meanwhile); git runs outside the project lock, the event is committed after.
import { defaultExec as gitExec, HARDEN } from '../git.mjs';
import { commit, readState } from '../ledger.mjs';
import { mergeBase } from '../integrate.mjs';
import { integrationDir } from '../paths.mjs';
import { shipUnits, unshipped } from '../ship.mjs';
import { fetchBase, tools } from './ship.mjs';

const FETCH_EVERY_MS = 5 * 60_000; // origin is asked at most this often per `orq wait`; the merge check is local
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];
const lastLine = (s) => String(s ?? '').trim().split('\n').at(-1);
const baseName = (config) => config.base.replace(/^origin\//, '');
const remoteRef = (base) => `refs/remotes/origin/${base}`;
const local = (ctx) => (args) => (ctx.deps.gitExec ?? gitExec)('git', [...HARDEN, ...args], { cwd: ctx.cwd });
const note = (run, line) => { if (!run.notes.includes(line)) run.notes.push(line); };

// true when `rev` has commits `head` lacks; throws when git cannot tell
function behind(git, rev, head) {
  const r = git(['merge-base', '--is-ancestor', rev, head]);
  if (r.code > 1) throw new Error(`git merge-base failed: ${lastLine(r.stderr)}`);
  return r.code === 1;
}

// Origin's base, as last fetched, against the passed head. null: it would ship. Otherwise { base, synced: the
// integration head has it (its final checks are due), files: the conflict orq's merge hit }. No network here.
export function staleBase(ctx, config, p) {
  if (!unshipped(p)) return null;
  const base = baseName(config);
  const git = local(ctx);
  try { // any error falls back to `orq ship`'s own check
    if (!behind(git, remoteRef(base), p.green)) return null;
    const synced = !behind(git, remoteRef(base), p.integrationHead);
    return { base, synced, files: synced ? [] : p.syncConflict?.files ?? [] };
  } catch {
    return null;
  }
}

function fetchNow(ctx, run, base) {
  if (run.fetchedAt !== undefined && ctx.now() - run.fetchedAt < FETCH_EVERY_MS) return;
  run.fetchedAt = ctx.now();
  let r;
  try {
    r = fetchBase(tools(ctx).git, base);
  } catch (e) {
    r = { code: 1, stderr: e.message };
  }
  if (r.code !== 0) note(run, `note: git fetch origin ${base} failed: ${firstLine(r.stderr)}; orq merges origin/${base} into the integration branch once it can fetch`);
}

// The sha of origin's base when the integration head lacks it and it was not already found to conflict; else null.
function wanted(ctx, base, p) {
  try {
    const git = local(ctx);
    const r = git(['rev-parse', '--verify', '--quiet', `${remoteRef(base)}^{commit}`]);
    const sha = r.code === 0 ? r.stdout.trim() : null; // never fetched: nothing to merge
    return sha && sha !== p.syncConflict?.base && behind(git, sha, p.integrationHead) ? sha : null;
  } catch {
    return null;
  }
}

// Merge origin's base into the integration branch when it moved and the merge is clean; a conflict is recorded
// once per base sha (`orq wait` then says which files) and tried again only when origin moves.
export async function syncBase(ctx, run) {
  const { plan: p } = await readState(ctx.cwd);
  if (shipUnits(p, p.integrationHead).length === 0) return; // nothing unshipped: a merge alone ships nothing
  const base = baseName(run.config);
  fetchNow(ctx, run, base);
  const sha = wanted(ctx, base, p);
  if (!sha) return;
  let r;
  try {
    r = mergeBase({
      repo: ctx.cwd, dir: integrationDir(ctx.cwd), branch: p.integrationBranch, baseSha: p.baseSha, ref: remoteRef(base), sha, git: run.fx.git,
    });
  } catch (e) {
    note(run, `note: could not merge origin/${base} into the integration branch: ${lastLine(e.message)}`);
    return;
  }
  const event = r.ok ? { type: 'synced', from: p.integrationHead, to: r.head, base: sha } : { type: 'sync-conflicted', base: sha, files: r.files };
  // re-checked under the lock: the head moves only in this loop, but never record over a head that moved
  const { events } = await commit(ctx.cwd, (s) => (s.plan.integrationHead === p.integrationHead ? [{ ...event, unit: null, at: ctx.now() }] : []));
  if (!events.length) return;
  const at = `origin/${base} (${sha.slice(0, 12)})`;
  note(run, r.ok ? `note: merged ${at} into the integration branch at ${r.head.slice(0, 12)}; the final checks run on it`
    : `note: ${at} conflicts with the integration branch in ${r.files.join(', ')}; a unit with job "fix" has to merge it`);
}
