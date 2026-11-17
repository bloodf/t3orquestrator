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

// `git status --porcelain=v2 -z`: changed tracked paths, untracked files (never ignored ones), and changed submodules
// (field 3 starts with S). Entries: `1 XY sub … path`, `2 XY sub … score path` + NUL + its old path, `u …`, `? path`.
const PATH_FIELD = { 1: 8, 2: 9, u: 10 };
function changes(dir) {
  const tokens = git(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).toString('utf8').split('\0');
  const out = { tracked: [], untracked: [], submodules: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const parts = t.split(' ');
    if (t.startsWith('? ')) out.untracked.push(t.slice(2));
    else if (PATH_FIELD[parts[0]]) {
      const file = parts.slice(PATH_FIELD[parts[0]]).join(' ');
      (parts[2].startsWith('S') ? out.submodules : out.tracked).push(file);
      if (parts[0] === '2') i += 1; // a rename or copy, in the index or the worktree: its old path follows
    }
  }
  return out;
}

// A submodule checked out in this worktree (its repository is under the worktree's own git dir, `modules/`, or the
// gitlink's directory holds a .git): `git worktree remove --force` deletes it with any commit found only there.
function initializedSubmodule(dir) {
  const gitDir = path.resolve(dir, git(dir, ['rev-parse', '--git-dir']).toString('utf8').trim());
  if (fs.existsSync(path.join(gitDir, 'modules'))) return 'modules';
  const links = git(dir, ['ls-files', '-s', '-z']).toString('utf8').split('\0').filter((l) => l.startsWith('160000 '));
  return links.map((l) => l.split('\t')[1]).find((f) => fs.existsSync(path.join(dir, f, '.git'))) ?? null;
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
 * than PATCH_CAP | { nested: path } | { submodule: path }: a repository inside it, whose work a patch cannot hold
 */
export function salvagePatch(dir, branch) {
  const initialized = initializedSubmodule(dir);
  if (initialized) return { submodule: initialized === 'modules' ? 'under its git dir' : initialized }; // commits may live only there
  const { tracked, untracked, submodules } = changes(dir);
  if (submodules.length) return { submodule: submodules[0] }; // its edits and commits live only in there
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

export const KEEP_DAYS = 30;
export const KEEP_PATCHES = 100;
export const FRESH_DAYS = 7; // never removed: whoever wants a patch back has a week, however many there are

// Salvage is for a person to look at soon: patches older than KEEP_DAYS go, and past FRESH_DAYS all but the KEEP_PATCHES
// newest. Unreadable entries are left alone.
export function pruneSalvage(dir, now) {
  const DAY = 86_400_000;
  try {
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.patch'))
      .map((n) => ({ file: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.at - a.at);
    files.filter((f, i) => f.at < now - KEEP_DAYS * DAY || (i >= KEEP_PATCHES && f.at < now - FRESH_DAYS * DAY))
      .forEach((f) => fs.rmSync(f.file, { force: true }));
  } catch {
    // a patch that vanished or cannot be read: the next run tries again
  }
}

// A worktree's uncommitted work written to .orq/salvage/<branch tail>-<ms>.patch -> { patch, skipped } | { error }.
// dryRun: only says whether it could be saved.
export function savePatch(cwd, w, now, dryRun = false) {
  try {
    const saved = salvagePatch(w.path, w.branch);
    if (saved.submodule) return { error: `it has a submodule (${saved.submodule}) whose work and commits a patch cannot save` };
    if (saved.nested) return { error: `it holds a nested repository (${saved.nested}) a patch cannot save` };
    if (saved.over) return { error: `its uncommitted work (${formatBytes(saved.over)}) is over the ${formatBytes(PATCH_CAP)} salvage cap` };
    if (!saved.patch || dryRun) return { patch: null, skipped: 0 };
    const patch = path.join('.orq', 'salvage', `${w.branch.split('/').at(-1).replace(/[^\w.-]/g, '-')}-${now}.patch`);
    fs.mkdirSync(path.join(cwd, '.orq', 'salvage'), { recursive: true });
    fs.writeFileSync(path.join(cwd, patch), saved.patch, { flag: 'wx' }); // never over an earlier patch
    return { patch, skipped: saved.skipped.length };
  } catch (e) {
    return { error: `its uncommitted work could not be saved: ${String(e.message).trim().split('\n').at(-1).slice(0, 160)}` };
  }
}
