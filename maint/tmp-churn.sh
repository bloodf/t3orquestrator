#!/bin/sh
# Delete old FILES inside temp roots that never go idle as a whole (disk-clean.sh skips a root while anything in it is
# recent): Claude Code's task output, Node's compile cache, tsx and Playwright caches and the agent temp dir. These
# grow by hundreds of thousands of small files a day and can use up a tmpfs's inodes (seen: 714k + 328k files on a
# 1M-inode /tmp, every command then failed with ENOSPC). Installed by `orq maint install` (hourly).
#
# A root is searched only when it is a real directory (not a link) owned by this user, not kept and not a repository.
# Inside it, only regular files owned by this user and unmodified for $AGE minutes go, then empty directories as old,
# never crossing into another filesystem. Never anything protect.sh protects: kept paths (`orq maint keep`), maint-skip
# matches, anything inside a git repository or worktree, files a process holds open, directories a process works in.
# When the keep list cannot be learned, nothing is deleted. Inode emergency: when a root's filesystem has $EMERGENCY%
# or more of its inodes in use, files idle for $EMERGENCY_AGE minutes go too.
#   DRY=1  print how many files would go per root; change nothing
#   AGE (default 120), EMERGENCY (default 90), EMERGENCY_AGE (default 10)
#   MAINT_CHURN_ROOTS  tests only (ORQ_MAINT_TEST=1, every root inside ORQ_MAINT_TEST_AREA): space-separated roots
#                      instead of the built-in list; set any other way, the script deletes nothing
# Runs at the lowest I/O priority it can get: ionice -c3 + nice on Linux, taskpolicy -b on macOS.
set -u
set -f # no pathname expansion: see emit_roots
if [ -z "${ORQ_MAINT_LOWPRIO:-}" ]; then
  ORQ_MAINT_LOWPRIO=1; export ORQ_MAINT_LOWPRIO
  if command -v ionice >/dev/null 2>&1; then exec ionice -c3 nice -n19 /bin/sh "$0" "$@"; fi
  if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -b /bin/sh "$0" "$@"; fi
fi

KIT=$(cd "$(dirname "$0")/.." && pwd)
. "$KIT/maint/protect.sh"
AGE=${AGE:-120}
EMERGENCY=${EMERGENCY:-90}
EMERGENCY_AGE=${EMERGENCY_AGE:-10}
DRY=${DRY:-}
ORQ_HOME=${T3ORQ_HOME:-$HOME/.t3orq}
LOG=${LOG:-$ORQ_HOME/maint.log}
me=$(id -u)
T=${TMPDIR:-/tmp}
T=${T%/}
work=$(mktemp -d "${TMPDIR:-/tmp}/tmpchurn.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT

log() { if [ -z "$DRY" ]; then mkdir -p "$(dirname "$LOG")" && echo "$1" >> "$LOG"; fi; echo "$1"; }
if ! protect_init "$work"; then
  log "$(date -u +%FT%TZ) tmp-churn nothing deleted: the paths to keep could not be learned ($(head -1 "$work/keep.err" 2>/dev/null))" >&2
  exit 1
fi

# Percent of inodes in use on the filesystem of $1 (the last "NN%" column: IUse% on Linux, %iused on macOS), or 0.
inodes_used() {
  df -Pi "$1" 2>/dev/null | awk 'NR==2{v=0; for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/) v=$i; sub("%","",v); print v+0}'
}

# The paths of FILE (one per line) strictly under ROOT, with no control character: kept paths, repositories and held
# paths that a find in ROOT must leave out.
under_root() {
  # the root goes in through the environment: awk -v would read backslash escapes in it (a root named a\t)
  ORQ_AWK_ROOT=$2 awk 'BEGIN { root = ENVIRON["ORQ_AWK_ROOT"] } index($0, root "/") == 1 && length($0) > length(root) + 1 && $0 !~ /[\001-\037\177]/' "$1"
}

total=0
churn() {
  [ -L "$1" ] && return 0 # a linked root is never searched, not even a temp alias's child
  r=$(resolve_root "$1") || return 0
  [ "$(stat -c %u "$r" 2>/dev/null || stat -f %u "$r" 2>/dev/null)" = "$me" ] || return 0 # another user's root
  under_kept "$r" && return 0
  age=$AGE
  used=$(inodes_used "$r")
  [ "${used:-0}" -ge "$EMERGENCY" ] && age=$EMERGENCY_AGE
  # Everything find must leave out, as its own predicates (deletion is find's, never a path string's):
  #   maint-skip matches and everything under them;
  #   kept paths and repositories or worktrees inside the root, and everything under them;
  #   paths a process holds (an open file, a working directory).
  find -P "$r" -xdev -name .git 2>/dev/null | sed 's#/\.git$##' > "$work/repos"
  set --
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    set -- "$@" ! -path "$g" ! -path "$g/*"
  done < "$work/skip"
  cat "$work/keep" "$work/repos" > "$work/prefixes"
  under_root "$work/prefixes" "$r" > "$work/prefixes.in"
  while IFS= read -r k; do
    lit=$(find_literal "$k")
    set -- "$@" ! -path "$lit" ! -path "$lit/*"
  done < "$work/prefixes.in"
  under_root "$work/busy" "$r" > "$work/busy.in"
  while IFS= read -r k; do
    set -- "$@" ! -path "$(find_literal "$k")"
  done < "$work/busy.in"
  if [ -n "$DRY" ]; then
    n=$(find -P "$r" -xdev -mindepth 1 -type f -user "$me" -mmin +"$age" ! -path "$CTRL_GLOB" "$@" -print 2>/dev/null | wc -l | tr -d ' ')
    echo "$r: $n files idle over $age min (inodes ${used:-?}% used)"
    return 0
  fi
  test_pause
  # find -P walks the root without following a symlinked root or any link inside it, and deletes what it matched
  n=$(find -P "$r" -xdev -mindepth 1 -type f -user "$me" -mmin +"$age" ! -path "$CTRL_GLOB" "$@" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  find -P "$r" -xdev -mindepth 1 -depth -type d -user "$me" -empty -mmin +"$age" ! -path "$CTRL_GLOB" "$@" -delete 2>/dev/null
  total=$((total + n))
}

# The roots, one per line. MAINT_CHURN_ROOTS (tests): space-separated literal paths, never expanded. Otherwise the
# fixed list: the only pathname expansion in this script is the playwright-* pattern, and every root is validated
# again by churn (resolve_root: a real directory reached through no link, owned by this user).
emit_roots() {
  if [ -n "${MAINT_CHURN_ROOTS:-}" ]; then
    override_roots "$MAINT_CHURN_ROOTS"
    return
  fi
  emit_paths /tmp/claude-"$me" /private/tmp/claude-"$me" "$T"/claude-"$me" \
    /tmp/node-compile-cache "$T"/node-compile-cache "$HOME"/.cache/node-compile-cache \
    /tmp/tsx-"$me" "$T"/tsx-"$me" "$HOME"/.cache/agent-tmp
  set +f
  emit_paths /tmp/playwright-* "$T"/playwright-*
  set -f
}
if ! emit_roots > "$work/roots"; then
  echo "tmp-churn: nothing deleted: MAINT_CHURN_ROOTS is for tests only (ORQ_MAINT_TEST=1, roots in ORQ_MAINT_TEST_AREA)" >&2
  exit 2
fi
while IFS= read -r r; do
  [ -n "$r" ] && churn "$r"
done < "$work/roots"

[ -z "$DRY" ] && log "$(date -u +%FT%TZ) tmp-churn removed=$total files"
exit 0
