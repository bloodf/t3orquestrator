// orq update: move the kit checkout to a release tag or sha. Takes no orq lock.
// Trust: the kit's origin is trusted and tags are not signature-checked. The stub's pinned commit is the
// trust anchor; update is a convenience.
import { highestTag, isSha, short } from '../kit.mjs';
import { CliError, parseFlags, usage } from './common.mjs';
import { kitDirOf, kitFor } from './kit-info.mjs';

const BAD_TO = 'update: --to must be a 40-hex commit sha or an existing tag';
const tagRef = (tag) => `refs/tags/${tag}`; // never a branch of the same name

function target(kit, to) {
  if (to === undefined) {
    const tag = highestTag(kit.allTags());
    if (!tag) throw new CliError('update: no release is tagged yet; use --to <sha>', 4);
    return kit.resolve(tagRef(tag));
  }
  const sha = isSha(to) ? kit.resolve(to) : kit.allTags().includes(to) ? kit.resolve(tagRef(to)) : null;
  if (!sha) throw usage(BAD_TO);
  return sha;
}

function plan(kit, flags, old) {
  const sha = target(kit, flags.to);
  if (sha === old) return { sha, kind: 'same' };
  if (kit.isAncestor(old, sha)) return { sha, kind: 'forward' };
  if (flags.to === undefined) {
    const tag = kit.tagAt(sha);
    throw new CliError(`update: ${short(sha)}${tag ? ` (${tag})` : ''} is not ahead of the current commit ${short(old)}; nothing to do. Use --to to move anyway.`, 4);
  }
  return { sha, kind: 'sideways' };
}

export function update(args, ctx) {
  const { flags, positional } = parseFlags(args, { bool: ['check'], value: ['to'] }, 'update');
  if (positional.length > 0) throw usage('update: usage: update [--to <tag|sha>] [--check]');
  if (flags.to !== undefined && !isSha(flags.to) && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(flags.to)) throw usage(BAD_TO);
  const kit = kitFor(ctx);
  if (!kit.isCheckout()) throw new CliError('update: kit is not a git checkout', 4);
  if (!flags.check && kit.isDirty()) throw new CliError('update: kit has local changes; not touching it', 4);
  const failure = kit.fetch();
  if (failure) throw new CliError(`update: could not reach the kit's origin (${failure})`, 4);
  const old = kit.head();
  const { sha, kind } = plan(kit, flags, old);
  const tag = kit.tagAt(sha);
  const label = tag ? ` (${tag})` : '';
  const move = `${short(old)} -> ${short(sha)}`;
  if (kind === 'same') {
    ctx.stdout.write(`up to date at ${short(old)}\n`);
    return 0;
  }
  if (flags.check) {
    ctx.stdout.write(kind === 'forward' ? `update available: ${move}${label}\n` : `would move (not a fast-forward): ${move}\n`);
    return 0;
  }
  const branch = kit.branch();
  kit.checkout(sha);
  const first = kind === 'forward' ? `updated: ${move}${label}` : `moved (not a fast-forward): ${move}`;
  const note = branch ? `\nnote: kit was on branch ${branch}; now detached at ${short(sha)}` : '';
  ctx.stdout.write(`${first}${note}\nreview the changes: git -C ${kitDirOf(ctx)} log --oneline ${short(old)}..${short(sha)}\n`
    + 'running orchestrators are told on their next "orq wait"\n');
  return 0;
}
