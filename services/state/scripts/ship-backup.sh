#!/usr/bin/env bash
# S13(b): ship the newest daily snapshot OFF-BOX to a peer node. Durability
# never has a single home even when state does. Direction is deliberately the
# REVERSE of the evidence backup. The snapshot is encrypted-at-rest; the
# master key stays in this machine's keychain, so a shipped snapshot alone
# cannot decrypt secrets.
#
#   ship-backup.sh <ssh-target>            e.g. ggomes@100.108.210.116
#
# Receiving side: ~/.garrison-state-backup/<file>, 0600, week-rolling prune
# ON THE SINK.
set -euo pipefail

TARGET="${1:?usage: ship-backup.sh <ssh-target>}"
STATE_HOME="${GARRISON_STATE_HOME:-$HOME/.garrison-state}"

# Take a fresh daily snapshot first.
(cd "$STATE_HOME/current" && node scripts/backup.mjs --daily)

NEWEST="$(ls -t "$STATE_HOME"/backups/garrison-daily-*.db 2>/dev/null | head -1)"
if [ -z "$NEWEST" ]; then
  echo "ship-backup: no daily snapshot found" >&2
  exit 1
fi

ssh -o BatchMode=yes "$TARGET" 'mkdir -p ~/.garrison-state-backup && chmod 700 ~/.garrison-state-backup'
scp -q "$NEWEST" "$TARGET:.garrison-state-backup/"
ssh -o BatchMode=yes "$TARGET" '
  chmod 600 ~/.garrison-state-backup/*.db 2>/dev/null || true
  find ~/.garrison-state-backup -name "garrison-daily-*.db" -mtime +7 -delete
  ls ~/.garrison-state-backup | tail -3
'
echo "shipped $(basename "$NEWEST") to $TARGET"
