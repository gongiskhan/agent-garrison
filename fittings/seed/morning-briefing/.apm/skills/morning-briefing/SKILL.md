---
name: Morning Briefing
description: Daily synthetic prompt that asks the Operative to compose a Trello + Calendar briefing and post it to Slack.
---

# Morning Briefing

Once a day (default 08:00 weekdays, configurable) the scheduler
fires a synthetic prompt at the gateway. The gateway formats it as
`Heartbeat job: morning-briefing\n\nPayload:\n{...}` and routes it
to the Operative the same way `/jobs` heartbeat ticks are routed.

## What the Operative does on receipt

1. Treat the prompt like any other inbound message — same tier
   classifier, same orchestrator routing.
2. Read today's calendar (the `data/calendar.md` mirror kept fresh
   by the `google-calendar` Fitting's sync, or the calendar.py CLI
   for ad-hoc lookups). Skip if the Calendar Fitting isn't
   selected.
3. Read open Trello tasks (the trello data source's "A Fazer"
   list). Skip if the Trello Fitting isn't selected.
4. Compose a Slack message — events first (chronological), then up
   to two task suggestions with one-sentence reasons each. Skip
   any section whose data source is empty. Skip a "blocking"
   section unless a real blocker exists (no fabrication).
5. Post via `mcp__claude_ai_Slack__slack_send_message` to the
   orchestrator's `report_channel`. **If `report_channel` is empty,
   log to stdout and stop — don't search Slack for a channel.**
6. If both calendar and tasks are empty, post a one-line
   acknowledgement ("Quiet day.") rather than staying silent —
   briefings have a fixed cadence and the principal expects
   proof-of-life.

## Hard rules

- Under 200 words. No filler ("Good morning!", "Have a great day!").
- Informational only. Do not offer to do work autonomously here. If
  the principal wants to act, they reply in Slack and the existing
  heartbeat approval flow (Phase 2 T4) takes it from there.
- Don't post anywhere except the configured Slack target.

## Configuration knobs

- `GARRISON_BRIEFING_TIME` (default `08:00`) — local fire time.
- `GARRISON_BRIEFING_WEEKDAYS_ONLY` (default `true`) — Mon–Fri.
- Re-running setup with new env values replaces the cron entry by
  id (`morning-briefing`). No need to remove the old job manually.

## Manual trigger

```
node apm_modules/_local/scheduler/scripts/scheduler.mjs run-now morning-briefing
```

Useful for empty-state tests and same-day re-fires.
