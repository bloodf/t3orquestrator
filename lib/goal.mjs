// The standing goal (`goal` in .orq/config.json): one clean line, echoed where an orchestrator would otherwise stop.
import { cleanLine } from './worker-status.mjs';

export const MAX_GOAL = 500;

// One line, no control characters, whitespace runs collapsed.
export const cleanGoal = (text) => cleanLine(text, Infinity).replace(/\s+/g, ' ');

const OPEN = 'the goal is still open:';
export const NEXT = {
  wait: `${OPEN} finish this plan as the playbook says, run "orq plan archive", then plan the next part and call "orq wait" again in this same turn`,
  archive: `${OPEN} plan its next part now and call "orq wait"; run "orq config set goal null" only when nothing of it is left to build`,
  noPlan: `${OPEN} plan its next part, run "orq plan check", then call "orq wait"`,
};

// kind: a key of NEXT, or 'status' (the goal alone). No goal: no lines, so output stays as it was.
export function goalLines(goal, kind) {
  if (goal === undefined) return [];
  return [`goal: ${goal}`, ...(kind === 'status' ? [] : [`next: ${NEXT[kind]}`])];
}
