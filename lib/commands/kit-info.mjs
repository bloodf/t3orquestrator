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

export function playbookNotice(ctx, recorded) {
  const { mark, file } = currentPlaybook(ctx);
  return playbookLine(recorded, mark, file);
}
