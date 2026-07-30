#!/usr/bin/env bash
# loop-heartbeat setup — register the heartbeat with the scheduler.
#
# Until this hook existed the Fitting was inert: it shipped a working `daemon`
# mode, verified green via `--probe`, and nothing anywhere ever started it or
# registered it. Stationing it bought a no-op that looked healthy.
#
# Registered as a scheduler LISTENER, not a cron job. A listener is a
# long-running worker the daemon supervises and restarts with backoff, which is
# what `heartbeat.mjs daemon` already is — and it gives an EXACT cadence. Cron
# cannot: `cadence_minutes: 40` as `*/40 * * * *` fires at :00 and :40, i.e. a
# 40-then-20-minute rhythm, not every 40 minutes.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log() { printf '[loop-heartbeat-setup] %s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  echo "node not on PATH; install Node 20+ and re-run" >&2
  exit 1
fi

# Resolve the scheduler as a sibling under _local, relative to THIS script.
# Never via $(pwd): setup hooks run with cwd = this fitting's own installed dir,
# so "$(pwd)/apm_modules/_local/scheduler" resolves inside ourselves and misses.
SCHED="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"
if [ ! -f "$SCHED" ]; then
  echo "scheduler is required for loop-heartbeat; add it to your composition" >&2
  echo "  (looked for the scheduler CLI at $SCHED)" >&2
  exit 1
fi

# Config arrives as <FITTING_ID>_<KEY> (setupConfigEnv in src/lib/runner.ts),
# already profile-shifted by applyPortOffsetToConfig.
CADENCE="${LOOP_HEARTBEAT_CADENCE_MINUTES:-40}"
case "$CADENCE" in
  ''|*[!0-9]*) echo "cadence_minutes must be a positive integer, got '$CADENCE'" >&2; exit 1 ;;
esac
[ "$CADENCE" -ge 1 ] || { echo "cadence_minutes must be >= 1, got $CADENCE" >&2; exit 1; }

# Gateway target: the composition's explicit value wins, else the address the
# runner projects for THIS instance. No port literal fallback — a guess names one
# instance and silently posts this instance's jobs to another operative.
TARGET="${LOOP_HEARTBEAT_GATEWAY_URL:-${GARRISON_GATEWAY_URL:-}}"
if [ -z "$TARGET" ]; then
  echo "loop-heartbeat: no gateway address (neither the fitting's gateway_url config nor" >&2
  echo "  GARRISON_GATEWAY_URL). Refusing to register a heartbeat that would guess an instance." >&2
  exit 1
fi
# GARRISON_GATEWAY_URL is a base URL; the fitting's own config carries /jobs.
case "$TARGET" in
  */jobs) ;;
  *) TARGET="${TARGET%/}/jobs" ;;
esac

# The scheduler runs jobs through `sh -c` with the DAEMON's env, which carries no
# gateway address — so the job command carries its own instance identity, the same
# pattern kanban-loop's tick uses (see its lib/instance-env.mjs).
JOB_CMD="GARRISON_GATEWAY_URL='$TARGET' GARRISON_HEARTBEAT_MINUTES='$CADENCE' node '$FITTING_DIR/scripts/heartbeat.mjs' daemon"

# `register`, not `add`: this hook re-runs on every `up`, and `add` hardcodes
# enabled:true, which would resurrect a heartbeat the user deliberately stopped.
# Listeners ignore the cron field; a valid placeholder keeps the record uniform.
log "registering listener loop-heartbeat (every ${CADENCE}m -> ${TARGET})"
node "$SCHED" register loop-heartbeat "*/${CADENCE} * * * *" \
  --type listener \
  --description "Synthetic heartbeat tick dispatched to the Operative every ${CADENCE}m" \
  -- "$JOB_CMD" >/dev/null

echo "ok"
