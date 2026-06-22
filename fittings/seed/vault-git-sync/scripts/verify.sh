#!/usr/bin/env bash
# Verify vault-git-sync is wired: the scheduler CLI is reachable and the
# vault-git-sync job is registered. Prints "ok" on success.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FITTING_DIR="$(cd "$SELF_DIR/.." && pwd)"
SCHEDULER="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"

if [ ! -f "$SCHEDULER" ]; then
  echo "scheduler CLI not found at $SCHEDULER" >&2
  exit 1
fi

if node "$SCHEDULER" list | grep -q '"id": "vault-git-sync"'; then
  echo "ok"
else
  echo "vault-git-sync job not registered (run setup)" >&2
  exit 1
fi
