// Shared dependency directories: a worktree links the main checkout's ignored `node_modules` (and the like)
// instead of installing its own copy. A link is made only where it is provably the same dependencies, can never be
// committed, and replaces nothing. A bun worktree can write through its link into the shared directory: accepted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesAny } from './glob.mjs';
import { syncShareExclude } from './share-exclude.mjs';

export { syncShareExclude };

const MAX_DEPTH = 4;
const NODE_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// Which installers were tested against a linked node_modules (test/share-installers.test.mjs): bun keeps the main
// checkout's files; `npm ci` empties the directory through the link. pnpm keeps them too, but writes its own links
// into the main directory through the worktree's path (../../<worktree>/node_modules/.pnpm/...), which dangle once
// that worktree is removed: pnpm checkouts install their own node_modules from the machine's store instead.
const SAFE_LOCKS = ['bun.lock', 'bun.lockb'];
// A package manifest or lockfile, in any directory: the files a linked node_modules is only valid for when unchanged.
export const isDependencyFile = (p) => NODE_FILES.includes(String(p).split('/').pop());

export const NOT_INSTALLED = 'node_modules is not installed in the project root: install there once, then run "orq init" again';
const PNPM_REFUSED = 'pnpm projects are not shared: pnpm writes links through a linked node_modules that dangle once the worktree is removed; each checkout installs from the pnpm store';
const REFUSED = [
  [['package-lock.json', 'npm-shrinkwrap.json'], 'npm projects are not shared: "npm ci" empties a linked node_modules'],
  [['yarn.lock'], 'yarn is untested'],
  [['pnpm-lock.yaml'], PNPM_REFUSED],
];

// Why a node_modules at `p` must not be linked, judged by the lockfiles next to it and at the root of the main
// checkout; null when its installer was tested safe. Other kinds of directory are only ever listed by the user.
export function refusal(cwd, p) {
  if (path.posix.basename(p) !== 'node_modules') return null;
  const dir = path.posix.dirname(p);
  const has = (f) => [dir, '.'].some((d) => fs.existsSync(path.join(cwd, d, f)));
  const refused = REFUSED.find(([files]) => files.some(has));
  if (refused) return refused[1];
  return SAFE_LOCKS.some(has) ? null : 'no lockfile';
}

export function validSharePath(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\\') || p.startsWith('/') || p.startsWith('~')) return false;
  const parts = p.split('/');
  return !parts.some((x) => x === '' || x === '.' || x === '..') && parts[0] !== '.git' && parts[0] !== '.orq';
}

// The files that decide what a shared directory holds: for node_modules, the manifest and lockfiles next to it and
// at the repository root. Unknown kinds have none: they are linked whenever the rest holds.
export function governing(p) {
  if (path.posix.basename(p) !== 'node_modules') return [];
  const dir = path.posix.dirname(p);
  return [...new Set([...NODE_FILES.map((f) => (dir === '.' ? f : `${dir}/${f}`)), ...NODE_FILES])];
}

// Default `share` for `orq init`: every ignored node_modules up to 4 levels deep (not inside another one) whose
// installer was tested safe. No package manager is asked anything. -> {paths, why}: why explains, when node_modules
// directories were found but none can be shared, the first reason.
export function detectShares(cwd, git) {
  const found = [];
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.filter((x) => x.isDirectory())) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git' || e.name === '.orq') continue;
      if (e.name === 'node_modules') found.push(p);
      else if (depth < MAX_DEPTH) walk(p, depth + 1);
    }
  };
  walk('', 1);
  const ignored = new Set(git.ignored(cwd, found));
  const candidates = found.filter((p) => ignored.has(p)).sort();
  const paths = candidates.filter((p) => refusal(cwd, p) === null);
  if (paths.length || candidates.length) return { paths, why: paths.length ? null : refusal(cwd, candidates[0]) };
  // a bun project with nothing installed in its root: every worktree would install its own copy
  if (found.includes('node_modules')) return { paths, why: null };
  const why = refusal(cwd, 'node_modules');
  return { paths, why: why === null ? NOT_INSTALLED : (why === PNPM_REFUSED ? why : null) };
}

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The shared paths a checkout of `commit` may link (runs git; never under a lock): the main checkout has the
 * directory and the governing files are byte-identical in `commit` and in the main checkout's working tree.
 * A unit that opts out (`share: false`) or whose paths cover a governing file (it changes dependencies) gets none.
 */
export function eligibleShares({
  cwd, commit, paths, unit = null, git,
}) {
  if (!Array.isArray(paths) || paths.length === 0 || unit?.share === false) return [];
  const files = [...new Set(paths.flatMap(governing))];
  if (unit && files.some((f) => matchesAny(f, unit.paths))) return [];
  const same = (f) => git.showFile(cwd, commit, f) === readOrNull(path.join(cwd, f));
  return paths.filter((p) => {
    try {
      if (!fs.statSync(path.join(cwd, p)).isDirectory()) return false;
    } catch {
      return false;
    }
    // what it holds is known (a manifest next to it), and nothing on the way to it is a symlink in the commit
    const manifest = path.posix.basename(p) !== 'node_modules' || fs.existsSync(path.join(cwd, path.posix.dirname(p), 'package.json'));
    return manifest && refusal(cwd, p) === null && governing(p).every(same) && !git.symlinkInTree(cwd, commit, p);
  });
}

// No symbolic link on the way from `dir` to p's parent: a link must not land outside the checkout.
function plainParents(dir, p) {
  const parts = path.posix.dirname(p) === '.' ? [] : path.posix.dirname(p).split('/');
  return parts.every((_, i) => {
    const st = fs.lstatSync(path.join(dir, ...parts.slice(0, i + 1)), { throwIfNoEntry: false });
    return st !== undefined && st.isDirectory() && !st.isSymbolicLink();
  });
}

// Link each path in the checkout at `dir` to the main checkout's directory when its parents are plain directories
// and git ignores it there (orq's exclude entry is made first, cheaply). Returns the paths linked. Any error on a
// path means "not linked", never a throw. Never deletes or replaces anything: symlink() fails when the path exists.
export function linkShares({
  dir, cwd, paths, git,
}) {
  try {
    syncShareExclude(cwd, paths, git);
  } catch {
    // no exclude entry: check-ignore below then refuses the link
  }
  return paths.filter((p) => {
    try {
      if (!plainParents(dir, p) || git.ignored(dir, [p]).length !== 1) return false;
      fs.symlinkSync(fs.realpathSync(path.join(cwd, p)), path.join(dir, p), 'dir');
      return true;
    } catch {
      return false;
    }
  });
}

const PNPM_FLAGS = 'install --frozen-lockfile --prefer-offline';
const SAFE_DIR = /^[\w./@+-]+$/;
// A directory as one shell word: as it is when plain, else single-quoted (a ' becomes '\'').
const shellWord = (d) => (SAFE_DIR.test(d) ? d : `'${d.replaceAll("'", "'\\''")}'`);

// The directories (relative, '.' for the root) up to 4 levels deep with a pnpm-lock.yaml and an installed
// node_modules in the main checkout: where the project installs with pnpm.
function pnpmDirs(cwd) {
  const dirs = [];
  const walk = (rel, depth) => {
    const at = path.join(cwd, rel);
    if (fs.existsSync(path.join(at, 'pnpm-lock.yaml')) && fs.existsSync(path.join(at, 'node_modules'))) dirs.push(rel || '.');
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk('', 1);
  return dirs.sort();
}

// The pnpm install that gives a checkout its own dependencies: one per pnpm directory, joined by &&. Fast: pnpm
// links from the machine's store. null when there is none.
export function pnpmInstall(cwd) {
  const dirs = pnpmDirs(cwd);
  if (dirs.length === 0) return null;
  return dirs.map((d) => (d === '.' ? `pnpm ${PNPM_FLAGS}` : `pnpm -C ${shellWord(d)} ${PNPM_FLAGS}`)).join(' && ');
}

// For a thread: how to install the pnpm dependencies of its worktree (never linked), or null.
export function installLine(cwd) {
  const cmd = pnpmInstall(cwd);
  return cmd && `Dependencies: pnpm dependencies are not linked into this worktree. Install them before running anything: \`${cmd}\` (from the machine's pnpm store, about a second).`;
}

// The dependency lines of a thread's order, per kind: the bun paths linked and the pnpm install, each when present.
export const dependencyLines = (cwd, shared) => [shared.length ? shareLine(shared) : null, installLine(cwd)].filter(Boolean);

// Before pnpm projects stopped being shared, orq linked their node_modules into checkouts: such a checkout still
// writes through the link into the main checkout's directory. Remove each such link from the checkout at `dir`
// (only a symlink whose target is the main checkout's directory, reached through plain parents; the target is
// never touched, nor anything in the main checkout itself). -> paths removed
export function unlinkOldShares(dir, cwd) {
  try {
    if (fs.realpathSync(dir) === fs.realpathSync(cwd)) return [];
  } catch {
    return [];
  }
  return pnpmDirs(cwd).map((d) => (d === '.' ? 'node_modules' : `${d}/node_modules`)).filter((rel) => {
    try {
      const at = path.join(dir, rel);
      if (!plainParents(dir, rel) || !fs.lstatSync(at).isSymbolicLink()) return false;
      if (path.resolve(path.dirname(at), fs.readlinkSync(at)) !== fs.realpathSync(path.join(cwd, rel))) return false;
      fs.unlinkSync(at);
      return true;
    } catch {
      return false;
    }
  });
}

const defaultInstall = (dir, cmd) => spawnSync('sh', ['-c', cmd], { cwd: dir, stdio: 'ignore', timeout: 10 * 60_000 }).status === 0;

/**
 * A thread about to work again in its worktree (feedback, a nudge): an old pnpm link there is replaced by a real
 * install from the store. fx: {cwd, t3, install?(dir, cmd) -> ok}. Never throws.
 * -> {removed: [paths], installed: boolean|null} (installed null: nothing was removed)
 */
export function replaceOldShares(fx, threadId) {
  let dir = null;
  if (pnpmDirs(fx.cwd).length === 0) return { removed: [], installed: null }; // not a pnpm project: T3 is not asked
  try {
    dir = fx.t3.showThread(threadId, { messages: 0 }).thread.worktreePath;
  } catch {
    return { removed: [], installed: null };
  }
  if (typeof dir !== 'string' || !fs.existsSync(dir)) return { removed: [], installed: null };
  const removed = unlinkOldShares(dir, fx.cwd);
  if (removed.length === 0) return { removed, installed: null };
  try {
    return { removed, installed: (fx.install ?? defaultInstall)(dir, pnpmInstall(fx.cwd)) };
  } catch {
    return { removed, installed: false };
  }
}

export const trackedShareMessage = (p) => `share: "${p}" has tracked files; only untracked, ignored directories can be shared`;

export const shareLine = (paths) => `Dependencies: ${paths.join(', ')} are linked from the main checkout. Do not install, delete or modify them; if you must change dependencies, report NEEDS_CONTEXT.`;

const realPause = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * After a thread starts: find the worktree T3 made for it (it may appear a few seconds later; bounded retries,
 * outside every lock) and link `paths` there. -> {linked, missing, why} (why: null when everything was linked).
 */
export async function linkThreadWorktree(fx, threadId, paths, { tries = 5, waitMs = 1000 } = {}) {
  let dir = null;
  for (let i = 0; i < tries && dir === null; i += 1) {
    try {
      const p = fx.t3.showThread(threadId, { messages: 0 }).thread.worktreePath;
      if (typeof p === 'string' && fs.existsSync(p)) dir = p;
    } catch {
      // not visible yet, or t3 failed: try again
    }
    if (dir === null && i < tries - 1) await (fx.pause ?? realPause)(waitMs);
  }
  if (dir === null) return { linked: [], missing: paths, why: 'worktree not found' };
  const linked = linkShares({
    dir, cwd: fx.cwd, paths, git: fx.git,
  });
  const missing = paths.filter((p) => !linked.includes(p));
  return { linked, missing, why: missing.length ? 'already present or not ignored there' : null };
}
