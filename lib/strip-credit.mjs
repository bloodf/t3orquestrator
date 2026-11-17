// Tool and model credit never reaches the host: before a unit is merged into the integration branch, its own commits
// lose their credit lines (`Co-authored-by: <a model or tool>`, `🤖 Generated with …`). Everything else is kept:
// trees, parents (mapped), author, committer, dates and every other byte of the message. A rewritten commit loses
// its signature (it would no longer verify). Plumbing only.
import fs from 'node:fs';
import { creditIn, TOOL_NAMES } from './ship.mjs';

const NAMES = TOOL_NAMES.join('|');
// a trailer at column 0 whose name is a model or tool (`Claude Sonnet 5.5`, `minimax-m2`, `Gemini (google-labs)`)
const TRAILER = /^(?:co-authored-by|assisted-by|generated-by)\s*:\s*(.*)$/i;
const TOOL = new RegExp(String.raw`^(?:github\s+)?(?:${NAMES})(?:[-.][\w.-]*)?(?:\s+(?:${NAMES}|code|agent|cli|fable|[\w.-]*\d[\w.-]*))*(?:\s*\([^)]*\))?$`, 'i');
// or whose address is a vendor's or a bot's
const BOT = [/@anthropic\.com$/i, /@cursor\.com$/i, /^noreply[^@]*@openai\.com$/i, /^noreply@z\.ai$/i, /\[bot\]@users\.noreply\.github\.com$/i, /(?:^|\+)copilot@users\.noreply\.github\.com$/i];

function credits(line) {
  const t = TRAILER.exec(line);
  if (!t) return /^(?:🤖\s*)?generated\s+(?:with|by)\s/iu.test(line) && Boolean(creditIn(line));
  const m = /^(.*?)\s*(?:<([^>]*)>)?\s*$/.exec(t[1]);
  return TOOL.test(m[1]) || (m[2] !== undefined && BOT.some((re) => re.test(m[2])));
}

// The message without its credit lines and the blank lines they leave at its end; the same string when it has none.
export function stripCredit(message) {
  const lines = String(message).split(/(?<=\n)/);
  const kept = lines.filter((l) => !credits(l.replace(/\r?\n$/, '')));
  if (kept.length === lines.length) return message;
  while (kept.length && /^\s*$/.test(kept.at(-1))) kept.pop();
  const text = kept.join('');
  return /\n$/.test(message) ? text : text.replace(/\r?\n$/, '');
}

// `git log -z --format=%H%x00%e%x00%B` -> [{sha, encoding, message}]
const parseLog = (log) => {
  const f = String(log).split('\0');
  return Array.from({ length: Math.floor(f.length / 3) }, (_, i) => ({ sha: f[3 * i].replace(/^\n/, ''), encoding: f[3 * i + 1], message: f[3 * i + 2] }));
};
const needsStrip = (c) => !c.encoding && stripCredit(c.message) !== c.message;

// the shas of a log (format above) whose UTF-8 message still credits a tool or model
export const creditedCommits = (log) => parseLog(log).filter(needsStrip).map((c) => c.sha);

// The commit with its message stripped (UTF-8 messages only) and its parents mapped; the same sha when neither changes.
function rewrite(git, cwd, sha, map, scratch) {
  const raw = git.bytes(cwd, ['cat-file', 'commit', sha]);
  const cut = raw.indexOf('\n\n');
  const head = raw.subarray(0, cut < 0 ? raw.length : cut).toString('latin1').replace(/\n$/, '').split('\n');
  const body = cut < 0 ? Buffer.alloc(0) : raw.subarray(cut + 2);
  const message = body.toString('utf8');
  const utf8 = !head.some((l) => l.startsWith('encoding ')) && Buffer.from(message, 'utf8').equals(body); // round trip
  const text = utf8 ? stripCredit(message) : message;
  const parents = head.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
  if (text === message && parents.every((p) => (map.get(p) ?? p) === p)) return sha;
  let signature = false; // dropped with its continuation lines; a merged tag's own signature is kept
  const kept = head.filter((l) => {
    if (!l.startsWith(' ')) signature = l.startsWith('gpgsig');
    return !signature;
  }).map((l) => (l.startsWith('parent ') ? `parent ${map.get(l.slice(7)) ?? l.slice(7)}` : l));
  fs.writeFileSync(scratch, Buffer.concat([Buffer.from(`${kept.join('\n')}\n\n`, 'latin1'), text === message ? body : Buffer.from(text, 'utf8')]));
  return git.raw(cwd, ['hash-object', '-t', 'commit', '-w', '--', scratch]).trim();
}

// head: the unit's gated commit; stop: commits not the unit's own (the integration head); remote-tracking refs are
// never rewritten either. -> { head, rewritten, move: the branch move to make once the new head is integrated }
export function stripUnitCredit({
  git, cwd, head, stop, branch, scratch,
}) {
  const range = [head, '--not', ...stop, '--remotes'];
  const none = { head, rewritten: 0, move: null };
  if (!parseLog(git.raw(cwd, ['log', '-z', '--format=%H%x00%e%x00%B', ...range])).some(needsStrip)) return none;
  const map = new Map();
  try {
    for (const sha of git.raw(cwd, ['rev-list', '--topo-order', '--reverse', ...range]).split('\n').filter(Boolean)) map.set(sha, rewrite(git, cwd, sha, map, scratch));
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  const now = map.get(head) ?? head;
  if (now === head) return none;
  const tree = (sha) => git.raw(cwd, ['rev-parse', `${sha}^{tree}`]).trim();
  if (tree(now) !== tree(head)) throw new Error(`rewriting ${head.slice(0, 12)} changed its tree`);
  const at = branch ? git.raw(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]).trim() : null;
  return { head: now, rewritten: [...map].filter(([a, b]) => a !== b).length, move: at === head ? { branch, from: head, to: now } : null };
}

// After the merge: the unit's local branch follows its rewritten head, only from where it was (never pushed). A branch
// that moved meanwhile is left alone.
export function moveBranch(git, cwd, move) {
  if (!move) return;
  try {
    git.raw(cwd, ['update-ref', `refs/heads/${move.branch}`, move.to, move.from]);
  } catch { /* moved meanwhile: the worker's commits win */ }
}
