#!/bin/sh
# Free disk from leaked agent work: old temp entries, idle git worktrees, orphan worktree directories and old ignored
# build output. Installed by `orq maint install` (every 6 hours) and started once by `orq wait` when a disk runs low.
#
# Deletes an entry only when it is owned by this user, it and everything inside are untouched for $AGE minutes, no
# process holds it (open file, cwd or memory map), it holds no socket, and it is not a path `orq maint keep` names
# (projects with an orq lease or gate lease, worktrees of leased threads and of T3 threads at work). When that list
# cannot be learned, no worktree, orphan directory or build output is removed (fail closed). A git command that fails
# keeps what it was asked about.
#
#   DRY=1        print what would go (du -sk); change nothing at all, not even `git worktree prune` or docker
#   AGE          minutes a temp entry must be idle (default 360); WT_AGE the same for a worktree (default 1440)
#   MAINT_REPOS  space-separated globs of main checkouts (default: $HOME/Developer, 1 to 4 levels deep)
#   ORQ          the orq command (default: node <kit>/bin/orq.mjs)
#   $T3ORQ_HOME/maint-skip  globs of paths never touched, one per line
#   MAINT_TEMP_ROOTS  space-separated temp roots instead of the built-in list; MAINT_DOCKER=0 skips docker
# Runs at the lowest I/O priority it can get: ionice -c3 + nice on Linux, taskpolicy -b on macOS.
set -u
if [ -z "${ORQ_MAINT_LOWPRIO:-}" ]; then
  ORQ_MAINT_LOWPRIO=1; export ORQ_MAINT_LOWPRIO
  if command -v ionice >/dev/null 2>&1; then exec ionice -c3 nice -n19 /bin/sh "$0" "$@"; fi
  if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -b /bin/sh "$0" "$@"; fi
fi

KIT=$(cd "$(dirname "$0")/.." && pwd)
orq() { if [ -n "${ORQ:-}" ]; then $ORQ "$@"; else node "$KIT/bin/orq.mjs" "$@"; fi; }
AGE=${AGE:-360}
WT_AGE=${WT_AGE:-1440}
DRY=${DRY:-}
ORQ_HOME=${T3ORQ_HOME:-$HOME/.t3orq}
LOG=${LOG:-$ORQ_HOME/maint.log}
me=$(id -u)
now=$(date +%s)
work=$(mktemp -d "${TMPDIR:-/tmp}/diskclean.XXXXXX") || exit 1
busy=$work/busy
keep=$work/keep
trap 'rm -rf "$work"' EXIT

# Paths any process holds.
if [ -d /proc/self ]; then
  for p in /proc/[0-9]*; do
    ls -l "$p/fd" 2>/dev/null | sed -n 's/.* -> //p'
    readlink "$p/cwd" 2>/dev/null
    awk '{print $6}' "$p/maps" 2>/dev/null
  done | grep '^/' | sort -u > "$busy"
else
  lsof -n -u "$me" -F n 2>/dev/null | sed -n 's/^n//p' | grep '^/' | sort -u > "$busy"
fi

held() { grep -q -F "$1/" "$busy" || grep -qxF "$1" "$busy"; }

# Main checkouts of the user's repositories (a .git directory, not a worktree's .git file).
repos=$(for g in ${MAINT_REPOS:-"$HOME/Developer/*" "$HOME/Developer/*/*" "$HOME/Developer/*/*/*" "$HOME/Developer/*/*/*/*"}; do
  [ -d "$g/.git" ] && printf '%s\n' "$g"; done)

# What must stay. Fail closed: without the list, nothing below the temp roots is removed.
wt_ok=1
# shellcheck disable=SC2086
if ! orq maint keep $repos > "$keep" 2> "$work/keep.err"; then
  wt_ok=
  echo "disk-clean: worktrees kept: $(head -1 "$work/keep.err")" >&2
fi
# A kept path, a path inside one, or a directory that holds one.
kept() {
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    case "$1/" in "$k"/*) return 0 ;; esac
    case "$k/" in "$1"/*) return 0 ;; esac
  done < "$keep"
  return 1
}

# $ORQ_HOME/maint-skip: one shell glob per line, matched against whole paths; a match and everything under it is
# never touched (for example a rollback copy of a T3 home: */t3-home.backup-*).
skipped() {
  [ -f "$ORQ_HOME/maint-skip" ] || return 1
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254
    case "$1" in $g|$g/*) return 0 ;; esac
  done < "$ORQ_HOME/maint-skip"
  return 1
}

act_rm() { # remove a path, or say what would go
  if [ -n "$DRY" ]; then du -sk "$1" 2>/dev/null; else rm -rf -- "$1" 2>/dev/null; fi
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo "$now"; }

clean_root() {
  r=$1
  [ -d "$r" ] || return 0
  find "$r" -mindepth 1 -maxdepth 1 -user "$me" -mmin +"$AGE" 2>/dev/null | while IFS= read -r e; do
    case "$(basename "$e")" in
      PostgreSQL.*|tmux-*|systemd-private-*|.X11-unix|.ICE-unix|.font-unix|snap-private-tmp|ssh-*|diskclean.*|com.apple.*|launchd*|*.sock) continue ;;
    esac
    held "$e" && continue
    kept "$e" && continue
    skipped "$e" && continue
    [ -S "$e" ] && continue
    if [ -d "$e" ]; then
      [ -n "$(find "$e" -type s -print -quit 2>/dev/null)" ] && continue
      [ -n "$(find "$e" -mmin -"$AGE" -print -quit 2>/dev/null)" ] && continue
    fi
    act_rm "$e"
  done
}

before=$(df -Pk "$HOME" | awk 'NR==2{print $4}')

if [ -n "${MAINT_TEMP_ROOTS:-}" ]; then # instead of every root below (tests)
  for r in $MAINT_TEMP_ROOTS; do clean_root "$r"; done
else
  # Top-level temp roots.
  for r in /tmp /var/tmp /dev/shm "${TMPDIR:-}" /private/tmp; do
    [ -n "$r" ] && clean_root "$r"
  done
  # Long-lived container dirs whose children are per-unit scratch (agent TMPDIR roots, orq scratch).
  for r in /var/tmp/*orq-* /tmp/*orq-* /tmp/claude-* /private/tmp/claude-* \
           "$HOME"/.cache/*-tmp "$HOME"/.cache/*scratch* "$HOME"/.cache/*orq*; do
    [ -d "$r" ] && clean_root "$r"
  done
fi

# Old git worktrees: removed only when idle WT_AGE, not kept, nothing uncommitted, HEAD already on a remote, and no
# process inside. Any git command that fails keeps the worktree. The branch itself is kept.
old_worktrees() {
  repo=$1
  list=$(git -C "$repo" worktree list --porcelain 2>/dev/null) || return 0
  printf '%s\n' "$list" | sed -n 's/^worktree //p' | tail -n +2 | while IFS= read -r wt; do
    skipped "$wt" && continue
    [ -d "$wt" ] || continue
    held "$wt" && continue
    kept "$wt" && continue
    gd=$(git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null) || continue
    last=0
    for f in "$gd/index" "$gd/HEAD" "$gd/logs/HEAD" "$wt"; do m=$(mtime "$f"); [ "$m" -gt "$last" ] && last=$m; done
    [ $(( (now - last) / 60 )) -lt "$WT_AGE" ] && continue
    st=$(git -C "$wt" status --porcelain 2>/dev/null) || continue
    [ -n "$st" ] && continue
    remote=$(git -C "$wt" branch -r --contains HEAD 2>/dev/null) || continue
    [ -z "$remote" ] && continue
    if [ -n "$DRY" ]; then du -sk "$wt" 2>/dev/null; else git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1; fi
  done
  [ -z "$DRY" ] && git -C "$repo" worktree prune >/dev/null 2>&1
}

# Ignored test and build output older than AGE inside a checkout (never tracked files, never in a kept path).
build_leftovers() {
  d=$1
  find "$d" -name node_modules -prune -o -name .git -prune -o -type d \
    \( -name test-results -o -name playwright-report -o -name blob-report -o -name coverage \
       -o -name .nyc_output -o -name .turbo -o -name .vitest -o -name .nuxt -o -name .output \
       -o -name .next -o -name dist -o -name build -o -name target -o -name __pycache__ \
       -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache \) -mmin +"$AGE" -print -prune 2>/dev/null |
  while IFS= read -r b; do
    git -C "$(dirname "$b")" check-ignore -q "$b" 2>/dev/null || continue
    held "$b" && continue
    kept "$b" && continue
    skipped "$b" && continue
    [ -n "$(find "$b" -mmin -"$AGE" -print -quit 2>/dev/null)" ] && continue
    act_rm "$b"
  done
}

if [ -n "$wt_ok" ]; then
  for r in $repos; do old_worktrees "$r"; done
  # Worktree roots: T3's, minus any maint-skip match (a rollback copy of a T3 home). A directory with no .git at all goes after WT_AGE;
  # one whose .git git cannot read is kept (it may be a worktree whose repository is elsewhere or briefly locked).
  for root in "$HOME"/.t3/worktrees "$HOME"/.local/share/t3-*/worktrees; do
    skipped "$root" && continue
    [ -d "$root" ] || continue
    for wt in "$root"/*/*; do
      [ -d "$wt" ] || continue
      skipped "$wt" && continue
      if [ ! -e "$wt/.git" ]; then
        held "$wt" && continue
        kept "$wt" && continue
        [ $(( (now - $(mtime "$wt")) / 60 )) -lt "$WT_AGE" ] && continue
        [ -n "$(find "$wt" -mmin -"$WT_AGE" -print -quit 2>/dev/null)" ] && continue
        act_rm "$wt"
      elif git -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
        build_leftovers "$wt"
      fi
    done
  done
  for r in $repos; do build_leftovers "$r"; done
fi

# Docker: build cache older than a day and dangling images. Tagged images (rollback copies), containers and volumes
# are never touched.
if [ -z "$DRY" ] && [ "${MAINT_DOCKER:-1}" != 0 ] && command -v docker >/dev/null 2>&1; then
  docker builder prune -f --filter until=24h >/dev/null 2>&1
  docker image prune -f >/dev/null 2>&1
fi

after=$(df -Pk "$HOME" | awk 'NR==2{print $4}')
line="$(date -u +%FT%TZ) disk-clean${DRY:+ (dry run)} freed=$(( (after - before) / 1048576 ))G avail=$(( after / 1048576 ))G$([ -n "$wt_ok" ] || echo ' worktrees-kept')"
if [ -n "$DRY" ]; then echo "$line"; else mkdir -p "$(dirname "$LOG")" && echo "$line" >> "$LOG" && echo "$line"; fi
