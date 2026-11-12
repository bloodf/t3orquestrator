// Test support (no tests here): a real temp git repo set up as an orq project, plus a machine home.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const model = (instance, name, tier) => [`${instance}::${name}`, {
  instance, model: name, family: 'f', tier, tierSource: 'user', available: true, confirmedAt: null,
  failures: 0, cooldownUntil: null, lastUsedAt: null, outcomes: {}, source: 'user', rejectedAt: null,
}];
const inst = { enabled: true, constraints: [], limit: null, failures: 0, cooldownUntil: null };

export const REGISTRY = {
  version: 1,
  syncedAt: 1,
  instances: { pa: inst, pb: inst },
  models: Object.fromEntries([model('pa', 'm2', 2), model('pb', 'm2', 2), model('pa', 'm3', 3), model('pb', 'm4', 4)]),
};

export const unitSpec = (id, over = {}) => ({
  id, title: `do ${id}`, job: 'implement', deps: [], paths: [`${id}.txt`], forbidden: [],
  evidence: `test -f ${id}.txt`, order: `.orq/orders/${id}.md`, ...over,
});

// units: array of plan units; opts: { cap, checks, registry }
export async function makeProject(t, units, { cap = 2, checks = {}, registry = REGISTRY } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orq-sched-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  await fs.mkdir(path.join(repo, '.orq', 'orders'), { recursive: true });
  await fs.mkdir(home);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.invalid');
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '.orq/\n');
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  for (const u of units) await fs.writeFile(path.join(repo, u.order), `Work order for ${u.id}.\n`);
  await fs.writeFile(path.join(repo, '.orq', 'plan.json'), JSON.stringify({ goal: 'test goal', units }));
  await fs.writeFile(path.join(repo, '.orq', 'config.json'), JSON.stringify({
    t3: { bin: 't3', version: 'v1' }, checks: { setup: null, unit: null, full: null, ...checks },
  }));
  await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify(registry));
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ cap }));
  return { root, repo, home, env: { T3ORQ_HOME: home }, baseSha: sh(repo, 'rev-parse', 'HEAD') };
}

// Simulate a worker: commit files onto `branch` without touching other checkouts.
export async function commitOn(repo, branch, files, message = 'work') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orq-worker-'));
  await fs.rm(dir, { recursive: true });
  sh(repo, 'worktree', 'add', '-q', dir, branch);
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  const sha = sh(dir, 'rev-parse', 'HEAD');
  sh(repo, 'worktree', 'remove', '--force', dir);
  return sha;
}
