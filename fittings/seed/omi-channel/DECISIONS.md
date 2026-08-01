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
- Backfeed runs on an in-process 30-minute interval instead of a
  scheduler job: its sources (the board, triaged events) share this
  fitting's lifecycle, so an independent cron would only ever fire into a
  dead board; `scripts/backfeed.mjs --run` remains the manual trigger.
- `scripts/funnel-ensure.mjs` is human-invoked, not hooked into
  prod:redeploy (which the recon suggested): opening public internet
  ingress is a deliberate act, and the endpoints are inert 403s until
  the flags and secrets exist anyway.
- **I5 widened, deliberately and on the user's instruction (2026-07-31).**
  The wake bus now hands the classifier a bounded window of segments from
  BEFORE the wake word, not just the speech after it. Omi fragments a
  single utterance across segments and mis-attributes speakers, so the
  subject of a command routinely lands in a segment the gate had already
  dropped — "Gary, create a task saying" classified as unknown because
  the thing to be said arrived separately. I5's persistence guarantee is
  intact: the pre-wake ring is in memory only, is never logged, and dies
  with a session that never wakes. What changed is that on a hit, speech
  the user did not address to Gary can now reach the orchestrator and be
  quoted in a card. Bounded by count (`wake_context_segments`, 6) and by
  age (`wake_context_max_age_ms`, 120s) so a hit can never pull in
  unrelated conversation; set the count to 0 to restore the old behaviour.
- Capture is held open for `wake_min_capture_ms` (15s in the default
  composition) after a wake hit, through silence, with
  `wake_max_capture_ms` (20s) as the hard ceiling — closing on the first
  quiet moment truncated commands mid-sentence, because Omi's transcript
  arrives in bursts with real gaps inside one utterance. Costs ~15s of
  latency per spoken command on top of the orchestrator turn.
- **Spoken card commands + spoken scheduling (2026-08-01).** The wake
  classifier gains a `card_command` intent ("run card 7Q2M", "snooze card
  7Q2M for two hours") and `create_task` gains an optional
  `scheduled_for`/`schedule_action` pair - both ride the SAME single
  classify-and-handle call (I3 intact, no second inference). The prompt
  previously carried no clock, so it now states the current local time,
  weekday and timezone; the model resolves relative times against it and
  answers absolute ISO. All model-emitted times and numbers are validated
  fitting-side: a bad `scheduled_for` DROPS the schedule and says so in the
  confirmation rather than failing the card; a bad snooze time refuses to
  act rather than snoozing to a default. Card resolution goes through the
  board's `GET /cards/resolve`; a 409 is read back as up to 3 candidates
  with their 4-char refs and never guessed among. Card-command failures
  answer with an honest notification, NOT the note fallback - a saved note
  cannot start or snooze a card, so pretending it helped would be dishonest.
  A reminder spoken WITH a time is now `create_task` + `scheduled_for`, no
  longer `create_event` (events stay meetings/appointments); the board owns
  the notify/run follow-through. Not done here: the shared test shim
  `tests/omi-channel-mjs.d.ts` was outside this change's allowed scope, so
  the new wake exports (`shortRef`, `humanTime`, extended parse fields) are
  bridged with casts in `tests/omi-wake-card-commands.test.ts` - extending
  the shim is a small follow-up.
