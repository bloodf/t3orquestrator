const SHA = /^[0-9a-f]{40}$/;

function validate(baseSha, units) {
  if (!SHA.test(baseSha)) throw new Error('baseSha must be a full commit SHA');
  for (const u of units) {
    if (!SHA.test(u.sha)) throw new Error(`unit ${u.id} sha must be a full commit SHA`);
  }
}

function checkWorktree(git, dir, branch) {
  const current = git.currentBranch(dir);
  if (current !== branch) throw new Error(`integration worktree is on ${current}, expected ${branch}`);
  if (!git.isClean(dir).clean) throw new Error('integration worktree has uncommitted changes');
}

export function integrate({ repo, dir, branch, baseSha, units, git }) {
  validate(baseSha, units);
  git.ensureWorktree(repo, dir, branch, baseSha);
  checkWorktree(git, dir, branch);
  const merged = [];
  for (const unit of units) {
    if (!git.isAncestor(dir, unit.sha)) {
      const r = git.merge(dir, unit.sha);
      if (!r.ok) return { ok: false, merged, conflict: { unit: unit.id, files: r.conflicts } };
    }
    merged.push(unit.id);
  }
  return { ok: true, merged, head: git.headSha(dir) };
}
