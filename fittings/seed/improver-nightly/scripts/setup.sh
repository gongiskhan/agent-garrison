#!/usr/bin/env bash
# Register the Improver nightly with the scheduler, disabled by default.
set -euo pipefail

fitting_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
composition_dir="$(cd "$fitting_dir/../../.." && pwd)"
root_dir="$(cd "$composition_dir/../.." && pwd)"
scheduler_script="$composition_dir/apm_modules/_local/scheduler/scripts/scheduler.mjs"
improver_script="$fitting_dir/scripts/improver.mjs"
jobs_file="${GARRISON_SCHEDULER_JOBS:-$composition_dir/data/scheduler-jobs.json}"
log_file="${GARRISON_SCHEDULER_LOG:-$composition_dir/data/scheduler.log}"
cron="${GARRISON_IMPROVER_CRON:-17 3 * * *}"

if [ ! -f "$scheduler_script" ]; then
  echo "scheduler not installed; improver-nightly job not registered"
  exit 0
fi

quote() {
  printf "%q" "$1"
}

job_command="GARRISON_ROOT_DIR=$(quote "$root_dir") GARRISON_COMPOSITION_DIR=$(quote "$composition_dir") node $(quote "$improver_script") run"

GARRISON_SCHEDULER_JOBS="$jobs_file" \
GARRISON_SCHEDULER_LOG="$log_file" \
  node "$scheduler_script" register improver-nightly "$cron" \
    --disabled \
    --description "Generate a review-only Garrison Improver proposal artifact" \
    -- "$job_command"
