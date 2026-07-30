#!/usr/bin/env bash
# vault-sync Fitting setup. Idempotent: re-run is safe.
#
# Registers (or replaces) a vault-sync cron job in the scheduler.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log() { printf '[vault-sync-setup] %s\n' "$*"; }

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 20+ and re-run" >&2
  exit 1
fi

# Locate scheduler. NOT via $(pwd): the runner runs SETUP hooks with cwd = the
# fitting's own installed dir (runFittingSetup in src/lib/runner.ts); only VERIFY
# hooks get the composition dir. Resolve the sibling _local package relative to
# THIS fitting, which also works straight out of fittings/seed/.
SCHED="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"
if [ ! -f "$SCHED" ]; then
  echo "scheduler is required for vault-sync; add it to your composition" >&2
  echo "  (looked for the scheduler CLI at $SCHED)" >&2
  exit 1
fi

# Compute cron interval from config.
INTERVAL="${GARRISON_VAULT_SYNC_INTERVAL:-60}"
CRON_MIN=$(( INTERVAL / 60 ))
[ "$CRON_MIN" -lt 1 ] && CRON_MIN=1
CRON="*/$CRON_MIN * * * *"

WRAPPER="bash $FITTING_DIR/scripts/sync.sh"
log "registering scheduler job vault-sync (cron=$CRON)"
node "$SCHED" add vault-sync "$CRON" "$WRAPPER" >/dev/null

echo "ok"
