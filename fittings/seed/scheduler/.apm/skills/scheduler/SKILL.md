---
name: Scheduler
description: Cron-style job scheduler. Add, remove, list, and run jobs against a JSON-backed registry.
---

# Scheduler

Time-anchored work — calendar sync, reminders, end-of-day rollups.
For loop-style "every N minutes" polling with no calendar
component, use the **Heartbeat** Faculty instead.

## Setup

Resolved by the runner from Fitting config:

```
GARRISON_SCHEDULER_JOBS=...   # default: data/scheduler-jobs.json
GARRISON_SCHEDULER_LOG=...    # default: data/scheduler.log
```

Both paths are relative to the composition directory.

## CLI

The `scheduler.mjs` CLI runs from the Fitting's installed
directory (`apm_modules/_local/scheduler/`).

```bash
node scripts/scheduler.mjs --probe                    # health check
node scripts/scheduler.mjs list                       # JSON list of jobs
node scripts/scheduler.mjs add <id> <cron> <command>  # add or replace
node scripts/scheduler.mjs remove <id>                # remove a job
node scripts/scheduler.mjs run-now <id>               # run once now
node scripts/scheduler.mjs tick                       # process current-minute due jobs
node scripts/scheduler.mjs daemon                     # tick every minute until killed
```

## Cron grammar

5 fields: `minute hour day-of-month month day-of-week`. Supported:

- `*` — any value
- `*/N` — every N units (modulo arithmetic from field min)
- `M` — single value
- `M,N,...` — comma-separated list
- `A-B` — inclusive range

No `@yearly`/`@daily` aliases, no seconds, no named months/days.
That covers Phase 2's intended patterns:

- `*/5 * * * *` — every 5 minutes (calendar sync)
- `0 8 * * 1-5` — 8am weekdays (morning briefing)
- `0 18 * * *` — 6pm daily (end-of-day rollup)

## Tick semantics

A tick runs at most once per minute per job. Each job records
`last_run_minute` (e.g. `2026-5-7T8:0`) so a second tick within
the same minute is a no-op for that job. Cron matching is against
the local time of the tick, not UTC.

## Operating principles

- **Time-anchored vs loop-driven.** Use Scheduler for "at H:M
  every weekday." Use Heartbeat for "every 40 minutes,
  regardless of clock." A heartbeat tick can call
  `scheduler.mjs tick` to drive due jobs as a side effect.
- **Job idempotency is the consumer's responsibility.** The
  scheduler doesn't dedupe across daemon restarts; if a job
  must not fire twice, the job's command must check its own
  state.
- **Log file grows unbounded.** Rotate it externally if
  retention matters. v1 doesn't ship rotation.

## Persistence

`jobs.json` is a flat array of objects:

```json
[
  {
    "id": "morning-briefing",
    "cron": "0 8 * * 1-5",
    "command": "curl -X POST http://127.0.0.1:4777/jobs -d ...",
    "enabled": true,
    "last_run": "2026-05-07T07:00:00.000Z",
    "last_run_minute": "2026-5-7T8:0"
  }
]
```

Survives Garrison restart — the scheduler reads jobs.json on
every tick. `last_run_minute` is written before the job is
spawned, so a crash mid-run doesn't double-fire on restart.

## Cookbook: morning briefing

A daily 8am-weekdays briefing combining Trello tasks + Calendar
events, posted to Slack:

```bash
# Run from the composition directory.
node apm_modules/_local/scheduler/scripts/scheduler.mjs add \
  morning-briefing \
  "0 8 * * 1-5" \
  "curl -fsS -X POST http://127.0.0.1:4777/jobs -H 'content-type: application/json' -d '{\"kind\":\"morning-briefing\",\"instructions\":\"Compose my morning briefing. Combine my open Trello tasks (A Fazer list) with today calendar events. Post via mcp__claude_ai_Slack__slack_send_message to the orchestrator report_channel — if report_channel is empty, log to stdout and stop, don\\u2019t search Slack. Format: events in chronological order, two task suggestions with reasons, anything blocking. If both inputs are empty, post a one-line acknowledgement instead of staying silent — briefings have a fixed cadence and the principal expects proof-of-life at 8am.\"}'"
```

The Operative's prompt rules know to handle a `Heartbeat job:`
prefix; the briefing payload is just a flavoured tick. If you
want the briefing to fire more often or on weekends, change the
cron expression. Remove with `scheduler.mjs remove
morning-briefing`.

This is intentionally a recipe, not a separate Fitting — the
morning-briefing is one cron expression + one prompt payload,
and the Faculty model doesn't have a "scheduled-prompt recipe"
slot in v1.

## How the daemon mode is wired

In Phase 2, the runner does not auto-spawn the scheduler daemon.
Three integration paths the consumer can pick from:

1. **Manual:** `node apm_modules/_local/scheduler/scripts/scheduler.mjs daemon`
   in a tmux pane or under `launchctl asuser`.
2. **Heartbeat-driven:** Phase 2's heartbeat (T4) can run
   `tick` once per heartbeat as part of its periodic work.
   Coarser cadence (40 min vs 1 min) but no separate process.
3. **Host cron:** `* * * * * cd <composition> && node apm_modules/_local/scheduler/scripts/scheduler.mjs tick`
   in `crontab`.

A future runtime-SDK milestone may add an explicit
`x-garrison.daemon` declaration so the runner spawns the
scheduler daemon at Up time.
