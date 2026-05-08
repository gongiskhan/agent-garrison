---
name: Google Calendar
description: Read and write Google Calendar events via OAuth-backed CLI.
---

# Google Calendar

Read + write access to the user's primary Google Calendar via this
Fitting's Python CLI. OAuth credentials live in the Garrison vault
(`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`); the
per-user refresh token lives at
`~/.garrison/google-calendar/token.json` (mode 0600). The runner
injects the vault values at composition startup; the CLI reads them
from `process.env` directly.

## CLI

The `calendar.py` CLI is the cheapest way to interact. It runs from
the Fitting's installed directory
(`apm_modules/_local/google-calendar/`) inside its own uv-managed
venv:

```bash
uv run --directory apm_modules/_local/google-calendar \
  python scripts/calendar.py --probe                  # health check
uv run … calendar.py list today                       # JSON event array
uv run … calendar.py list tomorrow
uv run … calendar.py list this-week
uv run … calendar.py list 2026-05-08..2026-05-12      # explicit range

uv run … calendar.py create \
  --title "Standup" \
  --start 2026-05-09T09:00:00Z \
  --end   2026-05-09T09:30:00Z \
  --location "Zoom"

uv run … calendar.py update <event-id> --title "Standup (extended)" --end 2026-05-09T09:45:00Z
uv run … calendar.py delete <event-id>

uv run … calendar.py sync                             # writes data/calendar.md
```

All commands fail loudly (non-zero exit, stderr message) if the
token is missing/expired/unrefreshable.

## Timezone discipline

- **Always pass UTC ISO timestamps to the CLI** (the trailing `Z`
  form). The CLI does NOT parse natural language.
- The CLI renders local-zone times to the user (zone resolved via
  `tzlocal`).
- "Tomorrow at 2pm" is parsed by **you, the operative**, not by the
  CLI. Compute the UTC ISO yourself and hand it over.

## Conflict checking

Conflict detection is operative discipline, not CLI behavior. When
about to `create`, first `list` the same time range and warn the
user if there's an overlap. This is a manual workflow, not an
automatic rejection.

## Sync vs ad-hoc

- The Fitting registers a `calendar-sync` scheduler job (every 5
  minutes) when the scheduler Fitting is present. That job
  overwrites `<composition-dir>/data/calendar.md` with today +
  tomorrow + the next 5 days.
- Read `data/calendar.md` for daily-briefing context — it's cheap
  and always fresh.
- Use `list` for ad-hoc queries (different ranges, latest state).

## Context budget

- Don't pull more than 2 days of events into context at once.
- For longer ranges, summarise (count, key events) rather than
  dumping every event.

## What's NOT in this CLI (intentionally)

- Natural-language date parsing — operative-side.
- Recurring event creation — use Google Calendar's web UI.
- All-day event creation — use the web UI; `update` handles them.
- Multiple calendars — primary only for v1.
- Multiple Google accounts — single user identity per machine.
