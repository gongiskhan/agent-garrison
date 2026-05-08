#!/usr/bin/env bash
# Morning-briefing Fitting setup. Idempotent: re-run is safe.
#
# Behavior:
#   1. Locate the scheduler CLI in the composition.
#   2. Resolve briefing_time + weekdays_only from env (with defaults
#      matching apm.yml's config_schema).
#   3. Compute the cron string via briefing.py --cron.
#   4. Register (or replace) the morning-briefing job idempotently.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log() { printf '[morning-briefing-setup] %s\n' "$*"; }

# 1. Required tooling.
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not on PATH; install Python 3.10+ and re-run" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 20+ and re-run" >&2
  exit 1
fi

# 2. Locate scheduler. cwd = composition dir per the runner contract.
SCHED="$(pwd)/apm_modules/_local/scheduler/scripts/scheduler.mjs"
if [ ! -f "$SCHED" ]; then
  echo "scheduler is required for the morning briefing Fitting; add it to your composition" >&2
  exit 1
fi

# 3. Resolve config.
TIME="${GARRISON_BRIEFING_TIME:-08:00}"
WEEKDAYS="${GARRISON_BRIEFING_WEEKDAYS_ONLY:-true}"

# 4. Compute cron string.
if ! CRON="$(python3 "$FITTING_DIR/scripts/briefing.py" --cron "$TIME" "$WEEKDAYS")"; then
  echo "failed to compute cron from time=$TIME weekdays=$WEEKDAYS" >&2
  exit 1
fi
log "cron = $CRON  (time=$TIME, weekdays_only=$WEEKDAYS)"

# 5. Register the job. add replaces by id, so re-runs (config changes)
#    overwrite cleanly.
WRAPPER="bash $FITTING_DIR/scripts/briefing.sh"
log "registering scheduler job morning-briefing"
node "$SCHED" add morning-briefing "$CRON" "$WRAPPER" >/dev/null

echo "ok"
