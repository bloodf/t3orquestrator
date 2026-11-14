import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function defaultExec(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd} ${args[0]}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const GLOBAL = ['-c', 'core.quotepath=false', '-c', 'diff.noprefix=false', '-c', 'status.showUntrackedFiles=all',
  // a worker can plant hooks and fsmonitor in the shared .git; never execute them
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const DIFF = ['--no-color', '--no-ext-diff', '--no-textconv'];
const EOO = '--end-of-options';

const lastLine = (s) => String(s).trim().split('\n').at(-1);
const lines = (s) => s.split('\n').filter((l) => l !== '');

// `git diff --name-status -z`: NUL-separated tokens; renames and copies carry two paths.
function parseNameStatus(stdout) {
  const tokens = stdout.split('\0');
  const out = [];
  for (let i = 0; i < tokens.length && tokens[i] !== '';) {
    const status = tokens[i][0];
    if (status === 'R') {
      out.push({ status: 'R', path: tokens[i + 2] }, { status: 'D', path: tokens[i + 1] });
      i += 3;
    } else if (status === 'C') {
      out.push({ status: 'A', path: tokens[i + 2] });
      i += 3;
    } else {
      out.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }
  return out;
}

// `git worktree list --porcelain`: blank-line separated blocks; a detached worktree has no `branch` line.
export function parseWorktrees(stdout) {
  return stdout.split('\n\n').map((block) => {
    const ls = block.split('\n');
    const wt = ls.find((l) => l.startsWith('worktree '));
    const br = ls.find((l) => l.startsWith('branch '));
    return wt ? { path: wt.slice(9), branch: br ? br.slice(7) : null } : null;
  }).filter(Boolean);
}

const headerPath = (l, prefix) => {
  const p = l.slice(4).replace(/\t$/, '');
  return p === '/dev/null' ? null : p.slice(prefix.length);
};

// Collect lines starting with `sign` ('+' or '-') from a `-U0` diff, tracking the current file.
function parseChangedLines(stdout, sign) {
  const out = [];
  let oldPath = null;
  let newPath = null;
  let inHunk = false;
  for (const l of stdout.split('\n')) {
    if (l.startsWith('diff --git ')) {
      inHunk = false; oldPath = null; newPath = null;
    } else if (l.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk && l.startsWith('--- ')) {
      oldPath = headerPath(l, 'a/');
    } else if (!inHunk && l.startsWith('+++ ')) {
      newPath = headerPath(l, 'b/');
    } else if (inHunk && l[0] === sign) {
      const path = sign === '+' ? newPath : (newPath || oldPath);
      if (path) out.push({ path, line: l.slice(1) });
    }
  }
  return out;
}

export function createGit({ exec }) {
  const call = (cwd, args) => exec('git', [...GLOBAL, ...args], { cwd, timeoutMs: 60000 });
  const run = (cwd, args, ok = [0]) => {
    const r = call(cwd, args);
    if (!ok.includes(r.code)) throw new Error(`git ${args[0]} failed (exit ${r.code}): ${lastLine(r.stderr)}`);
    return r;
  };
  const out = (cwd, args) => run(cwd, args).stdout.trim();
  const range = (base, head) => `${base}...${head}`;

  const isWorktree = (repo, dir) => {
    const real = fs.realpathSync(dir);
    return lines(out(repo, ['worktree', 'list', '--porcelain'])).includes(`worktree ${real}`);
  };
  const branchExists = (repo, branch) =>
    run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]).code === 0;

  return {
    isClean(cwd) {
      const files = lines(run(cwd, ['status', '--porcelain']).stdout).map((l) => l.slice(3));
      return { clean: files.length === 0, files };
    },
    commitsAhead: (cwd, base, head = 'HEAD') => Number(out(cwd, ['rev-list', '--count', EOO, `${base}..${head}`])),
    changedFiles: (cwd, base, head = 'HEAD') =>
      parseNameStatus(run(cwd, ['diff', '--name-status', '-z', '-M', ...DIFF, EOO, range(base, head)]).stdout),
    addedLines: (cwd, base, head = 'HEAD') =>
      parseChangedLines(run(cwd, ['diff', '-U0', ...DIFF, EOO, range(base, head)]).stdout, '+'),
    removedLines: (cwd, base, head = 'HEAD') =>
      parseChangedLines(run(cwd, ['diff', '-U0', ...DIFF, EOO, range(base, head)]).stdout, '-'),
    resolveSha: (cwd, ref) => out(cwd, ['rev-parse', '--verify', EOO, `${ref}^{commit}`]),
    // a file's content at a commit, or null when the commit does not have it
    showFile(cwd, sha, file) {
      const r = call(cwd, ['cat-file', 'blob', `${sha}:${file}`]);
      return r.code === 0 ? r.stdout : null;
    },
    // which of `paths` git ignores in the checkout at cwd (exit 1: none of them)
    ignored(cwd, paths) {
      if (paths.length === 0) return [];
      return lines(run(cwd, ['check-ignore', EOO, ...paths], [0, 1]).stdout);
    },
    commonDir: (cwd) => path.resolve(cwd, out(cwd, ['rev-parse', '--git-common-dir'])),
    ensureWorktree(repo, dir, branch, base) {
      if (fs.existsSync(dir)) {
        if (isWorktree(repo, dir)) return;
        throw new Error(`${dir} exists but is not a registered worktree`);
      }
      if (branchExists(repo, branch)) run(repo, ['worktree', 'add', EOO, dir, branch]);
      else run(repo, ['worktree', 'add', '-b', branch, EOO, dir, base]);
    },
    addDetachedWorktree(repo, dir, sha) {
      run(repo, ['worktree', 'prune']); // drop registrations whose directory is gone
      if (fs.existsSync(dir) && isWorktree(repo, dir)) run(repo, ['worktree', 'remove', '--force', EOO, dir]);
      if (fs.existsSync(dir)) throw new Error(`workDir exists and is not a worktree: ${dir}`);
      run(repo, ['worktree', 'add', '--detach', EOO, dir, sha]);
    },
    listWorktrees: (repo) => parseWorktrees(out(repo, ['worktree', 'list', '--porcelain'])),
    // no --force: git itself refuses a worktree with modified or untracked files, or a locked one
    tryRemoveWorktree(repo, dir) {
      const r = call(repo, ['worktree', 'remove', EOO, dir]);
      return r.code === 0 ? { ok: true } : { ok: false, error: lastLine(r.stderr) };
    },
    removeWorktree: (repo, dir) => run(repo, ['worktree', 'remove', '--force', EOO, dir]),
    merge(cwd, ref) {
      const r = call(cwd, ['merge', '--no-ff', '--no-edit', EOO, ref]);
      if (r.code === 0) return { ok: true };
      const conflicts = lines(run(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout);
      if (conflicts.length === 0) throw new Error(`git merge failed (exit ${r.code}): ${lastLine(r.stderr || r.stdout)}`);
      run(cwd, ['merge', '--abort']);
      return { ok: false, conflicts };
    },
    isAncestor: (cwd, ref) => run(cwd, ['merge-base', '--is-ancestor', EOO, ref, 'HEAD'], [0, 1]).code === 0,
    currentBranch: (cwd) => out(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    headSha: (cwd) => out(cwd, ['rev-parse', 'HEAD']),
  };
}
