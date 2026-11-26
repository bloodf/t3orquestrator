// orq watchdog tick: keeps orchestrator threads working. A supervisor keeps one directory per orchestrator under
// <T3ORQ_HOME>/watchdog/<name>/: path (the project), thread (its orchestrator thread id), start.txt (the start message;
// OLD_THREAD stands for the thread it takes over), optionally title, hold (leave it alone) and remote (it runs on that
// host, whose own watchdog looks after it). Each tick, for every directory not on hold:
//   at work                      -> nothing
//   failed                       -> a fresh orchestrator thread from start.txt
//   stopped, goal open or an undelivered inbox message
//                                -> one nudge; no ledger progress by the next tick -> a fresh orchestrator thread
// Never "needs the user" forever: when no fresh thread can start (3 in 2 hours, or no usable model) one line goes to
// <T3ORQ_HOME>/supervisor/escalations.log (once per 2 hours per orchestrator), and the next window tries again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { homeDir, ledgerPath, archiveRoot, projectConfigPath } from './paths.mjs';
import { loadProjectConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';
import { withLock } from './lock.mjs';
import { createT3, ACTIVE } from './t3.mjs';
import { inboxCount } from './commands/inbox.mjs';

export const CYCLE_MINUTES = 10;
const MIN = 60_000;
const WINDOW_MS = 120 * MIN; // replacements and escalations are counted over this window
const MAX_REPLACEMENTS = 3; // per window: a broken machine does not spawn a thread every tick
const JOBS = ['plan', 'implement-complex', 'implement', 'mechanical']; // strongest first, as the old watch.sh did
const NOT_ORCHESTRATORS = /fable|haiku/i; // decision-only and too-small models never orchestrate

export const watchdogRoot = (env) => path.join(homeDir(env), 'watchdog');
export const escalationsPath = (env) => path.join(homeDir(env), 'supervisor', 'escalations.log');

const read = (f) => fs.readFile(f, 'utf8').then((s) => s.trim(), () => null);
const exists = (f) => fs.stat(f).then(() => true, () => false);

export const NUDGE = 'Automatic message from the orq watchdog, not from the user: your turn ended while the standing goal is '
  + 'still open. Run `orq status` and go on as your start message says: finish the plan in flight, or archive it and plan '
  + 'the next part. If you need something only the user has, say it in one line and go on with the rest.';
export const NUDGE_INBOX = 'Automatic message from the orq watchdog, not from the user: a message from the user waits in '
  + 'the orq inbox. Run "orq wait" now; it delivers the message first.';

// Ledger bytes and archived plans: any orq event moves it.
async function progressMark(project) {
  const size = await fs.stat(ledgerPath(project)).then((s) => s.size, () => 0);
  const archives = (await fs.readdir(archiveRoot(project)).catch(() => [])).length;
  return `${archives}:${size}`;
}

// "replaced" lines: "<epoch ms> <instance> <model>[ failed]", one per attempt, a start that failed included (so it
// counts toward the limit and its route is not tried again); only those inside the window count
async function recentReplacements(dir, now) {
  const text = (await read(path.join(dir, 'replaced'))) ?? '';
  return text.split('\n').map((l) => l.split(' ')).filter(([at, i, m]) => Number(at) > now - WINDOW_MS && i && m)
    .map(([, instance, model]) => ({ instance, model }));
}

// Right before acting: the folder may have been put on hold, handed to another host or given another thread while
// this tick chose a route, and the thread may be at work again. -> why not to act, or null.
async function changed(w) {
  if (await exists(path.join(w.dir, 'hold'))) return 'put on hold';
  if (await read(path.join(w.dir, 'remote'))) return 'moved to another host';
  if ((await read(path.join(w.dir, 'thread'))) !== w.thread) return 'given another thread';
  try {
    const { thread } = w.t3.showThread(w.thread, { messages: 0 });
    return thread.status === w.status ? null : `now ${thread.status}`;
  } catch (e) {
    return `thread unreadable: ${String(e.message).split('\n')[0]}`;
  }
}

// The default route picker: `orq route --job <job> --json` in the project, as the orchestrator would see it.
async function routeCandidates(ctx, project, job) {
  const { route } = await import('./commands/route.mjs');
  const out = [];
  try {
    await route(['--job', job, '--json'], { ...ctx, cwd: project, stdout: { write: (s) => out.push(s) } });
    return JSON.parse(out.join('')).candidates ?? [];
  } catch {
    return [];
  }
}

// Strongest job tier first; inside it an account no other orchestrator uses, then any. Routes tried within the
// window are skipped, and after a failure the failed thread's whole account.
async function pickRoute(ctx, project, { tried, skipInstance, busy }) {
  const pick = ctx.deps?.watchdogRoute ?? ((job) => routeCandidates(ctx, project, job));
  for (const job of JOBS) {
    const list = (await pick(job)).filter((c) => !NOT_ORCHESTRATORS.test(c.model) && c.instance !== skipInstance
      && !tried.some((t) => t.instance === c.instance && t.model === c.model));
    if (list.length) return list.find((c) => !busy.has(c.instance)) ?? list[0];
  }
  return null;
}

async function escalate(ctx, w, why) {
  const mark = path.join(w.dir, 'escalated');
  const at = await fs.stat(mark).then((s) => s.mtimeMs, () => 0);
  if (ctx.now() - at < WINDOW_MS) return `${w.name}: ${why}; escalated already`;
  if (ctx.dryRun) return `${w.name}: ${why}; would escalate`;
  const file = escalationsPath(ctx.env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${new Date(ctx.now()).toISOString()} ${w.name}: ${why} (project ${w.project}, thread ${w.thread})\n`);
  await fs.writeFile(mark, '');
  return `${w.name}: ${why}; escalated to ${file}`;
}

async function replace(ctx, w, why, { busy, skipInstance = null }) {
  const now = ctx.now();
  const tried = await recentReplacements(w.dir, now);
  if (tried.length >= MAX_REPLACEMENTS) return escalate(ctx, w, `${why}, and ${tried.length} fresh threads in 2 h did not hold`);
  const pick = await pickRoute(ctx, w.project, { tried, skipInstance, busy })
    ?? (skipInstance ? await pickRoute(ctx, w.project, { tried, busy }) : null); // nothing else: the same account will do
  if (!pick) return escalate(ctx, w, `${why}, and orq has no usable model for a fresh thread`);
  const start = await read(path.join(w.dir, 'start.txt'));
  if (!start) return escalate(ctx, w, `${why}, and ${path.join(w.dir, 'start.txt')} is missing`);
  if (ctx.dryRun) return `${w.name}: ${why}; would start a fresh orchestrator on ${pick.instance} ${pick.model}`;
  const moved = await changed(w);
  if (moved) return `${w.name}: ${moved} while the tick chose a route; left alone`;
  const title = (await read(path.join(w.dir, 'title'))) || `${w.name} - Orchestrator`;
  let threadId;
  try {
    ({ threadId } = w.t3.startThread({
      project: w.project, message: start.replaceAll('OLD_THREAD', w.thread), provider: pick.instance, model: pick.model, title,
    }));
  } catch (e) {
    // an attempt all the same: the next tick tries another route, and the limit escalates a start that keeps failing
    await fs.appendFile(path.join(w.dir, 'replaced'), `${now} ${pick.instance} ${pick.model} failed\n`);
    return `${w.name}: ${why}; fresh thread on ${pick.instance} ${pick.model} failed to start: ${String(e.message).split('\n')[0]}`;
  }
  await fs.writeFile(path.join(w.dir, 'thread'), `${threadId}\n`);
  await fs.appendFile(path.join(w.dir, 'replaced'), `${now} ${pick.instance} ${pick.model}\n`);
  await fs.rm(path.join(w.dir, 'nudge.json'), { force: true });
  busy.add(pick.instance);
  return `${w.name}: ${why}; fresh orchestrator ${threadId} on ${pick.instance} ${pick.model} (took over ${w.thread})`;
}

async function nudge(ctx, w, mark, inbox) {
  if (ctx.dryRun) return `${w.name}: ${w.status}, would nudge`;
  const moved = await changed(w);
  if (moved) return `${w.name}: ${moved}; not nudged`;
  try {
    w.t3.sendThread(w.thread, inbox ? NUDGE_INBOX : NUDGE);
  } catch (e) {
    return `${w.name}: ${w.status}, nudge failed: ${String(e.message).split('\n')[0]}`;
  }
  await writeJsonAtomic(path.join(w.dir, 'nudge.json'), { at: ctx.now(), mark });
  return `${w.name}: ${w.status}${inbox ? ' with an undelivered inbox message' : ', goal open'}, nudged`;
}

// What to do with one orchestrator that is not at work.
async function act(ctx, w, busy) {
  const mark = await progressMark(w.project);
  const inbox = (await inboxCount(w.project).catch(() => 0)) > 0;
  if (w.config.goal === undefined && !inbox) return `${w.name}: ${w.status}, no open goal`;
  if (w.status === 'failed') return replace(ctx, w, 'thread failed', { busy, skipInstance: w.instance });
  const last = await readJson(path.join(w.dir, 'nudge.json'), null).catch(() => null);
  if (!last || last.mark !== mark) return nudge(ctx, w, mark, inbox); // first stop, or progress since the last nudge
  const waited = ctx.now() - last.at;
  if (waited < 0.8 * CYCLE_MINUTES * MIN) return `${w.name}: ${w.status}, nudged ${Math.floor(waited / MIN)} min ago`;
  return replace(ctx, w, `${w.status}, no progress ${Math.floor(waited / MIN)} min after a nudge`, { busy });
}

// One orchestrator directory -> what the tick knows of it, or a log line when there is nothing to do.
async function look(ctx, dir, name) {
  const thread = await read(path.join(dir, 'thread'));
  if (!thread) return null; // retired: no thread file
  if (await exists(path.join(dir, 'hold'))) return { line: `${name}: on hold` };
  if (await read(path.join(dir, 'remote'))) return { line: `${name}: runs on another host; its own watchdog looks after it` };
  const project = await read(path.join(dir, 'path'));
  if (!project) return { line: `${name}: no path file` };
  let config;
  try {
    config = await loadProjectConfig(projectConfigPath(project));
  } catch (e) {
    return { line: `${name}: project config unreadable: ${String(e.message).split('\n')[0]}` };
  }
  if (!config.t3?.bin) return { line: `${name}: no usable t3 in the project config (run "orq init" there)` };
  const t3 = (ctx.deps?.createT3 ?? createT3)({ bin: config.t3.bin, exec: ctx.deps.exec });
  try {
    const { thread: t } = t3.showThread(thread, { messages: 0 });
    return {
      dir, name, project, thread, config, t3, status: t.status, instance: t.instance ? t.instance.split('/')[0] : null,
    };
  } catch (e) {
    return { line: `${name}: cannot read thread ${thread}: ${String(e.message).split('\n')[0]}` };
  }
}

export async function watchdogTick(ctx) {
  const root = watchdogRoot(ctx.env);
  const names = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const seen = [];
  for (const name of names) {
    const w = await look(ctx, path.join(root, name), name);
    if (w) seen.push(w);
  }
  const busy = new Set(seen.filter((w) => w.instance).map((w) => w.instance));
  const lines = [];
  for (const w of seen) {
    if (w.line) lines.push(w.line);
    else if (ACTIVE.includes(w.status)) lines.push(`${w.name}: ${w.status}`);
    else lines.push(await act(ctx, w, busy));
  }
  return lines;
}

// The tick under a lock (two ticks never act on the same orchestrator), its lines appended to <watchdog>/log.
export async function runTick(ctx) {
  const root = watchdogRoot(ctx.env);
  await fs.mkdir(root, { recursive: true });
  const lines = await withLock(path.join(root, 'lock'), () => watchdogTick(ctx));
  const stamp = new Date(ctx.now()).toISOString();
  if (!ctx.dryRun) await fs.appendFile(path.join(root, 'log'), lines.map((l) => `${stamp} ${l}\n`).join(''));
  return lines;
}
