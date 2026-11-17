// What a gate tells its commands: ORQ_GATE (unit or final) and, for a unit gate, ORQ_BASE_SHA and the files it
// changed (ORQ_CHANGED_FILES, ORQ_DELETED_FILES: absolute paths to lists, one repository-relative path a line).
// Commands may run only the tests those files touch; with ORQ_CHANGED_FILES unset they run everything.
import fs from 'node:fs/promises';
import { HARDEN } from './git.mjs';
import { gateFile } from './paths.mjs';

const SHA = /^[0-9a-f]{40}$/;
const LISTS = { ORQ_CHANGED_FILES: ['changed.txt', 'ACMR'], ORQ_DELETED_FILES: ['deleted.txt', 'D'] };

// the files of the gate's lists, to remove once it is over
export const envFiles = (cwd, id, attempt) => Object.values(LISTS).map(([ext]) => gateFile(cwd, id, attempt, ext));

function diff(exec, cwd, base, head, filter) {
  const r = exec('git', [...HARDEN, '-c', 'core.quotepath=false', 'diff', '--name-only', '-z', `--diff-filter=${filter}`, '--end-of-options', `${base}...${head}`], { cwd });
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}

export async function gateEnv({
  exec, cwd, id, attempt, baseSha, headSha, final,
}) {
  if (final) return { ORQ_GATE: 'final' };
  const env = { ORQ_GATE: 'unit', ...(SHA.test(baseSha ?? '') ? { ORQ_BASE_SHA: baseSha } : {}) };
  if (!env.ORQ_BASE_SHA) return env;
  const lists = {};
  try {
    for (const [name, [ext, filter]] of Object.entries(LISTS)) {
      const files = diff(exec, cwd, baseSha, headSha, filter);
      if (files === null) return env; // no diff: no lists, so the commands run everything
      lists[name] = { file: gateFile(cwd, id, attempt, ext), text: files.map((f) => `${f}\n`).join('') };
    }
  } catch {
    return env;
  }
  for (const { file, text } of Object.values(lists)) await fs.writeFile(file, text);
  return { ...env, ...Object.fromEntries(Object.entries(lists).map(([name, { file }]) => [name, file])) };
}
