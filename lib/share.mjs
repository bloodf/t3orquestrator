// Shared dependency directories: a worktree links the main checkout's ignored `node_modules` (and the like)
// instead of installing its own copy. A link is made only where it is provably the same dependencies, can never be
// committed, and replaces nothing. Each worktree can write through its link into the shared directory: accepted.
import fs from 'node:fs';
import path from 'node:path';
import { matchesAny } from './glob.mjs';
import { syncShareExclude } from './share-exclude.mjs';

export { syncShareExclude };

const MAX_DEPTH = 4;
const NODE_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// Which installers were tested against a linked node_modules (test/share-installers.test.mjs): pnpm and bun keep the
// main checkout's files; `npm ci` empties the directory through the link. Only tested-safe lockfiles are shared.
const SAFE_LOCKS = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
// A package manifest or lockfile, in any directory: the files a linked node_modules is only valid for when unchanged.
export const isDependencyFile = (p) => NODE_FILES.includes(String(p).split('/').pop());

export const NOT_INSTALLED = 'node_modules is not installed in the project root: install there once, then run "orq init" again';
const REFUSED = [
  [['package-lock.json', 'npm-shrinkwrap.json'], 'npm projects are not shared: "npm ci" empties a linked node_modules'],
  [['yarn.lock'], 'yarn is untested'],
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
  // a pnpm or bun project with nothing installed in its root: every worktree would install its own copy
  return { paths, why: !found.includes('node_modules') && refusal(cwd, 'node_modules') === null ? NOT_INSTALLED : null };
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

const realOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

// pnpm run in a checkout whose node_modules links here (an install, or `pnpm run` reconciling first) writes its links
// through that checkout's path: node_modules/eslint -> ../../<worktree>/node_modules/.pnpm/eslint@x/... They work
// while that checkout exists and dangle once it is removed. Each such link in the main checkout's shared directories
// is pointed back at the same entry inside them (relative, replaced atomically: a reader sees the old or the new
// link). A checkout is foreign when it is outside `cwd` or in its .orq/. Only directories where pnpm keeps links are
// walked. Never throws. -> number of links repaired
export function repairShares(cwd, paths) {
  const root = realOrNull(cwd);
  if (root === null || !Array.isArray(paths)) return 0;
  const shares = paths.map((p) => ({ p, real: realOrNull(path.join(cwd, p)) }))
    .filter((s) => s.real !== null).sort((a, b) => b.p.length - a.p.length);
  const ours = (owner, base) => (owner === base || owner.startsWith(`${base}/`)) && !owner.startsWith(`${base}/.orq/`);
  const foreign = (owner) => ![root, path.resolve(cwd)].some((base) => ours(owner, base));
  const home = (target) => { // the same entry in the main checkout, or null
    for (const s of shares) {
      const i = target.indexOf(`/${s.p}/`);
      if (i >= 0) {
        if (!foreign(target.slice(0, i))) return null;
        const inside = path.join(s.real, target.slice(i + s.p.length + 2));
        return fs.lstatSync(inside, { throwIfNoEntry: false }) ? inside : null;
      }
    }
    return null;
  };
  let fixed = 0;
  const fix = (link) => {
    try {
      const inside = home(path.resolve(path.dirname(link), fs.readlinkSync(link)));
      if (inside === null) return;
      const tmp = `${link}.orq-repair-${process.pid}`;
      fs.rmSync(tmp, { force: true });
      fs.symlinkSync(path.relative(path.dirname(link), inside), tmp);
      fs.renameSync(tmp, link);
      fixed += 1;
    } catch {
      // left as it is: the next consumer tries again
    }
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) fix(p);
      else if (e.isDirectory() && (['node_modules', '.pnpm'].includes(e.name) || e.name.startsWith('@') || path.basename(dir) === '.pnpm')) walk(p);
    }
  };
  for (const s of shares) walk(s.real);
  return fixed;
}

// Link each path in the checkout at `dir` to the main checkout's directory when its parents are plain directories
// and git ignores it there (orq's exclude entry is made first, cheaply). Returns the paths linked. Any error on a
// path means "not linked", never a throw. Never deletes or replaces anything: symlink() fails when the path exists.
// Links into removed checkouts are repaired in the shared directories first (repairShares).
export function linkShares({
  dir, cwd, paths, git,
}) {
  repairShares(cwd, paths);
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
