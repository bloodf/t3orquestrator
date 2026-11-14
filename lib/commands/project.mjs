// Project config mutations: one lock, one exclude step, shared by every command that writes .orq/.
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from '../lock.mjs';
import { readJson, writeJsonAtomic } from '../store.mjs';
import { loadProjectConfig } from '../config.mjs';
import { projectConfigPath, projectDir } from '../paths.mjs';

// The directory git keeps shared info in (the main repository's, also from a linked worktree), or null.
function gitCommonDir({ cwd, deps }) {
  try {
    const r = deps.exec('git', ['rev-parse', '--git-common-dir'], { cwd });
    const out = r.code === 0 ? r.stdout.trim() : '';
    if (out === '') return null;
    const dir = path.resolve(cwd, out);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null; // git missing: nothing to exclude from
  }
}

export function ensureExcluded(ctx) {
  const dir = gitCommonDir(ctx);
  if (!dir) return;
  const file = path.join(dir, 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes('.orq/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}.orq/\n`);
}

// fn(current, raw) -> next config; raw is the file as written (keys the user set, even to null).
export async function updateProjectConfig(ctx, fn) {
  const file = projectConfigPath(ctx.cwd);
  const next = await withLock(path.join(projectDir(ctx.cwd), 'lock'), async () => {
    const raw = await readJson(file, {});
    const out = await fn(await loadProjectConfig(file), raw);
    await writeJsonAtomic(file, out);
    return out;
  });
  ensureExcluded(ctx);
  return next;
}

// The standing goal, or undefined. Advice only: an unreadable config must not break the command that echoes it.
export async function readGoal(cwd) {
  try {
    return (await loadProjectConfig(projectConfigPath(cwd))).goal;
  } catch {
    return undefined;
  }
}
