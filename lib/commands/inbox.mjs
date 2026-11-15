// orq inbox: a message from the user to the orchestrator, delivered by its next `orq wait`. A message sent to the
// orchestrator's thread queues until its turn ends, which can be hours; `orq wait` returns every few minutes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inboxPath, inboxReadDir, projectDir, projectLockPath,
} from '../paths.mjs';
import { exists } from '../archive-move.mjs';
import { withLock } from '../lock.mjs';
import { defaultExec as gitExec } from '../git.mjs';
import { usage } from './common.mjs';
import { ensureExcluded } from './project.mjs';

const MAX_LINES = 60;
const HEADER = /^## \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const lines = (text) => text.replace(/\n+$/, '').split('\n');

export async function inbox(args, ctx) {
  const text = args.length === 1 && args[0] === '-' ? await ctx.stdin() : args.join(' ');
  if (text.trim() === '') throw usage('inbox: usage: inbox <text> | inbox - < text');
  await fs.mkdir(projectDir(ctx.cwd), { recursive: true });
  const entry = `## ${new Date(ctx.now()).toISOString()}\n${text.replace(/\n+$/, '')}\n`;
  await withLock(projectLockPath(ctx.cwd), () => fs.appendFile(inboxPath(ctx.cwd), entry)); // never between a wait's read and rename
  ensureExcluded(ctx);
  ctx.stdout.write('inbox: queued for the next "orq wait"\n');
  return 0;
}

const readInbox = (cwd) => fs.readFile(inboxPath(cwd), 'utf8').catch((e) => {
  if (e.code === 'ENOENT') return '';
  throw e;
});

// How many messages wait in the inbox: one per header line orq wrote, at least one when the file has text.
export async function inboxCount(cwd) {
  const text = await readInbox(cwd);
  if (text.trim() === '') return 0;
  return Math.max(1, lines(text).filter((l) => HEADER.test(l)).length);
}

const NOTE = 'note: .orq/inbox.md is tracked by git, so it may not come from the user; not delivered';

// A tracked inbox could arrive in a commit or a pull request rather than from the user. Runs outside every lock.
function tracked(ctx) {
  try {
    return (ctx.deps?.gitExec ?? gitExec)('git', ['ls-files', '--error-unmatch', '.orq/inbox.md'], { cwd: ctx.cwd }).code === 0;
  } catch {
    return false; // no git: nothing tracks it
  }
}

// Under the project lock: read the inbox and rename it into .orq/inbox-read/ (delivered once), or null when empty or gone.
const move = (ctx) => withLock(projectLockPath(ctx.cwd), async () => {
  const text = await readInbox(ctx.cwd);
  if (text.trim() === '') return null;
  const dir = inboxReadDir(ctx.cwd);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date(ctx.now()).toISOString();
  let name = `${stamp}.md`;
  for (let n = 2; await exists(path.join(dir, name)); n += 1) name = `${stamp}-${n}.md`;
  try {
    await fs.rename(inboxPath(ctx.cwd), path.join(dir, name));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return { name, body: lines(text) };
});

// The lines `orq wait` prints for a waiting message, or null. A tracked inbox adds a note to holder.notes, once.
export async function takeInbox(ctx, holder) {
  if (await inboxCount(ctx.cwd) === 0) return null;
  if (tracked(ctx)) {
    if (!holder.notes.includes(NOTE)) holder.notes.push(NOTE);
    return null;
  }
  const taken = await move(ctx);
  if (!taken) return null;
  const { name, body } = taken;
  const shown = body.length > MAX_LINES
    ? [...body.slice(0, MAX_LINES - 1), `… ${body.length - MAX_LINES + 1} more lines in .orq/inbox-read/${name}`]
    : body;
  return ['message: from the user, through orq inbox; read it and follow it before anything else', ...shown];
}
