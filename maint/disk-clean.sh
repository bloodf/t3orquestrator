#!/bin/sh
# Free disk from leaked agent scratch in temp roots. Installed by `orq maint install` (every 6 hours) and started once
# by `orq wait` when a disk runs low.
#
# Deletes a top-level entry of a temp root only when it is owned by this user, it and everything inside are untouched
# for $AGE minutes, it holds no socket, and protect.sh does not protect it: not kept by `orq maint keep` (leased
# projects, worktrees of leased threads and of T3 threads at work), not matching or holding a maint-skip glob, not a
# git repository or worktree and holding none, held by no process. Paths are compared by their real paths. When the
# keep list cannot be learned, nothing is deleted.
#
# Worktrees and checkouts are never removed here: orq's own cleanup (`orq wait`, `orq worktree prune`) removes those
# it made, knowing their leases and saving uncommitted work first.
#
#   DRY=1        print what would go (du -sk); change nothing at all
#   AGE          minutes a temp entry must be idle (default 360)
#   ORQ          the orq command (default: node <kit>/bin/orq.mjs)
#   MAINT_TEMP_ROOTS  space-separated temp roots instead of the built-in list; MAINT_DOCKER=0 skips docker
#   $T3ORQ_HOME/maint-skip  globs of paths never touched, one per line
# Runs at the lowest I/O priority it can get: ionice -c3 + nice on Linux, taskpolicy -b on macOS.
set -u
if [ -z "${ORQ_MAINT_LOWPRIO:-}" ]; then
  ORQ_MAINT_LOWPRIO=1; export ORQ_MAINT_LOWPRIO
  if command -v ionice >/dev/null 2>&1; then exec ionice -c3 nice -n19 /bin/sh "$0" "$@"; fi
  if command -v taskpolicy >/dev/null 2>&1; then exec taskpolicy -b /bin/sh "$0" "$@"; fi
fi

KIT=$(cd "$(dirname "$0")/.." && pwd)
. "$KIT/maint/protect.sh"
AGE=${AGE:-360}
DRY=${DRY:-}
ORQ_HOME=${T3ORQ_HOME:-$HOME/.t3orq}
LOG=${LOG:-$ORQ_HOME/maint.log}
me=$(id -u)
work=$(mktemp -d "${TMPDIR:-/tmp}/diskclean.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT

stamp() { echo "$(date -u +%FT%TZ) disk-clean${DRY:+ (dry run)} $1"; }
if ! protect_init "$work"; then
  line=$(stamp "nothing deleted: the paths to keep could not be learned ($(head -1 "$work/keep.err" 2>/dev/null))")
  echo "$line" >&2
  [ -z "$DRY" ] && mkdir -p "$(dirname "$LOG")" && echo "$line" >> "$LOG"
  exit 1
fi

act_rm() { # remove a path, or say what would go
  if [ -n "$DRY" ]; then du -sk "$1" 2>/dev/null; else rm -rf -- "$1" 2>/dev/null; fi
}

clean_root() {
  r=$(resolve_root "$1") || return 0 # never a root reached through a link (but the system temp aliases)
  under_kept "$r" && return 0 # the root itself is kept, or is a repository: nothing under it is scratch
  find "$r" -mindepth 1 -maxdepth 1 -user "$me" -mmin +"$AGE" ! -path "$CTRL_GLOB" 2>/dev/null | while IFS= read -r e; do
    safe_under "$e" "$r" || continue # never a split line, never outside the root
    case "$(basename "$e")" in
      PostgreSQL.*|tmux-*|systemd-private-*|.X11-unix|.ICE-unix|.font-unix|snap-private-tmp|ssh-*|diskclean.*|com.apple.*|launchd*|*.sock) continue ;;
    esac
    [ -S "$e" ] && continue
    if [ -d "$e" ] && [ ! -L "$e" ]; then
      [ -n "$(find "$e" -type s -print -quit 2>/dev/null)" ] && continue
      [ -n "$(find "$e" -mmin -"$AGE" -print -quit 2>/dev/null)" ] && continue
    fi
    protected "$e" && continue
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

# Docker: build cache older than a day and dangling images. Tagged images (rollback copies), containers and volumes
# are never touched.
if [ -z "$DRY" ] && [ "${MAINT_DOCKER:-1}" != 0 ] && command -v docker >/dev/null 2>&1; then
  docker builder prune -f --filter until=24h >/dev/null 2>&1
  docker image prune -f >/dev/null 2>&1
fi

after=$(df -Pk "$HOME" | awk 'NR==2{print $4}')
line=$(stamp "freed=$(( (after - before) / 1048576 ))G avail=$(( after / 1048576 ))G")
if [ -n "$DRY" ]; then echo "$line"; else mkdir -p "$(dirname "$LOG")" && echo "$line" >> "$LOG" && echo "$line"; fi
