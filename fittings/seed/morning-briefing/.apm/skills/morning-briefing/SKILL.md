---
name: Morning Briefing
description: Daily synthetic prompt that asks the session to compose a Trello + Calendar briefing and post it to Slack.
---

# Morning Briefing

Once a day (default 08:00 weekdays, configurable) the scheduler
fires a synthetic prompt at the gateway. The gateway formats it as
`Heartbeat job: morning-briefing\n\nPayload:\n{...}` and routes it
to the session the same way `/jobs` heartbeat ticks are routed.

## What the session does on receipt

**First: `cd` to the composition dir.** The prompt carries it as an
absolute path. Your session does NOT start there, so every relative
`apm_modules/_local/.../connector.mjs` below — the data sources *and*
the WhatsApp send — fails with `MODULE_NOT_FOUND` without it, and the
briefing quietly loses that source instead of erroring.

1. Treat the prompt like any other inbound message — same tier
   classifier, same orchestrator routing.
2. **The data is already in the prompt.** `briefing.py` fetches the
   calendar and the tasks before the job is posted, because the
   operative has NO connector credentials — those are injected only
   into the Automations engine, so a connector call from your Bash
   returns `awaiting_connector` however well the user is connected.
   Do not run a connector here. If the prompt marks a source
   UNAVAILABLE, say so in one clause and move on; never invent it,
   and never treat it as something to go and fix.
4. Compose a Slack message — events first (chronological), then up
   to two task suggestions with one-sentence reasons each. Skip
   any section whose data source is empty. Skip a "blocking"
   section unless a real blocker exists (no fabrication).
5. Deliver it to wherever the `delivery` config points. The prompt
   carries the destination, so follow what it says rather than
   assuming Slack:
   - `slack` — post via `mcp__claude_ai_Slack__slack_send_message`
     to the orchestrator's `report_channel`. **If `report_channel`
     is empty, log to stdout and stop — don't search Slack for a
     channel.**
   - `whatsapp` — call the whatsapp-web connector's `send_text`
     with the exact JID the prompt names. It returns
     `{queued:true, executeAt}`: the message is parked for a
     60-second cancel window and then goes out by itself. That is
     success, not a failure — don't call it twice.
   - `stdout` — print the briefing and stop (dry run).
6. If both calendar and tasks are empty, post a one-line
   acknowledgement ("Quiet day.") rather than staying silent —
   briefings have a fixed cadence and the principal expects
   proof-of-life.

## Hard rules

- Under 200 words. No filler ("Good morning!", "Have a great day!").
- Informational only. Do not offer to do work autonomously here. If
  the principal wants to act, they reply in Slack and the existing
  heartbeat approval flow (Phase 2 T4) takes it from there.
- Don't deliver anywhere except the target the prompt names.

## Configuration knobs

- `GARRISON_BRIEFING_TIME` (default `08:00`) — local fire time.
- `GARRISON_BRIEFING_WEEKDAYS_ONLY` (default `true`) — Mon–Fri.
- `GARRISON_BRIEFING_DELIVERY` (default `slack`) — `slack`,
  `whatsapp` or `stdout`.
- `GARRISON_BRIEFING_WHATSAPP_JID` — exact JID for `whatsapp`
  delivery. Required in that mode; setup refuses to register the job
  without it rather than letting a silent morning reveal it.
- Re-running setup with new env values replaces the cron entry by
  id (`morning-briefing`). No need to remove the old job manually.

## Manual trigger

```
node apm_modules/_local/scheduler/scripts/scheduler.mjs run-now morning-briefing
```

Useful for empty-state tests and same-day re-fires.
