# cortex-client — helpers shared by setup.sh and verify.sh.
#
# This file exists because setup and verify MUST NOT be able to disagree. When
# each carried its own copy of "is the path outside the tree" and "does the CLI
# run", they drifted: setup accepted a binary verify could not execute, wrote a
# SUCCESS receipt, and verify then blamed a missing build. One implementation,
# both callers.
#
# Sourced, never executed. The caller must define die() before sourcing, and set
# GUARD_REPO_ROOT (see garrison_repo_root).

# How long any invocation of the third-party CLI may take. It is a `--version`
# call; 20s is a cold node start on a loaded box, not a working budget.
PROBE_TIMEOUT_SECS="${PROBE_TIMEOUT_SECS:-20}"

expand_tilde() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Absolute, symlink-resolved path for a path that may not exist yet - the guard
# has to run before anything is created. GNU `realpath -m` does both; BSD
# realpath (macOS) has no -m and only takes existing paths, so it is tried
# plain, then python3's realpath (which resolves the existing prefix of a
# missing path). Symlink resolution is load-bearing: a repository can commit a
# symlink pointing outside its clone, and a check on the unresolved path would
# pass it. The printf fallback normalises nothing, which is why
# guard_outside_tree refuses `..` segments outright.
resolve_abs() {
  local p
  p="$(expand_tilde "$1")"
  case "$p" in /*) : ;; *) p="$PWD/$p" ;; esac
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$p" 2>/dev/null && return
    realpath "$p" 2>/dev/null && return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null && return
  fi
  printf '%s' "$p"
}

# Garrison's own worktree, resolved from the calling script's location.
garrison_repo_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || true
}

# BYTE CONTAINMENT. Refuses any path that would put third-party bytes — or a link
# to them, or a mode change — inside Garrison's own source tree. This is a
# filesystem guard and nothing more: it says where files may LAND, never what the
# cloned repository is allowed to DO once it is there.
guard_outside_tree() {
  local label="$1" p="$2"
  case "/$p/" in
    */../*) die "$label ($p) contains a '..' segment — refusing to resolve it, aborting before any write" ;;
  esac
  if [ -n "${GUARD_REPO_ROOT:-}" ]; then
    case "$p/" in
      "$GUARD_REPO_ROOT"/*)
        die "$label ($p) is INSIDE Garrison's own source tree ($GUARD_REPO_ROOT) — aborting before any write" ;;
    esac
  fi
  case "$p" in
    */dev/garrison/*|*/Projects/garrison/*)
      die "$label ($p) matches a Garrison source path — aborting before any write" ;;
  esac
}

# Everything this Fitting touches on the third-party side must live inside the
# clone. A package.json `bin` of "../../../../elsewhere/file.mjs" is repo-supplied
# input, not configuration, and it reaches chmod and ln.
require_inside_clone() {
  local label="$1" p="$2" clone="$3"
  case "$p/" in
    "$clone"/*) : ;;
    *) die "$label ($p) escapes the clone ($clone) — refusing" ;;
  esac
}

# A bin entry with no `#!` line is not runnable: consumers exec the receipt's
# `bin` path directly, execve fails ENOEXEC, and the caller's shell interprets
# the file as a script instead. That is how a JavaScript bin shim became a
# blocking ImageMagick `import` call that wedged the whole setup budget.
require_shebang() {
  local f="$1" head_bytes
  [ -f "$f" ] || die "the package's bin entry ($f) does not exist"
  head_bytes="$(head -c 2 "$f" 2>/dev/null)"
  [ "$head_bytes" = "#!" ] ||
    die "the package's bin entry ($f) has no '#!' line — consumers invoke it directly, and a shell would interpret it instead of running it"
}

# Run a command with its stdin closed, its stdout captured, and a hard ceiling.
# Returns 124 on timeout. `timeout` is preferred; the poll fallback keeps the
# ceiling on a box that has no coreutils timeout.
run_bounded() {
  local secs="$1" out="$2"
  shift 2
  : >"$out"
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 2 "$secs" "$@" >"$out" 2>/dev/null </dev/null
    return $?
  fi
  "$@" >"$out" 2>/dev/null </dev/null &
  local pid=$! waited=0 limit=$((secs * 10))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    waited=$((waited + 1))
    sleep 0.1
  done
  wait "$pid"
  return $?
}

# THE probe. `--version` is the one invocation that needs no configuration, so it
# is both the build check and the liveness check. The provider variables are
# stripped so a probe can never pass merely because a key is in the environment.
# $2 receives the CLI's stdout.
probe_cli() {
  local bin="$1" out="$2"
  run_bounded "$PROBE_TIMEOUT_SECS" "$out" env -u CORTEX_API_KEY -u CORTEX_BASE_URL "$bin" --version
}
