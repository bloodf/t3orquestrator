// orq inbox: a message from the user to the orchestrator, delivered by its next `orq wait`. A message sent to the
// orchestrator's thread queues until its turn ends, which can be hours; `orq wait` returns every few minutes.
// With no `orq wait` running (no live holder of the runner lock) the message is still queued, the sender is told it
// was not delivered, and an orchestrator thread that is not at work is woken to run `orq wait`.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inboxPath, inboxReadDir, projectConfigPath, projectDir, projectLockPath, runnerLockPath,
} from '../paths.mjs';
import { exists } from '../archive-move.mjs';
import { withLock } from '../lock.mjs';
import { defaultExec as gitExec } from '../git.mjs';
import { readJson } from '../store.mjs';
import { loadProjectConfig } from '../config.mjs';
import { createT3, ACTIVE } from '../t3.mjs';
import { pidAlive } from '../gaterun.mjs';
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
  if (await waitRunning(ctx)) {
    ctx.stdout.write('inbox: queued for the next "orq wait"\n');
    return 0;
  }
  ctx.stdout.write(`not delivered: no orq wait is running; queued for the next "orq wait"\n${await wake(ctx)}`);
  return 0;
}

const WAKE = 'orq inbox: a message from the user waits for you. Run "orq wait" now; it delivers the message first.';

// A live process holds the runner lock: `orq wait` (or a ship or an archive, which return to it).
async function waitRunning(ctx) {
  const held = await readJson(runnerLockPath(ctx.cwd), null).catch(() => null);
  return Number.isInteger(held?.pid) && (ctx.deps?.isAlive ?? pidAlive)(held.pid);
}

// The line saying whether the orchestrator thread was woken. A thread at work is not sent to: T3 queues a message to
// a running thread until its turn ends, and that turn reaches `orq wait` on its own.
async function wake(ctx) {
  let config;
  try {
    config = await loadProjectConfig(projectConfigPath(ctx.cwd));
  } catch {
    return '';
  }
  const id = config.orchestrator?.threadId;
  if (!id || !config.t3?.bin) return 'note: no orchestrator thread is recorded ("orq sync" from it records it); tell it to run "orq wait"\n';
  if (ctx.env?.T3CODE_THREAD_ID === id) return ''; // the orchestrator itself
  try {
    const t3 = createT3({ bin: config.t3.bin, exec: ctx.deps.exec });
    const { thread } = t3.showThread(id, { messages: 0 });
    if (ACTIVE.includes(thread.status)) return `note: orchestrator thread ${id} is at work; it reads the message at its next "orq wait"\n`;
    t3.sendThread(id, WAKE);
    return `woke orchestrator thread ${id} to run "orq wait"\n`;
  } catch (e) {
    return `note: could not wake orchestrator thread ${id}: ${String(e.message).split('\n')[0]}\n`;
  }
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
