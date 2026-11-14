import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit, defaultExec } from '../lib/git.mjs';
import { removeUnitWorktrees } from '../lib/worktree-cleanup.mjs';
import { writeLease } from '../lib/leases.mjs';
import { makeProject, unitSpec, sh } from './support/project.mjs';

const git = createGit({ exec: defaultExec });
// the removal runs detached: wait for the directory to go
async function gone(dir) {
  for (let i = 0; i < 100; i += 1) {
    if (!(await fs.stat(dir).catch(() => null))) return;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  assert.fail(`${dir} was not removed`);
}
const launched = (unit, branch) => ({ type: 'launched', unit, at: 1, attempt: 1, threadId: `t-${branch.split('/').at(-1)}`, branch });

test('an integrated unit: the worktrees of all its launches are removed, branches kept; dirty and foreign ones stay', async (t) => {
  const p = await makeProject(t, [unitSpec('a'), unitSpec('a-a1')]);
  const wt = async (name, branch) => {
    const dir = path.join(p.root, 'wt', name);
    sh(p.repo, 'worktree', 'add', '-q', '-b', branch, dir, p.baseSha);
    return dir;
  };
  const first = await wt('a1', 'orq/p/a-a1'); // a launch whose provider failed
  const second = await wt('a1-l2', 'orq/p/a-a1-l2'); // the launch that passed
  const dirty = await wt('a2', 'orq/p/a-a2');
  await fs.writeFile(path.join(dirty, 'notes.txt'), 'uncommitted\n');
  const other = await wt('other', 'orq/p/a-a1-a1'); // unit "a-a1": a name that only looks like a launch of "a"
  const running = await wt('a3', 'orq/p/a-a3'); // a thread orq gave up on that still holds its lease
  const events = [launched('a', 'orq/p/a-a1'), launched('a', 'orq/p/a-a1-l2'), launched('a', 'orq/p/a-a2'), launched('a', 'orq/p/a-a3'),
    launched('a-a1', 'orq/p/a-a1-a1')];
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await writeLease(path.join(p.home, 'leases'), {
    threadId: 't-a-a3', project: p.repo, unit: 'a', instance: 'pa', model: 'm2', startedAt: 1, heartbeatAt: 1, blocked: false, abandoned: true,
  });
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git }, 'a'), 3); // started; git itself refuses the dirty one
  await gone(first);
  await gone(second);
  await fs.stat(path.join(dirty, 'notes.txt'));
  await fs.stat(other);
  await fs.stat(running);
  for (const b of ['orq/p/a-a1', 'orq/p/a-a1-l2', 'orq/p/a-a2']) sh(p.repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);
});

test('worktree cleanup never throws: an unreadable ledger or a failing git removes nothing', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git }, 'a'), 0); // no ledger
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${JSON.stringify(launched('a', 'orq/p/a-a1'))}\n`);
  const broken = { listWorktrees: () => { throw new Error('git broke'); } };
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, env: p.env, git: broken }, 'a'), 0);
});
