---
name: Google Calendar
description: Read and write Google Calendar events via the google connector's action catalog.
---

# Google Calendar

Read + write access to the user's Google Calendar via the `google`
connector Fitting. OAuth2 is sealed in the keychain Vault — a fresh
access token is resolved per call (injected by the Automations
engine, or self-resolved through Garrison's
`/api/connectors/google/auth-env` route when `GARRISON_BASE_URL` is
set). No token file on disk, nothing plaintext in logs.

## CLI

The connector executor runs from the Fitting's installed directory:

```bash
node apm_modules/_local/google/scripts/connector.mjs --probe    # health check ("connectorOk")
node apm_modules/_local/google/scripts/connector.mjs catalog    # JSON action catalog

# List upcoming events (args: calendar_id, time_min, max)
node apm_modules/_local/google/scripts/connector.mjs call \
  calendar.list_events '{"time_min":"2026-05-08T23:00:00Z","max":25}'

# Timed event (RFC3339 with explicit offset, 2h default duration convention)
node apm_modules/_local/google/scripts/connector.mjs call \
  calendar.create_event '{"summary":"Standup","start":"2026-05-09T09:00:00+01:00","end":"2026-05-09T09:30:00+01:00","location":"Zoom","time_zone":"Europe/Lisbon"}'

# All-day event (date-only start/end, end exclusive — or all_day:true)
node apm_modules/_local/google/scripts/connector.mjs call \
  calendar.create_event '{"summary":"Prazo X","start":"2026-05-09","end":"2026-05-10"}'
```

Replies are `{ok, result}` or `{ok:false, error, awaiting_connector}`.
`awaiting_connector: true` means the Google account isn't
OAuth-connected (connect via Garrison → Fittings → Google) — report
that state honestly instead of fabricating calendar data.

## Timezone discipline

- **Pass RFC3339 timestamps with an explicit offset** (or `Z`); the
  connector does NOT parse natural language.
- "Tomorrow at 2pm" is parsed by **you, the operative** — compute the
  RFC3339 yourself and hand it over. Mind DST when computing offsets.
- `list_events` has `time_min` but **no `time_max`** — filter the tail
  client-side on `start.dateTime // start.date`.

## Conflict checking

Conflict detection is operative discipline, not connector behavior.
Before `create_event`, `list_events` over the same window and warn on
overlap. Manual workflow, not an automatic rejection.

## Context budget

- Don't pull more than 2 days of events into context at once.
- For longer ranges, summarise (count, key events) rather than
  dumping every event.

## What's NOT in the catalog (intentionally)

- Natural-language date parsing — operative-side.
- Recurring event creation — use Google Calendar's web UI.
- Event update/delete — use the web UI for now.
- Multiple Google accounts — single user identity per machine.
  (`calendar_id` selects a calendar within that one account;
  defaults to primary.)
