import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit, defaultExec } from '../lib/git.mjs';
import { removeUnitWorktrees } from '../lib/worktree-cleanup.mjs';
import { makeProject, unitSpec, sh } from './support/project.mjs';

const git = createGit({ exec: defaultExec });
const launched = (unit, branch) => ({ type: 'launched', unit, at: 1, attempt: 1, threadId: `t-${branch}`, branch });

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
  const events = [launched('a', 'orq/p/a-a1'), launched('a', 'orq/p/a-a1-l2'), launched('a', 'orq/p/a-a2'), launched('a-a1', 'orq/p/a-a1-a1')];
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, git }, 'a'), 2);
  await assert.rejects(fs.stat(first));
  await assert.rejects(fs.stat(second));
  await fs.stat(path.join(dirty, 'notes.txt'));
  await fs.stat(other);
  for (const b of ['orq/p/a-a1', 'orq/p/a-a1-l2', 'orq/p/a-a2']) sh(p.repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`);
});

test('worktree cleanup never throws: an unreadable ledger or a failing git removes nothing', async (t) => {
  const p = await makeProject(t, [unitSpec('a')]);
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, git }, 'a'), 0); // no ledger
  await fs.writeFile(path.join(p.repo, '.orq', 'ledger.jsonl'), `${JSON.stringify(launched('a', 'orq/p/a-a1'))}\n`);
  const broken = { listWorktrees: () => { throw new Error('git broke'); } };
  assert.equal(await removeUnitWorktrees({ cwd: p.repo, git: broken }, 'a'), 0);
});
