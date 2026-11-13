import { fileURLToPath } from 'node:url';
import { defaultExec } from '../git.mjs';
import { createKit, short } from '../kit.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export const kitDirOf = (ctx) => ctx.deps.kitDir ?? REPO;

export const kitFor = (ctx) => createKit({ exec: ctx.deps.gitExec ?? defaultExec, dir: kitDirOf(ctx) });

export function kitSha(ctx) {
  const kit = kitFor(ctx);
  const head = kit.isCheckout() ? kit.head() : null;
  return head ? short(head) : 'unknown';
}
