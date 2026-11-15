// orq inbox: a message from the user to the orchestrator, delivered by its next `orq wait`. A message sent to the
// orchestrator's thread queues until its turn ends, which can be hours; `orq wait` returns every few minutes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { inboxPath, inboxReadDir, projectDir } from '../paths.mjs';
import { exists } from '../archive-move.mjs';
import { usage } from './common.mjs';

const MAX_LINES = 60;
const HEADER = /^## \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const lines = (text) => text.replace(/\n+$/, '').split('\n');

export async function inbox(args, ctx) {
  const text = args.length === 1 && args[0] === '-' ? await ctx.stdin() : args.join(' ');
  if (text.trim() === '') throw usage('inbox: usage: inbox <text> | inbox - < text');
  await fs.mkdir(projectDir(ctx.cwd), { recursive: true });
  await fs.appendFile(inboxPath(ctx.cwd), `## ${new Date(ctx.now()).toISOString()}\n${text.replace(/\n+$/, '')}\n`); // one write
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

// Moves a non-empty inbox to .orq/inbox-read/ (one rename: delivered once) and returns the lines `orq wait` prints.
export async function takeInbox(ctx) {
  if (await inboxCount(ctx.cwd) === 0) return null;
  const dir = inboxReadDir(ctx.cwd);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date(ctx.now()).toISOString();
  let name = `${stamp}.md`;
  for (let n = 2; await exists(path.join(dir, name)); n += 1) name = `${stamp}-${n}.md`;
  await fs.rename(inboxPath(ctx.cwd), path.join(dir, name));
  const body = lines(await fs.readFile(path.join(dir, name), 'utf8'));
  const shown = body.length > MAX_LINES
    ? [...body.slice(0, MAX_LINES - 1), `… ${body.length - MAX_LINES + 1} more lines in .orq/inbox-read/${name}`]
    : body;
  return ['message: from the user, through orq inbox; read it and follow it before anything else', ...shown];
}
