#!/usr/bin/env bash
# Verify vault-git-sync is actually WORKING, not merely registered.
#
# The old hook grepped `scheduler list` for the job id. Registration is not
# health: the job was registered the whole time it was dying every night on an
# unexpanded tilde, so `up` reported PASS for weeks while nothing synced. A
# verify that cannot fail when the thing is broken is worse than no verify,
# because it converts an outage into a green check.
#
# What this now proves, in order of how badly each failure bites:
#   1. the scheduler CLI exists and the job is registered   (as before)
#   2. the vault directory the job will actually cd into EXISTS
#      — i.e. the baked command's path resolves, tilde and all
#   3. it is a git repo with an origin remote
#   4. the last recorded run did not end in an error state
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FITTING_DIR="$(cd "$SELF_DIR/.." && pwd)"
SCHEDULER="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"
STATUS_DIR="${GARRISON_HOME:-$HOME/.garrison}"
STATUS="$STATUS_DIR/obsidian-vault-sync-status.json"

fail() { echo "vault-git-sync: $1" >&2; exit 1; }

[ -f "$SCHEDULER" ] || fail "scheduler CLI not found at $SCHEDULER"

JOBS="$(node "$SCHEDULER" list 2>/dev/null || true)"
echo "$JOBS" | grep -q '"id": "vault-git-sync"' || fail "job not registered (run setup)"

# 2. Resolve the vault path the SAME way the job will, including the tilde
#    expansion, and confirm it exists. This is the check that would have caught
#    the silent failure on day one.
VAULT_DIR="${VAULT_GIT_SYNC_VAULT_DIR:-$HOME/ObsidianVault}"
case "$VAULT_DIR" in
  "~") VAULT_DIR="$HOME" ;;
  "~/"*) VAULT_DIR="$HOME/${VAULT_DIR#\~/}" ;;
esac
[ -d "$VAULT_DIR" ] || fail "vault dir does not exist: $VAULT_DIR (a quoted ~ that never expanded is the usual cause)"

# 3. A directory is not a syncable vault unless it is a git repo with a remote.
[ -d "$VAULT_DIR/.git" ] || fail "no git repo at $VAULT_DIR"
git -C "$VAULT_DIR" remote get-url origin >/dev/null 2>&1 || fail "no 'origin' remote in $VAULT_DIR — nothing to sync to"

# 4. The last run's outcome. A never-run job is acceptable (freshly set up); a
#    job whose last run ERRORED is not.
if [ -f "$STATUS" ]; then
  STATE="$(sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS" | head -1)"
  TS="$(sed -n 's/.*"ts"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATUS" | head -1)"
  case "$STATE" in
    error|conflict|push-failed)
      fail "last sync ended in state '$STATE' at $TS — see the sync log"
      ;;
  esac
  echo "vault-git-sync: last run '$STATE' at $TS"
fi

echo "vault-git-sync: $VAULT_DIR is a git repo with an origin remote; job registered"
echo "ok"
