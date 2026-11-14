// orq's entries in the repository's info/exclude (local, never committed, shared by every worktree): one anchored
// line per shared directory, so a link there is ignored even where .gitignore says `node_modules/` (directories
// only). They live in a marked block that orq rewrites; lines outside it are never touched.
import fs from 'node:fs';
import path from 'node:path';

const BEGIN = '# orq share begin';
const END = '# orq share end';

// A path that may be excluded: git ignores it in the main checkout already and tracks nothing under it.
export function excludable(cwd, p, git) {
  try {
    return git.ignored(cwd, [p]).length === 1 && !git.tracked(cwd, p);
  } catch {
    return false;
  }
}

/**
 * Make the block hold `/p` for each excludable path. prune: the block is exactly that (init, config set: a dropped
 * path or `share null` removes its line); otherwise lines are only added (before linking). Writes only on change.
 */
export function syncShareExclude(cwd, paths, git, { prune = false } = {}) {
  const file = path.join(git.commonDir(cwd), 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const b = lines.indexOf(BEGIN);
  const e = b < 0 ? -1 : lines.indexOf(END, b);
  const inside = b < 0 || e < 0 ? [] : lines.slice(b + 1, e);
  const outside = b < 0 || e < 0 ? lines : [...lines.slice(0, b), ...lines.slice(e + 1)];
  const wanted = paths.filter((p) => excludable(cwd, p, git)).map((p) => `/${p}`);
  const entries = prune ? wanted : [...inside, ...wanted.filter((l) => !inside.includes(l))];
  const block = entries.length ? [BEGIN, ...entries, END] : [];
  const at = b < 0 || e < 0 ? outside.length : b;
  const next = [...outside.slice(0, at), ...block, ...outside.slice(at)];
  const out = next.length ? `${next.join('\n')}\n` : '';
  if (out === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
}
