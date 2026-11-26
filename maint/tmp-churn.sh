#!/bin/sh
# Delete old FILES inside temp roots that never go idle as a whole (disk-clean.sh skips a root while anything in it is
# recent): Claude Code's task output, Node's compile cache, tsx and Playwright caches and the agent temp dir. These
# grow by hundreds of thousands of small files a day and can use up a tmpfs's inodes (seen: 714k + 328k files on a
# 1M-inode /tmp, every command then failed with ENOSPC). Installed by `orq maint install` (hourly).
#
# Only regular files owned by this user and unmodified for $AGE minutes go, then empty directories as old. Sockets and
# the roots themselves stay. Inode emergency: when a root's filesystem has $EMERGENCY% or more of its inodes in use,
# files idle for $EMERGENCY_AGE minutes go too.
#   DRY=1  print how many files would go per root; change nothing
#   AGE (default 120), EMERGENCY (default 90), EMERGENCY_AGE (default 10)
# Runs at the lowest I/O priority it can get: ionice -c3 + nice on Linux, taskpolicy -b on macOS.
set -u
if [ -z "${ORQ_MAINT_LOWPRIO:-}" ]; then
  ORQ_MAINT_LOWPRIO=1; export ORQ_MAINT_LOWPRIO
  if command -v ionice >/dev/null 2>&1; then exec ionice -c3 nice -n19 /bin/sh "$0" "$@"; fi
  if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -b /bin/sh "$0" "$@"; fi
fi

AGE=${AGE:-120}
EMERGENCY=${EMERGENCY:-90}
EMERGENCY_AGE=${EMERGENCY_AGE:-10}
DRY=${DRY:-}
ORQ_HOME=${T3ORQ_HOME:-$HOME/.t3orq}
LOG=${LOG:-$ORQ_HOME/maint.log}
me=$(id -u)
T=${TMPDIR:-/tmp}
T=${T%/}

# Percent of inodes in use on the filesystem of $1 (the last "NN%" column: IUse% on Linux, %iused on macOS), or 0.
inodes_used() {
  df -Pi "$1" 2>/dev/null | awk 'NR==2{v=0; for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/) v=$i; sub("%","",v); print v+0}'
}

total=0
churn() {
  r=$1
  [ -d "$r" ] || return 0
  [ "$(stat -c %u "$r" 2>/dev/null || stat -f %u "$r" 2>/dev/null)" = "$me" ] || return 0 # another user's root
  age=$AGE
  used=$(inodes_used "$r")
  [ "${used:-0}" -ge "$EMERGENCY" ] && age=$EMERGENCY_AGE
  if [ -n "$DRY" ]; then
    n=$(find "$r" -mindepth 1 -type f -user "$me" -mmin +"$age" 2>/dev/null | wc -l | tr -d ' ')
    echo "$r: $n files idle over $age min (inodes ${used:-?}% used)"
    return 0
  fi
  n=$(find "$r" -mindepth 1 -type f -user "$me" -mmin +"$age" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  find "$r" -mindepth 1 -depth -type d -user "$me" -empty -mmin +"$age" -delete 2>/dev/null
  total=$((total + n))
}

# MAINT_CHURN_ROOTS: space-separated roots instead of the list below (tests)
for r in ${MAINT_CHURN_ROOTS:-/tmp/claude-"$me" /private/tmp/claude-"$me" "$T"/claude-"$me" \
         /tmp/node-compile-cache "$T"/node-compile-cache "$HOME"/.cache/node-compile-cache \
         /tmp/tsx-"$me" "$T"/tsx-"$me" \
         /tmp/playwright-* "$T"/playwright-* "$HOME"/.cache/agent-tmp}; do
  churn "$r"
done

if [ -z "$DRY" ]; then
  line="$(date -u +%FT%TZ) tmp-churn removed=$total files"
  mkdir -p "$(dirname "$LOG")" && echo "$line" >> "$LOG"
  echo "$line"
fi
