// Before orq removes a finished worktree that still holds uncommitted work, that work is saved as a patch: changes to
// tracked files plus new files git does not ignore. Ignored files (installs, build output) are never saved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARDEN } from './git.mjs';

export const FILE_CAP = 256 * 1024; // a larger new file is output, not source: named in the patch, not saved
export const PATCH_CAP = 2 * 1024 * 1024; // a larger patch is no salvage: the worktree is kept for a person to look at

// No GIT_* from the caller (a GIT_DIR or GIT_INDEX_FILE would point elsewhere): the index copy below is the only one
// touched. The diff settings pin a patch `git apply` reads, whatever the user's config says.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const PINNED = ['-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false'];
function git(dir, args, { env = {}, input } = {}) {
  const r = spawnSync('git', [...HARDEN, ...PINNED, ...args], {
    cwd: dir, env: { ...CLEAN_ENV, GIT_LITERAL_PATHSPECS: '1', ...env }, input, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').at(-1)}`);
  return r.stdout;
}

// `git status -z`: tracked changes, and untracked files (never ignored ones). Renames carry a second path.
function changes(dir) {
  const tokens = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8').split('\0');
  const tracked = [];
  const untracked = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '') continue;
    if (t.startsWith('?? ')) untracked.push(t.slice(3));
    else tracked.push(t.slice(3));
    if (t[0] === 'R' || t[0] === 'C') i += 1;
  }
  return { tracked, untracked };
}

const sizeOf = (dir, f) => {
  try {
    const s = fs.lstatSync(path.join(dir, f));
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
};

// The diff of the worktree against HEAD, new files included through a copy of its index (intent-to-add there only).
function diffWith(dir, files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orq-salvage-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    const index = path.resolve(dir, git(dir, ['rev-parse', '--git-path', 'index']).toString('utf8').trim());
    if (fs.existsSync(index)) fs.copyFileSync(index, env.GIT_INDEX_FILE);
    else git(dir, ['read-tree', 'HEAD'], { env });
    if (files.length) git(dir, ['add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: files.join('\0') });
    return git(dir, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'], { env });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The uncommitted work of the worktree at `dir`, as a patch git applies on its HEAD. Throws when git fails.
 * -> { patch: null } nothing to save | { patch: Buffer, skipped: [new files too large to save] } | { over: bytes } larger
 * than PATCH_CAP | { nested: path } a repository inside it, whose work a patch cannot hold
 */
export function salvagePatch(dir, branch) {
  const { tracked, untracked } = changes(dir);
  if (tracked.length === 0 && untracked.length === 0) return { patch: null };
  const nested = untracked.find((f) => f.endsWith('/')); // `git status` lists a repository inside the worktree as a directory
  if (nested) return { nested };
  const skipped = untracked.filter((f) => sizeOf(dir, f) > FILE_CAP);
  const diff = diffWith(dir, untracked.filter((f) => !skipped.includes(f)));
  const head = git(dir, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const header = [
    `# orq salvage of ${branch} from ${dir}`,
    `# made on ${head}; restore with: git apply <this file>`,
    ...(skipped.length ? [`# not saved (over ${FILE_CAP / 1024} KiB): ${skipped.join(', ')}`] : []),
    '',
  ].join('\n');
  const patch = Buffer.concat([Buffer.from(header), diff]);
  return patch.length > PATCH_CAP ? { over: patch.length } : { patch, skipped };
}

// Bytes a directory takes on disk; symbolic links are counted, never followed. Unreadable parts count as nothing.
export function diskBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        const s = fs.lstatSync(p);
        total += s.blocks ? s.blocks * 512 : s.size;
      } catch {
        continue;
      }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return total;
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}
