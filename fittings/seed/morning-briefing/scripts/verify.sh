#!/usr/bin/env bash
# Verifies the morning-briefing Fitting is wired correctly.
set -euo pipefail

FITTING_DIR="$(cd "$(dirname "$0")/.." && pwd)"
log_err() { printf '%s\n' "$*" >&2; }

# 1. Scheduler must list the morning-briefing job. Resolved relative to THIS
#    script, not $(pwd): verify hooks run with cwd = the composition dir while
#    setup hooks get the fitting's installed dir, and a $(pwd)-relative path is
#    therefore only correct for one of the two. Resolving via the sibling
#    package under _local is correct from either.
SCHED="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"
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

# 3. Gateway /health — advisory only. Verify hooks run BEFORE up() spawns the
# gateway, so failing on unreachability deadlocks every cold start (verified
# live on prod: down -> up could never pass this). The fitting's own wiring is
# steps 1-2; gateway liveness is the composition's runtime concern. Port is
# never a literal for one instance: base 4777 shifted by the profile offset
# (prod +1000, codex +20000), same derivation as scripts/garrison-instance.sh;
# an explicit GARRISON_GATEWAY_URL/PORT still wins.
if [ -n "${GARRISON_GATEWAY_URL:-}" ]; then
  HEALTH_URL="${GARRISON_GATEWAY_URL%/}/health"
else
  HOST="${GARRISON_GATEWAY_HOST:-127.0.0.1}"
  PORT="${GARRISON_GATEWAY_PORT:-$((4777 + ${GARRISON_PORT_OFFSET:-0}))}"
  HEALTH_URL="http://${HOST}:${PORT}/health"
fi
if ! curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  log_err "note: gateway /health not answering yet at $HEALTH_URL (expected before the operative spawns)"
fi

echo "ok"
