# Morning Briefing Fitting — Setup Guide

This Fitting fires a daily synthetic prompt that asks the Operative
to compose a briefing (Trello + Calendar) and post it to Slack via
the orchestrator's `report_channel`. It's opt-in.

## 1. Prerequisites

- The `scheduler` Fitting must be in your composition (required —
  this Fitting is just a job registration).
- A destination Fitting for whichever `delivery` you choose:
  `slack-channel` for `delivery: slack`, or `whatsapp-web` for
  `delivery: whatsapp`. Neither is required by the manifest any
  more — `delivery: stdout` needs no channel at all — so nothing
  stops you composing one without the other.
- Optionally: `trello-data-source` and/or `google-calendar`. If
  both are absent, the briefing posts a one-line "quiet day"
  acknowledgement; if only one is absent, the briefing skips that
  section.
- The `personal-operative` orchestrator's `report_channel` config
  must be set to the Slack channel ID you want briefings posted to.
  If it's empty, the Operative logs to stdout instead of posting.

## 2. Opt the Fitting in to your composition

Edit your composition's `apm.yml` and add `morning-briefing` to the
`automations` selection block:

```yaml
selections:
  automations:
    - id: morning-briefing
      config:
        briefing_time: "08:00"
        weekdays_only: true
        delivery: slack
```

To receive it on WhatsApp instead, point `delivery` at the
whatsapp-web connector and give it an exact JID (your own number
delivers the briefing into "Message yourself"):

```yaml
        delivery: whatsapp
        whatsapp_jid: "351900000000@s.whatsapp.net"
```

The JID is never guessed: `send_text` rejects anything that is not
already an exact JID, and setup refuses to register the job when
`delivery: whatsapp` has no `whatsapp_jid`. Note that a briefing is
an agent-triggered send, so it is parked in the daemon's outbox for
a 60-second cancel window before it actually goes out.

## 3. Override time / weekdays at runtime (optional)

The Fitting's setup script reads two env vars (with defaults that
match the config_schema). Set them before `garrison up` if you want
something other than the defaults:

```bash
export GARRISON_BRIEFING_TIME="07:30"
export GARRISON_BRIEFING_WEEKDAYS_ONLY="false"
garrison up
```

Re-running `up` with new values replaces the existing scheduler
job by id — no manual cleanup needed.

## 4. First run

```bash
garrison up
```

Setup registers a `morning-briefing` job with the scheduler. You
can verify with:

```bash
node apm_modules/_local/scheduler/scripts/scheduler.mjs list
# expect a job with id "morning-briefing"
```

## 5. Manual trigger (for testing)

```bash
node apm_modules/_local/scheduler/scripts/scheduler.mjs run-now morning-briefing
```

The Operative should reach Slack within a few seconds. If
`report_channel` is empty you'll see the briefing logged to the
gateway's stdout instead.

## 6. Removing

Either remove `morning-briefing` from the composition's
`selections.automations` and re-run `up`, or remove the job
directly:

```bash
node apm_modules/_local/scheduler/scripts/scheduler.mjs remove morning-briefing
```
