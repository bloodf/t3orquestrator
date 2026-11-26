// Why a provider stopped a thread that left no reply, from T3's own log of that thread:
// <T3 home>/userdata/logs/provider/events.<thread id>.log. Codex reports a refusal (its usage limit, a sign-out) as a
// turn error, which `t3 thread show` does not print, so the thread's messages say nothing. Read-only and best effort:
// no log, or one in another format (an ACP provider's names no reason), and the failure is counted as before.
import fs from 'node:fs';
import path from 'node:path';
import { t3CacheDir } from './usage-source.mjs';

// ponytail: the whole file is read. A refused thread's log is a few KB; a larger one is skipped (read its tail if a
// thread that worked for hours and then failed without a reply ever needs its reason).
const MAX_BYTES = 4 * 1024 * 1024;
const ERROR = /"error":\{"message":("(?:[^"\\]|\\.)*")/g; // the protocol event's own field: text quoted inside a message is escaped

const STAMP = /^\[([^\]]+)\]/; // each line starts with the time T3 logged it

// The last error message the provider gave in the thread, or null. after (epoch ms, optional): only an error logged
// at or after it counts, so a run that ended without an error does not inherit one an earlier run recovered from;
// a line with no readable time then does not count either.
export function threadError(ctx, machine, threadId, { after = null } = {}) {
  const name = `events.${String(threadId).replace(/[^A-Za-z0-9._-]/g, '-')}.log`; // T3 names the file so: mcp:<uuid> -> mcp-<uuid>
  const file = path.join(path.dirname(t3CacheDir(ctx, machine)), 'userdata', 'logs', 'provider', name);
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => {
      if (after === null) return true;
      const at = Date.parse(STAMP.exec(l)?.[1] ?? '');
      return Number.isFinite(at) && at >= after;
    });
    const last = lines.flatMap((l) => [...l.matchAll(ERROR)]).at(-1);
    return last ? JSON.parse(last[1]) : null;
  } catch {
    return null;
  }
}
