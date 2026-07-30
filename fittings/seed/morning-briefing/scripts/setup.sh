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

# 2. Locate scheduler. NOT via $(pwd): the runner runs SETUP hooks with cwd =
#    the fitting's own installed dir (runFittingSetup in src/lib/runner.ts),
#    while VERIFY hooks get the composition dir. Resolving
#    "$(pwd)/apm_modules/_local/scheduler/..." from a setup hook therefore looked
#    inside .../_local/morning-briefing/apm_modules/... and always missed, so a
#    perfectly well-fitted scheduler reported as "not in your composition".
#    Resolve the sibling package under _local relative to THIS fitting instead —
#    which also works when the script is run straight out of fittings/seed/.
SCHED="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"
if [ ! -f "$SCHED" ]; then
  echo "scheduler is required for the morning briefing Fitting; add it to your composition" >&2
  echo "  (looked for the scheduler CLI at $SCHED)" >&2
  exit 1
fi

# 3. Resolve config. The runner projects the composition's config as
#    <FITTING_ID>_<KEY> (setupConfigEnv in src/lib/runner.ts), i.e.
#    MORNING_BRIEFING_BRIEFING_TIME — NOT the GARRISON_BRIEFING_TIME name
#    apm.yml documents as the runtime override. Reading only the GARRISON_*
#    name meant the composition's configured briefing_time never reached this
#    hook: it silently used 08:00 whatever the user set. Precedence:
#    explicit runtime override > composition config > schema default.
TIME="${GARRISON_BRIEFING_TIME:-${MORNING_BRIEFING_BRIEFING_TIME:-08:00}}"
WEEKDAYS="${GARRISON_BRIEFING_WEEKDAYS_ONLY:-${MORNING_BRIEFING_WEEKDAYS_ONLY:-true}}"

# 4. Compute cron string.
if ! CRON="$(python3 "$FITTING_DIR/scripts/briefing.py" --cron "$TIME" "$WEEKDAYS")"; then
  echo "failed to compute cron from time=$TIME weekdays=$WEEKDAYS" >&2
  exit 1
fi
log "cron = $CRON  (time=$TIME, weekdays_only=$WEEKDAYS)"

# 5. Register the job.
#    `register`, not `add`: this hook re-runs on EVERY `up`, and `add` hardcodes
#    enabled:true, so it silently resurrected a briefing the user had explicitly
#    disabled. `register` preserves an existing enable/disable choice.
#    The command carries its own instance identity: the scheduler daemon runs
#    jobs through `sh -c` with the DAEMON's env, which has no gateway address, so
#    briefing.py would otherwise have to guess which instance to POST to.
WRAPPER="bash $FITTING_DIR/scripts/briefing.sh"
if [ -n "${GARRISON_GATEWAY_URL:-}" ]; then
  WRAPPER="GARRISON_GATEWAY_URL='${GARRISON_GATEWAY_URL}' $WRAPPER"
fi
log "registering scheduler job morning-briefing"
node "$SCHED" register morning-briefing "$CRON" \
  --description "Daily Trello + Calendar briefing posted to Slack" \
  -- "$WRAPPER" >/dev/null

echo "ok"
