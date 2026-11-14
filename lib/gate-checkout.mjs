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
function addCheckout(git, repo, workDir, sha) {
  try {
    git.addDetachedWorktree(repo, workDir, sha);
  } catch (e) {
    if (!String(e.message).startsWith('workDir exists and is not a worktree') || !isGateScratch(repo, workDir)) throw e;
    fs.rmSync(workDir, { recursive: true, force: true });
    git.addDetachedWorktree(repo, workDir, sha);
  }
}

// Run `body` inside a fresh detached checkout of `sha`; always remove it, never mask body's error. Shared
// dependency directories are linked in (only ignored ones, only when the manifests match: committed files stay fresh).
export async function inFreshCheckout({
  git, repo, workDir, sha, share,
}, body) {
  addCheckout(git, repo, workDir, sha);
  if (share.paths.length) {
    const paths = eligibleShares({
      cwd: repo, commit: sha, paths: share.paths, unit: share.unit, git,
    });
    linkShares({
      dir: workDir, cwd: repo, paths, git,
    });
  }
  let failure;
  try {
    await body();
  } catch (e) {
    failure = { error: e };
  }
  try {
    git.removeWorktree(repo, workDir);
  } catch (removeError) {
    if (!failure) failure = { error: removeError };
  }
  if (failure) throw failure.error;
}
