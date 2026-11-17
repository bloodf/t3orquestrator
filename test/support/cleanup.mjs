// Test support (no tests here): ledgers and worktrees for the cleanup tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGit, defaultExec } from '../../lib/git.mjs';
import { sh } from './project.mjs';

export const git = createGit({ exec: defaultExec });
export const NOW = Date.parse('2026-11-17T12:00:00Z');
export const exists = (f) => fs.lstat(f).then(() => true, () => false);
export const fxOf = (p, now = NOW) => ({ cwd: p.repo, env: p.env, git, now: () => now });
export const orqDir = (p, ...f) => path.join(p.repo, '.orq', ...f);

export const plan = (p, id = 'p') => ({ type: 'plan-started', unit: null, at: 1, planId: id, baseSha: p.baseSha, integrationBranch: `orq/${id}/integration` });
export const launch = (unit, branch, at = 2) => ({
  type: 'launched', unit, at, attempt: 1, threadId: `t-${branch.split('/').at(-1)}`, branch, key: 'pa::m2', instance: 'pa', model: 'm2', tier: 2,
});
export const merged = (unit, at = 5) => [
  { type: 'thread-ended', unit, at, status: 'completed' },
  { type: 'gated', unit, at, attempt: 1, verdict: 'pass', failures: [], headSha: 'h' }, { type: 'integrated', unit, at: at + 1, head: 'h' },
];
export const writeLedger = (file, events) => fs.writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
export const ledger = (p, events) => writeLedger(orqDir(p, 'ledger.jsonl'), [plan(p), ...events]);
export const worktreeOn = (p, name, branch) => {
  const dir = path.join(p.root, 'wt', name);
  sh(p.repo, 'worktree', 'add', '-q', '-b', branch, dir, p.baseSha);
  return dir;
};
export const hasBranch = (p, b) => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${b}`], { cwd: p.repo }).status === 0;
export const listed = (p) => sh(p.repo, 'worktree', 'list', '--porcelain');

