// Tool and model credit never reaches the host: before a unit is merged into the integration branch, its own commits
// lose their credit lines (`Co-authored-by: <a model or tool>`, `🤖 Generated with …`). Everything else is kept:
// trees, parents (mapped), author, committer, dates and every other byte of the message. Plumbing only.
import fs from 'node:fs';
import { creditIn } from './ship.mjs';

const TRAILER = /^\s*(?:co-authored-by|assisted-by|generated-by)\s*:/i;
const VENDOR = /\b(?:claude|anthropic|openai|chatgpt|gpt(?:-?\d|\b)|codex|cursor(?:agent)?|copilot|gemini|google-labs|kimi|moonshot|minimax|grok|xai|sonnet|opus|haiku)\b|noreply@anthropic\.com|cursoragent@cursor\.com/i;
const GENERATED = /^\s*(?:🤖|generated\s+(?:with|by)\s)/iu;

const credits = (line) => (TRAILER.test(line) && VENDOR.test(line)) || (GENERATED.test(line) && (/🤖/u.test(line) || VENDOR.test(line) || Boolean(creditIn(line))));

// The message without its credit lines and the blank lines they leave at its end; the same string when it has none.
export function stripCredit(message) {
  const lines = String(message).split(/(?<=\n)/);
  const kept = lines.filter((l) => !credits(l.replace(/\r?\n$/, '')));
  if (kept.length === lines.length) return message;
  while (kept.length && /^\s*$/.test(kept.at(-1))) kept.pop();
  const text = kept.join('');
  return /\n$/.test(message) ? text : text.replace(/\r?\n$/, '');
}

// `git log -z --format=%H%n%B` output -> the shas whose message still credits a tool or model
export const creditedCommits = (log) => String(log).split('\0').map((e) => e.replace(/^\n/, '')).filter(Boolean)
  .filter((e) => { const msg = e.slice(e.indexOf('\n') + 1); return stripCredit(msg) !== msg; }).map((e) => e.slice(0, 40));

function rewrite(git, cwd, sha, map, scratch) {
  const raw = git.raw(cwd, ['cat-file', 'commit', sha]);
  const cut = raw.indexOf('\n\n');
  const head = raw.slice(0, cut).split('\n');
  const message = raw.slice(cut + 2);
  const parents = head.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
  const text = stripCredit(message);
  if (text === message && parents.every((p) => (map.get(p) ?? p) === p)) return sha;
  // a signature no longer matches the new commit: dropped, with its continuation lines
  let signature = false;
  const kept = head.filter((l) => {
    if (!l.startsWith(' ')) signature = l.startsWith('gpgsig');
    return !signature;
  });
  const headers = kept.map((l) => (l.startsWith('parent ') ? `parent ${map.get(l.slice(7)) ?? l.slice(7)}` : l));
  fs.writeFileSync(scratch, `${headers.join('\n')}\n\n${text}`);
  return git.raw(cwd, ['hash-object', '-t', 'commit', '-w', '--', scratch]).trim();
}

// head: the unit's gated commit; stop: commits not the unit's own (the integration head). Remote-tracking refs are
// never rewritten either. branch: moved to the new head when it still points at `head`. -> { head, rewritten }
export function stripUnitCredit({
  git, cwd, head, stop, branch, scratch,
}) {
  const list = git.raw(cwd, ['rev-list', '--topo-order', '--reverse', head, '--not', ...stop, '--remotes']).split('\n').filter(Boolean);
  // ponytail: a message in another encoding would be re-encoded; such a unit is left as it is
  if (list.some((sha) => /^encoding /m.test(git.raw(cwd, ['cat-file', 'commit', sha]).split('\n\n')[0]))) return { head, rewritten: 0 };
  const map = new Map();
  try {
    for (const sha of list) map.set(sha, rewrite(git, cwd, sha, map, scratch));
  } finally {
    fs.rmSync(scratch, { force: true });
  }
  const now = map.get(head) ?? head;
  const rewritten = [...map].filter(([a, b]) => a !== b).length;
  if (now === head) return { head, rewritten: 0 };
  const tree = (sha) => git.raw(cwd, ['rev-parse', `${sha}^{tree}`]).trim();
  if (tree(now) !== tree(head)) throw new Error(`rewriting ${head.slice(0, 12)} changed its tree`);
  if (branch && git.raw(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1]).trim() === head) {
    git.raw(cwd, ['update-ref', `refs/heads/${branch}`, now, head]); // local only, and only from where it was
  }
  return { head: now, rewritten };
}
