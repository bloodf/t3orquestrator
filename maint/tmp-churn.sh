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
#   MAINT_CHURN_ROOTS  space-separated roots instead of the built-in list
# Runs at the lowest I/O priority it can get: ionice -c3 + nice on Linux, taskpolicy -b on macOS.
set -u
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

# Lines of $1 that are not protected: not a kept path, under one or holding one; not inside a repository found in the
# root (repos: one real path per line); not held by a process (exact match: an open file, a working directory).
filter() {
  awk -v keep="$work/keep" -v repos="$work/repos" -v busy="$work/busy" '
    BEGIN {
      while ((getline l < keep) > 0) if (l != "") k[++nk] = l
      while ((getline l < repos) > 0) if (l != "") k[++nk] = l
      while ((getline l < busy) > 0) b[l] = 1
    }
    {
      if ($0 in b) next
      for (i = 1; i <= nk; i++) {
        if ($0 == k[i] || index($0, k[i] "/") == 1 || index(k[i], $0 "/") == 1) next
      }
      print
    }' "$1"
}

# find arguments that leave out every maint-skip match and everything under it
skip_args() {
  while IFS= read -r g; do
    [ -n "$g" ] && printf '%s\n' "$g"
  done < "$work/skip"
}

total=0
churn() {
  r=$1
  [ -d "$r" ] && [ ! -L "$r" ] || return 0
  [ "$(stat -c %u "$r" 2>/dev/null || stat -f %u "$r" 2>/dev/null)" = "$me" ] || return 0 # another user's root
  r=$(cd "$r" && pwd -P) || return 0
  under_kept "$r" && return 0
  age=$AGE
  used=$(inodes_used "$r")
  [ "${used:-0}" -ge "$EMERGENCY" ] && age=$EMERGENCY_AGE
  # repositories and worktrees inside the root: nothing in them is scratch
  find "$r" -xdev -name .git 2>/dev/null | sed 's#/\.git$##' > "$work/repos"
  set --
  while IFS= read -r g; do [ -n "$g" ] || continue; set -- "$@" ! -path "$g" ! -path "$g/*"; done <<EOF
$(skip_args)
EOF
  find "$r" -xdev -mindepth 1 -type f -user "$me" -mmin +"$age" "$@" 2>/dev/null > "$work/files.all"
  filter "$work/files.all" > "$work/files"
  n=$(wc -l < "$work/files" | tr -d ' ')
  if [ -n "$DRY" ]; then
    echo "$r: $n files idle over $age min (inodes ${used:-?}% used)"
    return 0
  fi
  tr '\n' '\0' < "$work/files" | xargs -0 rm -f -- 2>/dev/null
  find "$r" -xdev -mindepth 1 -depth -type d -user "$me" -empty -mmin +"$age" "$@" 2>/dev/null > "$work/dirs.all"
  filter "$work/dirs.all" | while IFS= read -r d; do rmdir -- "$d" 2>/dev/null; done
  total=$((total + n))
}

for r in ${MAINT_CHURN_ROOTS:-/tmp/claude-"$me" /private/tmp/claude-"$me" "$T"/claude-"$me" \
         /tmp/node-compile-cache "$T"/node-compile-cache "$HOME"/.cache/node-compile-cache \
         /tmp/tsx-"$me" "$T"/tsx-"$me" \
         /tmp/playwright-* "$T"/playwright-* "$HOME"/.cache/agent-tmp}; do
  churn "$r"
done

[ -z "$DRY" ] && log "$(date -u +%FT%TZ) tmp-churn removed=$total files"
exit 0
