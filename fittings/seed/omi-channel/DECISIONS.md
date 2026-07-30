# Deviations from the build spec

One line per deviation, with the reason. Details in
[`docs/adr-omi-channel.md`](./docs/adr-omi-channel.md) and
[`docs/omi-api-notes.md`](./docs/omi-api-notes.md).

- Memory-trigger transcript segments use `speakerId` (camelCase), not the
  spec's `speaker_id` — verified docs win; fixtures and normalizer follow
  the docs.
- The Omi direct-notification API takes exactly two query params
  (`uid`, `message`) — no `{title, body}` JSON body as the spec implied;
  templates render to a single message string.
- No numeric rate limit is documented for direct notifications (only the
  generic 429 + backoff guidance); the spec's per-day cap is enforced
  client-side from config.
- "Route through the existing notifications fitting" — no notifications
  fitting exists in the repo (and no web push at all); delivery routes
  through the repo's two real seams instead: kanban's `CHANNEL_FITTINGS`
  registry + the web-channel thread-append contract, with a broadcast-style
  fan-out module inside this fitting.
- "Existing Garrison PWA push" concretely means a message in the
  web-channel PWA thread (the repo's mobile-reachable surface); real
  web-push/VAPID does not exist and is deliberately deferred (Capacitor
  memo, 2026-07-13).
- The "listens to system notifications" channel toggle named by the spec
  does not exist; the equivalent opt-in is the `CHANNEL_FITTINGS` map entry
  in `fittings/seed/kanban-loop/lib/notify-origin.mjs` plus this fitting's
  `notify_enabled` flag.
- The heartbeat hook registers its own scheduler job (`omi-triage`) on the
  same cron daemon that drives `kanban-tick`, instead of patching
  kanban-loop's `tick()` — kanban's own code comments prescribe exactly
  this for new consumers; zero invasive change, independently killable.
- The pinned uid lives in the fitting's state file
  (`$GARRISON_HOME/omi/state.json`), not "in config" — fittings cannot
  write composition config; the pin is visible on /health and clearable per
  the runbook.
- The Import API has NO documented dedupe and returns no created-resource
  ids; backfeed idempotency (spec I6) is entirely client-side via a
  fingerprint ledger.
- Import auth (`sk_` per-app API key) and notification auth (App Secret)
  are different credentials; the vault seals both (`OMI_IMPORT_API_KEY`,
  `OMI_APP_SECRET`).
- Day summaries cannot be manually triggered (cron-only), require the user
  to have an FCM push token and a configured timezone — HUMAN_SETUP.md must
  say so; missing days are "no recap", not failure.
- Chat-tools manifest and tool endpoints are declared with absolute URLs
  built from the `public_base_url` config (the manifest URL itself carries
  `?key=`); Omi documents no server-side auth on tool calls, so our shared
  secret in the URL is the only gate (spec I8 anticipated this).
- A fourth webhook trigger type exists (realtime audio bytes, raw PCM16);
  out of scope — the wake bus uses the transcript trigger.
- Ingress endpoints answer 403 (not 501) when the `enabled` flag is off
  once M1 lands, so a funneled-but-disabled endpoint leaks nothing about
  which routes exist; 501 remains only for not-yet-implemented milestones.
- Wake `create_event` lands as a Kanban card titled "Event: ..." rather
  than a calendar write — the fitting owns no calendar; the orchestrator
  reaches calendars through its connectors when the card runs (I4 keeps
  one task home; the single brain keeps one calendar owner).
- Wake intent handling is ONE combined classify-and-handle model call on
  the gateway's cheap blocking lane (the operative answers queries from
  its own memory/board context), not a classify-then-dispatch pair — one
  wake hit costs one model call (I3), and every failure path degrades to
  a saved note with an honest confirmation.
