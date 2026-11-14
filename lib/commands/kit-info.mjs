import { fileURLToPath } from 'node:url';
import { defaultExec } from '../git.mjs';
import { createKit, short } from '../kit.mjs';
import { playbookFile, playbookLine, playbookMark } from '../playbook-mark.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export const kitDirOf = (ctx) => ctx.deps.kitDir ?? REPO;

export const kitFor = (ctx) => createKit({ exec: ctx.deps.gitExec ?? defaultExec, dir: kitDirOf(ctx) });

export function kitSha(ctx) {
  const kit = kitFor(ctx);
  const head = kit.isCheckout() ? kit.head() : null;
  return head ? short(head) : 'unknown';
}

// The playbook of the kit this orq runs from: what to record, and the line to print when the record differs.
export function currentPlaybook(ctx) {
  const dir = kitDirOf(ctx);
  const head = kitSha(ctx);
  return { mark: playbookMark(dir, head === 'unknown' ? null : head), file: playbookFile(dir) };
}

// One record per orchestrator thread (T3CODE_THREAD_ID), so a second orchestrator's init does not silence the line
// for the first; a caller without a thread id shares one record ('_'), which a config from before this version
// (`playbook`, a single record) still provides. At most 10 records are kept, the most recent.
const MAX_RECORDS = 10;
const NO_THREAD = '_';
const me = (env) => env.T3CODE_THREAD_ID || NO_THREAD;

export function recordedPlaybook(config, env) {
  const own = config.playbooks?.[me(env)];
  return own ?? (me(env) === NO_THREAD ? config.playbook : undefined);
}

export function withPlaybookRecord(config, env, mark, now) {
  const all = { ...(config.playbooks ?? {}), [me(env)]: { ...mark, at: now } };
  const keep = Object.entries(all).sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_RECORDS);
  return Object.fromEntries(keep);
}

export function playbookNotice(ctx, config) {
  const { mark, file } = currentPlaybook(ctx);
  return playbookLine(recordedPlaybook(config, ctx.env), mark, file);
}
