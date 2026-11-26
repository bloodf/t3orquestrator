// Notes, never stops: work in this project orq did not start, and files under .orq/ the kit did not write. An
// orchestrator that launches workers by hand or keeps receipts of its own costs slots and tokens nothing counts.
import fs from 'node:fs/promises';
import { ACTIVE } from './t3.mjs';
import { projectDir } from './paths.mjs';

// What the kit writes under .orq/ (paths.mjs), and what the playbook lets the orchestrator write there
const KIT_FILES = new Set([
  'config.json', 'plan.json', 'ledger.jsonl', 'lock', 'runner.lock', 'integration', 'gate', 'units', 'reviews.json', 'asks.json',
  'summary.md', 'archiving.json', 'archive', 'inbox.md', 'inbox-read', 'salvage', 'cleanup.json', 'cleanup.lock', 'attention.json',
  'sync.json', 'commit.tmp', 'inbox-wake.json', 'orders', 'capabilities.json', 'memory.md',
]);
const TRANSIENT = /^\.|\.tmp$|\.takeover$/; // atomic writes and lock guards, gone in a moment
const SHOWN = 5;

const listed = (names) => `${names.slice(0, SHOWN).join(', ')}${names.length > SHOWN ? ` and ${names.length - SHOWN} more` : ''}`;

// The entries of .orq/ the kit does not know, sorted. Unreadable or absent: none.
export async function strayFiles(cwd) {
  const names = await fs.readdir(projectDir(cwd)).catch(() => []);
  return names.filter((n) => !KIT_FILES.has(n) && !TRANSIENT.test(n)).sort();
}

// Threads at work in this project that hold no orq lease, are on no orq branch and are not the orchestrator (keep).
export function strayThreads(threads, leases, keep = []) {
  const leased = new Set(leases.map((l) => l.threadId));
  const mine = new Set(keep.filter(Boolean));
  return threads.filter((t) => ACTIVE.includes(t.status) && !leased.has(t.id) && !mine.has(t.id) && !t.branch?.startsWith('orq/'))
    .map((t) => t.id);
}

export function strayNotes(threads, files) {
  return [
    ...(threads.length ? [`note: ${threads.length} thread(s) in this project run without an orq lease (started outside orq): ${listed(threads)}; start work only as orq units`] : []),
    ...(files.length ? [`note: .orq/ holds ${files.length} file(s) orq did not write: ${listed(files)}; orq status and the ledger are the record`] : []),
  ];
}
