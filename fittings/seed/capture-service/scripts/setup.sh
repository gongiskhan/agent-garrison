#!/usr/bin/env bash
# Setup hook - side-effect-causing prep only; verify stays read-only.
# The fitting's only dependency (ws) is a repo-root dependency resolved by
# Node's upward walk (kanban-loop / web-channel precedent), so there is
# nothing to install.
#
# The one standing side effect is the nightly Zeca review (D60): the scheduler
# job that reads the standing Zeca conversation, hands it to the operative
# (memories, learnings), files the review and rotates the conversation. cwd is
# the fitting's installed dir per the runner contract.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"            # .../capture-service/scripts
FITTING_DIR="$(cd "$SELF_DIR/.." && pwd)"            # .../capture-service
SCHEDULER="${GARRISON_SCHEDULER_CLI:-$FITTING_DIR/../scheduler/scripts/scheduler.mjs}"

if [ ! -f "$SCHEDULER" ]; then
  echo "[capture-service] setup: scheduler CLI not found at $SCHEDULER; the nightly Zeca review is not registered" >&2
  exit 0
fi

# The scheduler daemon's environment carries neither this instance's app nor
# its gateway, so both are baked into the job command (drill's Results MCP
# registration precedent). Missing here = the job says so at 03:05 and exits
# 75 without touching the conversation.
JOB_CMD="GARRISON_HOME='${GARRISON_HOME:-$HOME/.garrison}'"
if [ -n "${GARRISON_APP_URL:-}" ]; then JOB_CMD="$JOB_CMD GARRISON_APP_URL='$GARRISON_APP_URL'"; fi
if [ -n "${GARRISON_GATEWAY_URL:-}" ]; then JOB_CMD="$JOB_CMD GARRISON_GATEWAY_URL='$GARRISON_GATEWAY_URL'"; fi
JOB_CMD="$JOB_CMD node '$FITTING_DIR/scripts/zeca-nightly.mjs'"

# Before the improver's 03:30 sweep, which lists the review files.
CRON="${CAPTURE_SERVICE_ZECA_REVIEW_CRON:-5 3 * * *}"

# register, not add: preserves the user's enable/disable choice on re-register.
node "$SCHEDULER" register zeca-nightly-review "$CRON" -- "$JOB_CMD"
echo "[capture-service] setup: registered zeca-nightly-review @ '$CRON'"
