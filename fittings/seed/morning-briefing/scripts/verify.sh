#!/usr/bin/env bash
# Verifies the morning-briefing Fitting is wired correctly.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log_err() { printf '%s\n' "$*" >&2; }

# 1. Scheduler must list the morning-briefing job.
SCHED="$(pwd)/apm_modules/_local/scheduler/scripts/scheduler.mjs"
if [ ! -f "$SCHED" ]; then
  log_err "scheduler not present at $SCHED"
  exit 1
fi
if ! node "$SCHED" list 2>/dev/null | grep -q '"morning-briefing"'; then
  log_err "scheduler does not list a morning-briefing job; run setup"
  exit 1
fi

# 2. Briefing wrapper exists + executable.
BRIEFING="$FITTING_DIR/scripts/briefing.sh"
if [ ! -x "$BRIEFING" ]; then
  log_err "briefing wrapper not executable: $BRIEFING"
  exit 1
fi

# 3. Gateway /health reachable.
HOST="${GARRISON_GATEWAY_HOST:-127.0.0.1}"
PORT="${GARRISON_GATEWAY_PORT:-4777}"
HEALTH_URL="http://${HOST}:${PORT}/health"
if ! curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log_err "gateway /health unreachable at $HEALTH_URL"
  exit 1
fi

echo "ok"
