// `orq share repair`: a one-off fix for links that pnpm, run in a worktree whose node_modules linked the main
// checkout's (before pnpm projects stopped being shared), wrote into the main directory through that worktree's path:
//   <main>/node_modules/eslint -> ../../<worktree>/node_modules/.pnpm/eslint@x/node_modules/eslint
// Once the worktree is gone they dangle. A link is rewritten only when all of these hold:
// - the shared directory and every directory on the way to it are plain directories inside the project (no symlink
//   is followed out of it, and the walk never descends into a symlink);
// - its target lies in a known orq checkout: a registered worktree on an orq/* branch, a directory beside one (T3
//   keeps a project's worktrees together; a removed one is no longer registered), or orq's gate directory;
// - in that checkout the target is under a shared path, and that path there is gone or is a link to the main
//   checkout's directory (a checkout with its own node_modules is not the main checkout's business);
// - the same entry exists in the main checkout, is not the link itself or below it, and resolves after the rewrite
//   (otherwise the old link is put back);
// - the link is unchanged since it was read (checked again right before the swap).
// The new link gets a fresh random temporary name (never an existing file) and replaces the old one by rename.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// A plain directory at `rel` below `root`, with no symlink on the way: its absolute path, or null.
function plainDir(root, rel) {
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    const st = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return at;
}

const under = (p, dir) => p.startsWith(`${dir}/`);
const realOrSelf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// The orq checkout `target` lies in, or null: [checkout, path inside it].
function ownerOf(target, { worktrees, parents }) {
  const listed = worktrees.find((w) => under(target, w));
  if (listed) return [listed, target.slice(listed.length + 1)];
  const parent = parents.find((p) => under(target, p));
  if (!parent) return null;
  const [name, ...rest] = target.slice(parent.length + 1).split('/');
  return rest.length ? [path.join(parent, name), rest.join('/')] : null;
}

// Walk the directories pnpm keeps links in; call `visit(link)` for every symlink. Never follows a symlink.
function eachLink(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) visit(p);
    else if (e.isDirectory() && (['node_modules', '.pnpm'].includes(e.name) || e.name.startsWith('@') || path.basename(dir) === '.pnpm')) eachLink(p, visit);
  }
}

function swap(link, to) {
  const tmp = `${link}.orq-repair-${randomBytes(8).toString('hex')}`;
  fs.symlinkSync(to, tmp); // fails when the name exists: nothing is ever overwritten here
  fs.renameSync(tmp, link);
}

/**
 * cwd: the main checkout; paths: the `share` config; worktrees: absolute paths of the project's registered worktrees
 * on orq/* branches. dryRun: change nothing. beforeSwap(link): test seam, runs between the read and the swap.
 * -> { repaired: [{link, to}], skipped: {reason: count}, refused: [why] } (links relative to cwd)
 */
export function repairShares({
  cwd, paths, worktrees, dryRun = false, beforeSwap = () => {},
}) {
  const root = fs.realpathSync(cwd);
  const out = { repaired: [], skipped: {}, refused: [] };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };
  const shares = [];
  for (const p of paths) {
    const dir = plainDir(root, p);
    if (dir) shares.push({ p, dir });
    else out.refused.push(`${p}: not a plain directory inside the project`);
  }
  shares.sort((a, b) => b.p.length - a.p.length);
  const orqDir = path.join(root, '.orq');
  const all = [...new Set(worktrees.flatMap((w) => [w, realOrSelf(w)]))];
  const external = all.filter((w) => w !== root && !under(w, root));
  const known = {
    worktrees: [...external, ...all.filter((w) => under(w, orqDir))],
    parents: [...new Set([...external.map((w) => path.dirname(w)), path.join(orqDir, 'gate')])],
  };
  const visit = (link) => {
    const was = fs.readlinkSync(link);
    const target = path.resolve(path.dirname(link), was);
    if (under(target, root) && !under(target, orqDir)) return undefined; // inside the main checkout: fine
    const owner = ownerOf(target, known);
    if (!owner) return fs.existsSync(link) ? undefined : skip('dangling, not into a known orq checkout');
    const [checkout, inner] = owner;
    const share = shares.find((s) => under(inner, s.p));
    if (!share) return skip('not under a shared path');
    const there = path.join(checkout, share.p);
    const st = fs.lstatSync(there, { throwIfNoEntry: false });
    if (st && !(st.isSymbolicLink() && fs.existsSync(there) && fs.realpathSync(there) === share.dir)) return skip('that checkout has its own dependencies');
    const inside = path.join(share.dir, inner.slice(share.p.length + 1));
    if (inside === link || under(inside, link)) return skip('would point at itself');
    if (!fs.existsSync(inside)) return skip('no such entry in the main checkout');
    const to = path.relative(path.dirname(link), inside);
    out.repaired.push({ link: path.relative(root, link), to });
    if (dryRun) return undefined;
    beforeSwap(link);
    const now = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!now?.isSymbolicLink() || fs.readlinkSync(link) !== was) {
      out.repaired.pop();
      return skip('changed while repairing');
    }
    swap(link, to);
    if (!fs.existsSync(link)) { // a loop through links on the way: put the old one back
      swap(link, was);
      out.repaired.pop();
      return skip('would not resolve');
    }
    return undefined;
  };
  for (const s of shares) {
    eachLink(s.dir, (link) => {
      try {
        visit(link);
      } catch (e) {
        skip(`error: ${e.code ?? e.message}`);
      }
    });
  }
  return out;
}
