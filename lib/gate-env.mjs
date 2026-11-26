// What a gate tells its commands: ORQ_GATE (unit or final) and, for a unit gate, ORQ_BASE_SHA (the commit the unit's
// work is judged against), ORQ_UNIT_JOB and the files it changed (ORQ_CHANGED_FILES, ORQ_DELETED_FILES: absolute
// paths to lists, one repository-relative path a line). Commands may run only the tests those files touch; with
// ORQ_CHANGED_FILES unset they run everything. A final run gets the same lists for what changed since the last head
// that passed the final checks (sinceSha, ORQ_BASE_SHA); with no such head it runs everything.
import fs from 'node:fs/promises';
import { gateFile } from './paths.mjs';

const SHA = /^[0-9a-f]{40}$/;
export const ORQ_VARS = ['ORQ_GATE', 'ORQ_BASE_SHA', 'ORQ_UNIT_JOB', 'ORQ_CHANGED_FILES', 'ORQ_DELETED_FILES'];

// the files of the gate's lists, to remove once it is over
export const envFiles = (cwd, id, attempt) => ['changed.txt', 'deleted.txt'].map((ext) => gateFile(cwd, id, attempt, ext));

// git: createGit's; its changedFiles lists a rename as the new path plus a `D` for the old one
export async function gateEnv({
  git, cwd, id, attempt, baseSha, headSha, job, final, sinceSha,
}) {
  if (final) {
    // no green head, or this head is it (a rerun): everything
    if (!SHA.test(sinceSha ?? '') || sinceSha === headSha) return { ORQ_GATE: 'final' };
    return lists({
      git, cwd, id, attempt, baseSha: sinceSha, headSha,
    }, { ORQ_GATE: 'final', ORQ_BASE_SHA: sinceSha });
  }
  if (!SHA.test(baseSha ?? '')) return { ORQ_GATE: 'unit', ...(job ? { ORQ_UNIT_JOB: job } : {}) };
  const env = { ORQ_GATE: 'unit', ORQ_BASE_SHA: baseSha, ...(job ? { ORQ_UNIT_JOB: job } : {}) };
  if (job === 'fix') return env; // it fixes what the whole suite fails: no lists, so it runs everything
  return lists({ git, cwd, id, attempt, baseSha, headSha }, env);
}

// env plus the changed and deleted lists of baseSha...headSha, or env alone when they cannot be made
async function lists({ git, cwd, id, attempt, baseSha, headSha }, env) {
  try {
    const files = git.changedFiles(cwd, baseSha, headSha);
    if (files.some((f) => f.path.includes('\n'))) return env; // a list of lines cannot hold it
    const [changed, deleted] = envFiles(cwd, id, attempt);
    const list = (keep) => [...new Set(files.filter(keep).map((f) => f.path))].map((p) => `${p}\n`).join('');
    await fs.writeFile(changed, list((f) => f.status !== 'D'));
    await fs.writeFile(deleted, list((f) => f.status === 'D'));
    return { ...env, ORQ_CHANGED_FILES: changed, ORQ_DELETED_FILES: deleted };
  } catch {
    return env; // no diff, or no lists: the commands run everything
  }
}
