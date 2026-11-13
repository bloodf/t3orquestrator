// Evidence that runs a file the repository does not hold: not in the worker's commit, not in the pull request,
// and nobody else can run it. Pure: reads only the command string.
import path from 'node:path';

// Where interpreters and system tools live: `/usr/bin/env node`, `/dev/null`, `/opt/homebrew/bin/node`, `/etc/hosts`.
// /tmp, /var, /home and /Users are not here: a check written there is exactly what this warns about.
const SYSTEM = ['/usr', '/bin', '/sbin', '/opt', '/nix', '/snap', '/dev', '/proc', '/sys', '/etc', '/System', '/Library', '/Applications'];
const OPERATOR = /^(;|&&|\|\||\||&|\(|\))$/;

// Words of a shell command line: quotes, `=` and redirections split words; operators are kept as their own words.
function words(command) {
  return String(command)
    .replace(/(;|&&|\|\||\||&|\(|\))/g, ' $1 ')
    .split(/[\s"'`=<>]+/)
    .filter((w) => w !== '');
}

const hasExtension = (p) => /\.[A-Za-z0-9]{1,6}$/.test(path.posix.basename(p));

/**
 * Paths in `command` that name a file outside the repository at `root`, or under its .orq/. An absolute path
 * (`/…` or `~/…`, resolved against `home`) counts when it is a command word or ends in a file extension:
 * a bare `/api/v1` inside a grep pattern is not a file. Anything under .orq/ always counts.
 */
export function outsidePaths(command, { root, home }) {
  const list = words(command);
  const inRepo = (abs) => abs === root || abs.startsWith(`${root}/`);
  const underOrq = (abs) => abs === `${root}/.orq` || abs.startsWith(`${root}/.orq/`);
  return list.filter((w, i) => {
    if (/(^|\/)\.orq\//.test(w) && !w.startsWith('/') && !w.startsWith('~')) return true;
    if (!w.startsWith('/') && !w.startsWith('~/')) return false;
    const abs = path.posix.normalize(w.startsWith('~/') ? `${home}/${w.slice(2)}` : w);
    if (inRepo(abs)) return underOrq(abs);
    if (SYSTEM.some((s) => abs === s || abs.startsWith(`${s}/`))) return false;
    const commandWord = i === 0 || OPERATOR.test(list[i - 1]);
    return commandWord || hasExtension(abs);
  });
}

export const evidenceWarning = (id, paths) => `${id}: evidence runs a file outside the repository (${paths.join(', ')}); a check belongs in the repository, written by a unit`;
