#!/usr/bin/env bash
# Obsidian vault git sync — IN-TREE, so APM ships it to every machine.
#
# It previously lived only in ~/.claude/tools/, which is a separate repo with no
# remote and is not part of any fitting payload. An outpost therefore had no copy
# at all, and Outpost Dispatch's memory-freshness step (pull before a card, push
# after) could never have worked there. sync.sh still honours
# OBSIDIAN_VAULT_SYNC_SCRIPT, so an existing hardened copy keeps winning.
#
# Strategy — non-destructive, never hard-resets:
#   1. Stage + commit local changes first (captures agent/editor writes).
#   2. git pull --rebase --autostash to ingest other machines below our commit.
#   3. On rebase conflict: abort (restores pre-rebase state) and log; never reset.
#   4. git push.
#
# MODES (this is the addition Outpost Dispatch needs):
#   --pull   ingest only. Does NOT commit or push. Used before a dispatched card
#            so it starts from other machines' memory without also publishing
#            whatever happens to be dirty in the vault at that moment — which the
#            full sync would do, attributing another agent's in-flight writes to
#            this card.
#   --push   commit + push only, no rebase-ingest beyond what push needs. Used on
#            terminal status so memory written during the card reaches the other
#            machines immediately.
#   (none)   the full cycle, as the nightly job has always run it.
#
# EXIT 0 DOES NOT MEAN A SYNC HAPPENED. The lock guard below returns 0 without
# touching git when another sync is in flight. A caller that needs proof must
# check that the status file's `ts` advanced — see --require-fresh.

set -uo pipefail

MODE="full"
REQUIRE_FRESH=0
for arg in "$@"; do
  case "$arg" in
    --pull) MODE="pull" ;;
    --push) MODE="push" ;;
    --require-fresh) REQUIRE_FRESH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

VAULT="${OBSIDIAN_VAULT:-$HOME/ObsidianVault}"
# Expand a leading ~ that arrived quoted. The scheduler bakes the configured
# path into a job command and runs it via `/bin/sh -c`, where '~/ObsidianVault'
# stays literal — the exact bug that left this job dead for weeks while its
# verify hook reported PASS.
case "$VAULT" in
  "~") VAULT="$HOME" ;;
  "~/"*) VAULT="$HOME/${VAULT#\~/}" ;;
esac

STATUS_DIR="${GARRISON_HOME:-$HOME/.garrison}"
STATUS="$STATUS_DIR/obsidian-vault-sync-status.json"
LOCK="$STATUS_DIR/obsidian-vault-sync.lock"
# macOS keeps user logs under ~/Library/Logs; Linux has no such dir.
if [ -d "$HOME/Library/Logs" ]; then
  LOG="$HOME/Library/Logs/obsidian-vault-sync.log"
else
  LOG="$STATUS_DIR/obsidian-vault-sync.log"
fi

mkdir -p "$STATUS_DIR" "$(dirname "$LOG")"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >>"$LOG"; }

write_status() {
  local msg="$2"
  msg="${msg//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  msg="${msg//$'\n'/ }"
  printf '{"state":"%s","message":"%s","mode":"%s","ts":"%s"}\n' "$1" "$msg" "$MODE" "$(ts)" >"$STATUS"
}

# Single-instance lock (mkdir is atomic). Stale locks older than 30 min clear.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ] && [ "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null || { log "lock held, exiting"; exit 0; }
  else
    log "another sync is running, exiting"
    # A caller that DEMANDED a fresh sync must not read this as success.
    [ "$REQUIRE_FRESH" -eq 1 ] && { echo "another sync holds the lock; no sync performed" >&2; exit 75; }
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$VAULT" 2>/dev/null || { log "vault not found at $VAULT"; write_status error "vault dir missing: $VAULT"; exit 1; }

if [ ! -d .git ]; then
  log "no git repo in vault"; write_status error "no .git in vault"; exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# 0. Mirror Claude's native Garrison project memory into the vault (ported from
#    the retired ~/.claude/tools copy, which the systemd timer used to run).
#    FAIL CLOSED when the mirror exists: a vault commit must not silently omit
#    a mirror update. A node WITHOUT the mirror script (the Macs — tools/ is
#    not in the portable subset) still syncs; only dev-madrid mirrors.
MEMORY_MIRROR="${CLAUDE_MEMORY_MIRROR:-$HOME/.claude/tools/claude-memory-to-obsidian.py}"
if [ "$MODE" != "pull" ] && [ -x "$MEMORY_MIRROR" ]; then
  if ! "$MEMORY_MIRROR" >>"$LOG" 2>&1; then
    log "Claude memory mirror failed; vault sync deferred"
    write_status error "Claude memory mirror failed; vault sync deferred"
    exit 1
  fi
fi

# 1. Commit local changes — skipped in pull mode, which must not publish
#    whatever another agent happens to have mid-write.
LOCAL_CHANGES=0
if [ "$MODE" != "pull" ]; then
  git add -A
  if ! git diff --cached --quiet; then
    git commit -q -m "vault sync: $(ts)" 2>>"$LOG"
    log "committed local changes"
    LOCAL_CHANGES=1
  fi
fi

# 2. Ingest remote. Skipped in push mode.
if [ "$MODE" != "push" ]; then
  if ! git pull --rebase --autostash origin "$BRANCH" >>"$LOG" 2>&1; then
    log "rebase conflict — aborting (no data lost; manual resolution needed)"
    git rebase --abort >>"$LOG" 2>&1 || true
    write_status conflict "git pull --rebase hit a conflict; aborted. Resolve manually in $VAULT."
    exit 1
  fi
fi

# 3. Push if we are ahead. Skipped in pull mode.
if [ "$MODE" != "pull" ]; then
  if [ -n "$(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
    if git push origin "$BRANCH" >>"$LOG" 2>&1; then
      log "pushed"
      write_status ok "synced"
    # Push mode skips step 2, so losing a push race to another node is
    # NORMAL here (not network/auth). Heal in place: ingest the remote,
    # then retry once. Only a second failure is a real fault.
    elif git pull --rebase --autostash origin "$BRANCH" >>"$LOG" 2>&1 \
      && git push origin "$BRANCH" >>"$LOG" 2>&1; then
      log "pushed after rebase (lost a push race, healed)"
      write_status ok "synced"
    else
      git rebase --abort >>"$LOG" 2>&1 || true
      log "push failed (network/auth?)"
      write_status push-failed "git push failed; will retry next interval"
      exit 1
    fi
  else
    [ "$LOCAL_CHANGES" -eq 0 ] && write_status nochange "nothing to sync" || write_status ok "synced (already current)"
  fi
else
  write_status ok "pulled"
fi

log "done ($MODE)"
exit 0
