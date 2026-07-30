#!/usr/bin/env bash
# Register the Improver nightly with the scheduler, disabled by default.
set -euo pipefail

fitting_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
composition_dir="$(cd "$fitting_dir/../../.." && pwd)"
root_dir="$(cd "$composition_dir/../.." && pwd)"
scheduler_script="$composition_dir/apm_modules/_local/scheduler/scripts/scheduler.mjs"
improver_script="$fitting_dir/scripts/improver.mjs"
# Scheduler state is machine-global (~/.garrison per instance), NOT
# composition-relative: scheduler.mjs and the launcher both resolve it from
# GARRISON_HOME. The old composition-relative fallback wrote to
# <composition>/data/scheduler-jobs.json, which no daemon ever reads — and all
# three profiles share COMPOSITIONS_DIR, so it was one file for three instances.
# Passing nothing lets scheduler.mjs apply its own GARRISON_HOME-derived default.
jobs_file="${GARRISON_SCHEDULER_JOBS:-}"
log_file="${GARRISON_SCHEDULER_LOG:-}"
# The composition's config arrives as <FITTING_ID>_<KEY> (setupConfigEnv in
# src/lib/runner.ts); GARRISON_IMPROVER_CRON alone never carried it, so a
# configured schedule_cron was silently ignored.
cron="${GARRISON_IMPROVER_CRON:-${IMPROVER_NIGHTLY_SCHEDULE_CRON:-17 3 * * *}}"

if [ ! -f "$scheduler_script" ]; then
  echo "scheduler not installed; improver-nightly job not registered"
  exit 0
fi

quote() {
  printf "%q" "$1"
}

job_command="GARRISON_ROOT_DIR=$(quote "$root_dir") GARRISON_COMPOSITION_DIR=$(quote "$composition_dir") node $(quote "$improver_script") run"

# Job id is NOT `improver-nightly`: the pre-existing `improver` Fitting already
# registers a scheduler job under exactly that id (its dream/skills nightly, via
# `remove` + `add`). With both Fittings in one composition the two setup hooks
# clobbered each other every `up` — whichever ran last owned the id, the other
# nightly silently vanished, and because `add` hardcodes enabled:true it also
# defeated the `--disabled` below. Distinct ids let both coexist.
JOB_ID="improver-nightly-proposals"

# Only override the scheduler's own GARRISON_HOME-derived defaults when a value
# is actually present — an empty assignment would win over `??` in scheduler.mjs
# and point JOBS_FILE at "". Empty-array expansion is guarded for bash < 4.4.
sched_env=()
[ -n "$jobs_file" ] && sched_env+=("GARRISON_SCHEDULER_JOBS=$jobs_file")
[ -n "$log_file" ] && sched_env+=("GARRISON_SCHEDULER_LOG=$log_file")
sched() { env ${sched_env[@]+"${sched_env[@]}"} node "$scheduler_script" "$@"; }

# Retire the old colliding id, but ONLY when the job under it is ours. A previous
# install of this fitting left `improver-nightly` behind; the `improver` Fitting
# may equally be holding it, and deleting that would silently kill its nightly.
# Matched on that job's own command, not on a grep of the whole list — which
# would false-positive on the job registered below.
if sched list 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let jobs = [];
    try { jobs = JSON.parse(raw).jobs ?? []; } catch { process.exit(1); }
    const job = jobs.find((j) => j?.id === "improver-nightly");
    process.exit(job && /improver-nightly\/scripts\/improver\.mjs/.test(String(job.command)) ? 0 : 1);
  });
'; then
  sched remove improver-nightly >/dev/null 2>&1 || true
fi

sched register "$JOB_ID" "$cron" \
  --disabled \
  --description "Generate a review-only Garrison Improver proposal artifact" \
  -- "$job_command"
