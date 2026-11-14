// The gate's own checkout: a fresh detached worktree of the commit being judged, made, linked and removed here.
import fs from 'node:fs';
import path from 'node:path';
import { eligibleShares, linkShares } from './share.mjs';

// A gate directory is orq's own scratch space: <repo>/.orq/gate/<unit>, with no symlink on the way (real paths).
function isGateScratch(repo, dir) {
  try {
    const root = path.join(fs.realpathSync(repo), '.orq', 'gate');
    return !fs.lstatSync(dir).isSymbolicLink() && fs.realpathSync(path.dirname(dir)) === root
      && path.dirname(fs.realpathSync(dir)) === root;
  } catch {
    return false;
  }
}

// A gate killed mid-run can leave its directory after `git worktree prune` dropped the registration. The generic
// helper refuses any such directory; here, and only inside .orq/gate/, it is cleared and the checkout made again.
// Returns the directory of the checkout: workDir, or one beside it when workDir cannot be had.
function addCheckout(git, repo, workDir, sha) {
  try {
    git.addDetachedWorktree(repo, workDir, sha);
    return workDir;
  } catch (e) {
    if (!String(e.message).startsWith('workDir exists and is not a worktree') || !isGateScratch(repo, workDir)) throw e;
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
    git.addDetachedWorktree(repo, workDir, sha);
    return workDir;
  } catch {
    // It cannot be cleared or it came back: a step orphaned by a killed gate still writes into it (seen with a
    // package install). Leave it to that process and gate in a directory of our own; `orq plan archive` removes both.
    const own = `${workDir}.gate-${process.pid}`;
    git.addDetachedWorktree(repo, own, sha);
    return own;
  }
}

// Run `body(dir)` inside a fresh detached checkout of `sha`; always remove it, never mask body's error. Shared
// dependency directories are linked in (only ignored ones, only when the manifests match: committed files stay fresh).
export async function inFreshCheckout({
  git, repo, workDir, sha, share,
}, body) {
  const dir = addCheckout(git, repo, workDir, sha);
  let failure;
  try {
    if (share.paths.length) { // inside the try: whatever happens, the checkout is removed below
      const paths = eligibleShares({
        cwd: repo, commit: sha, paths: share.paths, unit: share.unit, git,
      });
      linkShares({
        dir, cwd: repo, paths, git,
      });
    }
    await body(dir);
  } catch (e) {
    failure = { error: e };
  }
  try {
    git.removeWorktree(repo, dir);
  } catch (removeError) {
    if (!failure) failure = { error: removeError };
  }
  if (failure) throw failure.error;
}
