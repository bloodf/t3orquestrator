# Shared by disk-clean.sh and tmp-churn.sh (sourced): what a cleanup must never delete. Every path is compared by its
# real path, so a symlinked alias (/tmp and /private/tmp, a linked home) cannot bypass a rule.
#
#   protect_init     reads the keep list (`orq maint keep`), the maint-skip globs and the paths processes hold. It
#                    fails (returns 1) when the keep list cannot be learned: the caller then deletes nothing.
#   under_kept PATH  true when PATH is, or is under, a kept path or a maint-skip match, or is a repository root
#   protected PATH   true when PATH must stay: it is, is under, or holds a kept path; it matches a maint-skip glob, is
#                    under one, or holds a match; it is or holds a git repository or worktree (.git); a process holds
#                    it or something in it.
#
# $T3ORQ_HOME/maint-skip: one shell glob per line, matched against real paths (for example */t3-home.backup-*).

# The real path of PATH without following PATH itself when it is a symlink (deleting a link never touches its target).
canon_path() {
  _d=$(dirname "$1")
  _b=$(basename "$1")
  _r=$(cd "$_d" 2>/dev/null && pwd -P) || { printf '%s\n' "$1"; return 0; }
  case "$_r" in /) printf '/%s\n' "$_b" ;; *) printf '%s/%s\n' "$_r" "$_b" ;; esac
}

# A glob with the directory before its first wildcard made real, so it matches canon_path output.
canon_glob() {
  _g=$1
  _lit=${_g%%[*?[]*}
  case "$_lit" in */*) _dir=${_lit%/*} ;; *) printf '%s\n' "$_g"; return 0 ;; esac
  [ -n "$_dir" ] || { printf '%s\n' "$_g"; return 0; }
  _real=$(cd "$_dir" 2>/dev/null && pwd -P) || { printf '%s\n' "$_g"; return 0; }
  printf '%s%s\n' "$_real" "${_g#"$_dir"}"
}

protect_init() {
  PROTECT_WORK=$1
  _home=${T3ORQ_HOME:-$HOME/.t3orq}
  _me=$(id -u)
  # paths any process holds (open files, cwd, memory maps), made real
  if [ -d /proc/self ]; then
    for p in /proc/[0-9]*; do
      ls -l "$p/fd" 2>/dev/null | sed -n 's/.* -> //p'
      readlink "$p/cwd" 2>/dev/null
      awk '{print $6}' "$p/maps" 2>/dev/null
    done | grep '^/' | sort -u > "$PROTECT_WORK/busy"
  else
    lsof -n -u "$_me" -F n 2>/dev/null | sed -n 's/^n//p' | grep '^/' | sort -u > "$PROTECT_WORK/busy"
  fi
  # what orq must keep: leased projects, worktrees of leased and working threads (given raw and real)
  if [ -n "${ORQ:-}" ]; then
    # shellcheck disable=SC2086
    $ORQ maint keep > "$PROTECT_WORK/keep.raw" 2> "$PROTECT_WORK/keep.err" || return 1
  else
    node "$KIT/bin/orq.mjs" maint keep > "$PROTECT_WORK/keep.raw" 2> "$PROTECT_WORK/keep.err" || return 1
  fi
  : > "$PROTECT_WORK/keep"
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    printf '%s\n' "$k" >> "$PROTECT_WORK/keep"
    if [ -d "$k" ]; then (cd "$k" 2>/dev/null && pwd -P) >> "$PROTECT_WORK/keep"; else canon_path "$k" >> "$PROTECT_WORK/keep"; fi
  done < "$PROTECT_WORK/keep.raw"
  : > "$PROTECT_WORK/skip"
  if [ -f "$_home/maint-skip" ]; then
    while IFS= read -r g; do
      [ -n "$g" ] || continue
      printf '%s\n' "$g" >> "$PROTECT_WORK/skip"
      canon_glob "$g" >> "$PROTECT_WORK/skip"
    done < "$_home/maint-skip"
  fi
  return 0
}

# PATH (real) is, is under, or holds an entry of FILE.
_prefix_hit() {
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    case "$1/" in "$k"/*) return 0 ;; esac
    case "$k/" in "$1"/*) return 0 ;; esac
  done < "$2"
  return 1
}

# PATH (real) is a kept path or under one, or matches or is under a maint-skip glob: everything below it stays. For a
# root that is only searched (a temp dir), not deleted.
under_kept() {
  _p=$(canon_path "$1")
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    case "$_p/" in "$k"/*) return 0 ;; esac
  done < "$PROTECT_WORK/keep"
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254
    case "$_p" in $g|$g/*) return 0 ;; esac
  done < "$PROTECT_WORK/skip"
  [ -e "$_p/.git" ] && return 0 # a repository is never a temp root
  return 1
}

protected() {
  _p=$(canon_path "$1")
  _prefix_hit "$_p" "$PROTECT_WORK/keep" && return 0
  grep -qxF "$_p" "$PROTECT_WORK/busy" && return 0 # held itself
  grep -qF "$_p/" "$PROTECT_WORK/busy" && return 0 # something in it is held
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    # shellcheck disable=SC2254
    case "$_p" in $g|$g/*) return 0 ;; esac
    [ -d "$_p" ] && [ ! -L "$_p" ] && [ -n "$(find "$_p" -path "$g" -print -quit 2>/dev/null)" ] && return 0
  done < "$PROTECT_WORK/skip"
  [ "$(basename "$_p")" = .git ] && return 0
  if [ -d "$_p" ] && [ ! -L "$_p" ]; then
    [ -e "$_p/.git" ] && return 0
    [ -n "$(find "$_p" -name .git -print -quit 2>/dev/null)" ] && return 0
  fi
  return 1
}
