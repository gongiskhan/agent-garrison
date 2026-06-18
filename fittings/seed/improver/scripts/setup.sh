#!/usr/bin/env bash
# Improver setup — register the nightly run with the scheduler (morning-briefing
# pattern: CLI shell-out from the consumer's setup). Idempotent: remove then add.
set -euo pipefail

CRON="${IMPROVER_CRON:-30 3 * * *}"
SCHEDULER="${GARRISON_SCHEDULER_CLI:-../scheduler/scripts/scheduler.mjs}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# IMPROVER_PROJECTS_DIR activates the skills two-phase loop (maintenance + the
# capped PTY model pass). Without it the runner falls back to the memory rule only.
RUN_CMD="IMPROVER_PROJECTS_DIR=\$HOME/.claude/projects node ${SELF_DIR}/improver.mjs run-now improver-nightly"

if [ -f "$SCHEDULER" ]; then
  node "$SCHEDULER" remove improver-nightly >/dev/null 2>&1 || true
  # scheduler add is positional: add <id> <cron> <command...>
  node "$SCHEDULER" add improver-nightly "$CRON" "$RUN_CMD" || {
    echo "improver: scheduler add failed (non-fatal in dev)"; true
  }
  echo "improver: registered improver-nightly @ '${CRON}'"
else
  echo "improver: scheduler CLI not found at ${SCHEDULER} (skipping registration; register manually)"
fi
