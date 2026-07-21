#!/usr/bin/env bash
# codegraph-autoinit.sh  —  SessionStart hook
#
# If the current session's project is a git repo under a dev root (~/dev or
# ~/Projects) and has NO .codegraph index yet, kick off `codegraph init` in the
# BACKGROUND so the index exists for future sessions. Never blocks session start.
#
# Reindexing is NOT handled here on purpose: codegraph's MCP server watches files
# (debounced auto-sync on every change) AND reconciles the backlog ((size,mtime)+
# content-hash vs the working tree) on (re)connect before its first query. So once
# a project is initialized, the index stays current automatically — a reindex hook
# would be redundant and wasteful.
#
# Gating (all must hold):
#   * codegraph is installed
#   * the project root (git toplevel) is under realpath(~/dev) or realpath(~/Projects)
#   * it is an actual git repo (cheap signal that it is a code project; right granularity)
#   * it is not the dev root itself
#   * it has no .codegraph/ directory yet
#   * no auto-init failed for it in the last 7 days (cooldown, removable)
#
# Concurrency: an atomic mkdir lock (stale after 2h) prevents parallel sessions
# from double-initializing the same repo.
#
# FAIL SAFE: any error / ambiguity -> exit 0. Never break session start, never
# print to stdout (keeps zero token cost). Diagnostics go to the state-dir log.
#
# Test without side effects:  CODEGRAPH_AUTOINIT_DRYRUN=1 echo '{"cwd":"<path>"}' | bash codegraph-autoinit.sh
set -u

DRY="${CODEGRAPH_AUTOINIT_DRYRUN:-0}"
say() { [ "$DRY" = "1" ] && echo "$*"; }

INPUT="$(cat 2>/dev/null || true)"

# --- cwd from the hook's JSON stdin, with safe fallbacks ---
CWD=""
if command -v jq >/dev/null 2>&1; then
  CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"
fi
[ -n "$CWD" ] || CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$CWD" ] || { say "SKIP: cwd not a dir ($CWD)"; exit 0; }

command -v codegraph >/dev/null 2>&1 || { say "SKIP: codegraph not installed"; exit 0; }

realpath_f() { ( cd "$1" 2>/dev/null && pwd -P ); }

# --- dev roots (resolved; the two differ on this machine) ---
DEV1="$(realpath_f "$HOME/dev")"
DEV2="$(realpath_f "$HOME/Projects")"
under() {  # under <path> <root>  -> 0 if path == root or inside root
  [ -n "$2" ] || return 1
  case "$1/" in "$2/"*) return 0;; *) return 1;; esac
}
in_dev() { under "$1" "$DEV1" || under "$1" "$DEV2"; }

CWD_REAL="$(realpath_f "$CWD")"
[ -n "$CWD_REAL" ] || { say "SKIP: cannot resolve cwd"; exit 0; }
in_dev "$CWD_REAL" || { say "SKIP: not under a dev root ($CWD_REAL)"; exit 0; }

# --- project root = git toplevel; require a git repo (code-project signal) ---
ROOT="$(git -C "$CWD_REAL" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || { say "SKIP: not a git repo ($CWD_REAL)"; exit 0; }
ROOT="$(realpath_f "$ROOT")"
[ -n "$ROOT" ] || exit 0

# git toplevel could escape the dev root (e.g. ~/.claude); re-check and exclude root itself
in_dev "$ROOT" || { say "SKIP: git root outside dev ($ROOT)"; exit 0; }
case "$ROOT" in "$DEV1"|"$DEV2") { say "SKIP: dev root itself"; exit 0; };; esac

# --- already initialized? codegraph keeps it synced itself. ---
[ -d "$ROOT/.codegraph" ] && { say "SKIP: already initialized ($ROOT)"; exit 0; }

# --- state dir + per-repo key ---
STATE="$HOME/.cache/codegraph-autoinit"
mkdir -p "$STATE" 2>/dev/null || true
KEY="$(printf '%s' "$ROOT" | shasum 2>/dev/null | awk '{print $1}')"
[ -n "$KEY" ] || KEY="$(printf '%s' "$ROOT" | cksum | awk '{print $1}')"
FAILED="$STATE/$KEY.failed"
LOCK="$STATE/$KEY.lock"
LOG="$STATE/$KEY.log"

# --- failure cooldown (don't re-hammer a repo that keeps failing to index) ---
if [ -f "$FAILED" ]; then
  if find "$FAILED" -mtime -7 2>/dev/null | grep -q .; then
    say "SKIP: failed within 7d (rm $FAILED to retry)"; exit 0
  fi
  rm -f "$FAILED" 2>/dev/null
fi

if [ "$DRY" = "1" ]; then
  echo "WOULD INIT: codegraph init \"$ROOT\"  (log: $LOG)"
  exit 0
fi

# --- atomic lock; reclaim if stale (>2h) ---
if ! mkdir "$LOCK" 2>/dev/null; then
  if find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null | grep -q .; then
    rm -rf "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi

# --- background the (expensive) init; detached so it survives the hook returning ---
( nohup bash -c '
    root="$1"; lock="$2"; failed="$3"; log="$4"
    {
      echo "[codegraph-autoinit] $(date) init start: $root"
      if codegraph init "$root" >/dev/null 2>&1; then
        echo "[codegraph-autoinit] $(date) init OK: $root"
        # keep the index out of git LOCALLY (.git/info/exclude), without touching
        # the tracked .gitignore — no committed change, no cross-machine noise.
        gd="$(cd "$root" && git rev-parse --git-common-dir 2>/dev/null)"
        case "$gd" in "") : ;; /*) : ;; *) gd="$root/$gd";; esac
        if [ -n "$gd" ]; then
          mkdir -p "$gd/info" 2>/dev/null
          ex="$gd/info/exclude"
          if ! grep -qxF ".codegraph/" "$ex" 2>/dev/null; then
            printf "\n# CodeGraph index (local; added by codegraph-autoinit hook)\n.codegraph/\n" >> "$ex"
            echo "[codegraph-autoinit] $(date) excluded .codegraph/ via $ex"
          fi
        fi
      else
        rc=$?; echo "[codegraph-autoinit] $(date) init FAILED rc=$rc: $root"; touch "$failed"
      fi
    } >>"$log" 2>&1
    rmdir "$lock" 2>/dev/null
  ' _ "$ROOT" "$LOCK" "$FAILED" "$LOG" >/dev/null 2>&1 </dev/null & ) >/dev/null 2>&1

exit 0
