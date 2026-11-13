// The orq kit is the git checkout this code runs from. All git calls go through the injected exec.
import fs from 'node:fs';
import { HARDEN } from './git.mjs';

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
export const short = (sha) => sha.slice(0, 12);

export function highestTag(tags) {
  const key = (t) => SEMVER.exec(t).slice(1).map(Number);
  const cmp = (a, b) => { const [x, y] = [key(a), key(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  return tags.filter((t) => SEMVER.test(t)).sort(cmp).at(-1) ?? null;
}

export const isSha = (v) => SHA.test(v);

export function createKit({ exec, dir }) {
  const git = (args) => {
    try {
      return exec('git', [...HARDEN, ...args], { cwd: dir, timeoutMs: 120000 });
    } catch (e) {
      return { code: 1, stdout: '', stderr: e.message };
    }
  };
  const out = (args) => { const r = git(args); return r.code === 0 ? r.stdout.trim() : null; };
  const tags = (args) => (out(args) ?? '').split('\n').filter(Boolean);
  return {
    isCheckout() {
      const top = out(['rev-parse', '--show-toplevel']);
      return top !== null && fs.realpathSync(top) === fs.realpathSync(dir);
    },
    head: () => out(['rev-parse', '--verify', 'HEAD']),
    // a failed status cannot prove the kit clean
    isDirty: () => (out(['status', '--porcelain']) ?? 'unknown') !== '',
    branch: () => out(['symbolic-ref', '--short', '-q', 'HEAD']),
    isAncestor: (a, b) => git(['merge-base', '--is-ancestor', a, b]).code === 0,
    tagAt: (sha) => highestTag(tags(['tag', '--points-at', sha])),
    allTags: () => tags(['tag', '--list']),
    resolve: (ref) => out(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]),
    // -> null on success, else the last line of git's complaint
    fetch() {
      const r = git(['fetch', '--tags', 'origin']);
      return r.code === 0 ? null : (String(r.stderr || r.stdout).trim().split('\n').at(-1) || 'no output').slice(0, 200);
    },
    checkout(sha) {
      const r = git(['checkout', '--detach', '--end-of-options', sha]);
      if (r.code !== 0) throw new Error(`update: git checkout failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    },
  };
}
