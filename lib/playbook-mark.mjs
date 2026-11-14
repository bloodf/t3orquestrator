// Which playbook an orchestrator has read. It reads ORCHESTRATOR.md once at the start of a session, so after
// `orq update` it would keep following the old text: orq records what it read (`orq init`, `orq sync`) and says so
// when the running kit's playbook differs. Compared by content hash; the kit commit is only for the message.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const playbookFile = (kitDir) => path.join(kitDir, 'playbook', 'ORCHESTRATOR.md');

export const playbookHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

// {kit?, hash} of the running kit, or null when its playbook cannot be read (nothing to compare then).
export function playbookMark(kitDir, kitHead) {
  try {
    return { ...(kitHead ? { kit: kitHead } : {}), hash: playbookHash(playbookFile(kitDir)) };
  } catch {
    return null;
  }
}

export function playbookLine(recorded, current, file) {
  if (current === null || recorded?.hash === current.hash) return null;
  return `playbook: the kit was updated (${recorded?.kit ?? 'unknown'} -> ${current.kit ?? 'unknown'}); read ${file} again now, then run "orq init"`;
}
