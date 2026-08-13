# Omi channel — build progress

Milestones per the implementation spec (M0-M7). A milestone is done only
with green tests and an entry here.

## M0 — Recon and scaffolding (2026-07-30)

Shipped:
- Recon of all six required subsystems (channels contract, notifications,
  kanban heartbeat, orchestrator interface, config/secrets, scheduling)
  plus public-ingress options and memory/metrics conventions; placement
  decisions recorded in `docs/adr-omi-channel.md`.
- All five external doc surfaces fetched and verified; shapes recorded in
  `docs/omi-api-notes.md` (two spec refutations found: `speakerId`
  camelCase; notification API is uid+message query params).
- Fitting scaffold: `apm.yml` (faculty channels, own_port 7094, provides
  channel/omi, vault secret_scope, every pipe a default-off boolean flag),
  `lib/config.mjs` (env-only config, no port literals), `scripts/start.mjs`
  + `scripts/server.mjs` (status file, /health, status page, `/omi/*`
  ingress routes answering 501), `scripts/omi.mjs --probe` verify hook,
  non-blocking `scripts/setup.sh`.
- Registered in `data/library.json` and stationed in the default
  composition's channels selection (config all-off).

Deviations: see `DECISIONS.md` (notifications-fitting absence, scheduler
job instead of kanban tick patch, uid pin location, speakerId, uid+message
notification params).

Next: M1 — ingress auth (?key= + uid pinning), async enqueue + capture_event
normalization with dedupe, fixtures from the verified shapes, replay
harness.

## M1 — Ingress and normalization (2026-07-30)

Shipped:
- Auth on every `/omi/*` route: `?key=` shared secret compared via
  fixed-length digest `timingSafeEqual`, uid pinned on first authenticated
  call (`state.json`), foreign uid and wrong key rejected AND counted;
  master `enabled` flag off = 403 on everything (I8/I9).
- Fast-ack ingress (I7): raw payload enqueued to `raw-queue/` in one small
  file write, 200 returned, normalization on a serialized drain chain;
  leftover queue drained on boot (crash recovery).
- `lib/normalize.mjs`: conversation + day-summary -> source-agnostic
  `capture_event` (I2), `summary_json` only, transcript flattened to
  "Speaker: text" prose; `lib/store.mjs`: file-per-event store, dep-free
  ulid, atomic writes, per-writer counters.
- Two-layer dedupe (I6): raw-body fingerprint (covers malformed payloads
  too) + semantic key (omi conversation id / day date); replaying the whole
  fixture set twice is byte-identical inbox state, asserted in tests.
- Realtime pipe: counted, parsed in memory, NEVER persisted or logged with
  content (I5); wake gate lands in M4.
- Fixtures (duplicates, content drift on the same conversation id,
  discarded, PT-only, mixed PT/EN multi-speaker, day summary, malformed
  JSON, realtime segments) + `scripts/replay.mjs` harness (`--twice`).
- Tests: `tests/omi-channel-ingress.test.ts` (10) covering all M1
  acceptance criteria; M0 test updated (disabled ingress = 403, not 501).

Deviations: none new (403-when-disabled was already recorded in
DECISIONS.md).

Next: M2 — heartbeat triage: omi-triage scheduler job, rule filters, ONE
batched gateway model call per non-empty tick, card/memory/tip candidates,
board dedupe by origin_id, zero-model-call empty tick asserted.

## M2 — Heartbeat triage (2026-07-30)

Shipped:
- `lib/triage.mjs`: per tick — rule filters first with zero model cost
  (discarded, blocked folders, category scope; no-open-action conversations
  keep the memory path but are barred from the card path), then ONE batched
  model call over the capped batch (overflow carries), then candidates fan
  out. Empty inbox = zero model calls AND zero board contact, asserted.
- Card creation through the board API (I4): `origin: omi`,
  `origin_id: omi:<conversation>:<action-index>` as the dedupe key
  (pre-checked via GET /cards?origin_id= because the board has no dedupe),
  backlog placement, project label validated against GET /projects (never
  fabricated), body = our text + ONE marked `Source (Omi): "..."` line +
  provenance line (I1).
- Memories via the basic-memory vault-file pattern (`lib/memory-writer.mjs`):
  frontmatter + provenance bullets + secret redaction + `omi-` filename
  prefix (never `session-*`); vault absence = skipped-with-reason.
- Tips: queued to `tips-queue/` under a per-day ledger cap (delivery is M3).
- Failure discipline: transport errors leave events pending with no attempt
  burned; unparseable replies consume attempts and park the batch as failed
  after 5.
- `scripts/triage.mjs --tick` CLI + `lib/scheduler-jobs.mjs`: idempotent
  `register` of the `omi-triage` job on server boot (kanban registerTick
  pattern: instance env baked into the command, no gateway = no
  registration), removal when the flag turns off.
- Tests: `tests/omi-channel-triage.test.ts` (11) — golden batch, zero-dupe
  re-run, I3 empty-tick assertion, batch cap/overflow, transport vs parse
  failure, tips cap, rule filter units, prompt caps.

Deviations: none new (own scheduler job already recorded).

Next: M3 — outbound notifications: Omi direct-notification client
(uid+message query params, 401/429 handling, per-day cap), notify module
with web-channel-thread fallback, CHANNEL_FITTINGS registration, thread
contract on the omi server, templates card_created / wake_confirmation /
tip, tips-queue drain.

## M3 — Outbound notifications (2026-07-30)

Shipped:
- `lib/omi-api.mjs`: direct-notification client per the verified shape
  (uid+message QUERY params, Bearer app secret, no body); 401 = loud
  no-retry credential failure, 404 = no-retry, 429/5xx = up to 3 attempts
  with 1s/2s exponential backoff (injectable sleep).
- `lib/notify.mjs` (Notifier): templates `card_created`,
  `wake_confirmation`, `tip`, `relay` — each renders to ONE plain-text
  message + at most one bare deep link, no action buttons. Primary means
  omi-push to the pinned uid under a per-day ledger cap; degrade path (I9)
  = web-channel PWA thread `omi-reports`. Honest per-means receipts with
  skip REASONS; deep links tailnet-paired via a fitting-local copy of the
  web-channel tailnet-serve helper.
- Thread-append contract on the omi server (`POST /api/threads`,
  `POST /api/threads/:id/messages`, NOT under the public /omi/ mount):
  messages stored ring-capped and relayed to the wearer through the
  degrade chain.
- Kanban registration (minimal, inert without omi cards): `omi` added to
  ORIGIN_TRANSPORTS + `omi: "omi-channel"` in CHANNEL_FITTINGS;
  deliverWebMessage generalized to deliverChannelMessage keyed by the
  card's transport (web behavior byte-identical — pinning tests green).
- Triage cards now stamp `originChannel {channel: omi, threadId:
  omi-reports}` so lifecycle events flow back to the wearer, and send a
  `card_created` confirmation; the triage CLI drains the tips queue
  attempt-once with receipts recorded to `tips-sent/`.
- Tests: `tests/omi-channel-notify.test.ts` (13) — mocked-API retry
  matrix, toggle-off fallback routing, cap enforcement, drain, and a live
  round-trip proving kanban's omi transport hits this fitting's
  thread-append route.

Deviations: none new (notifications-fitting absence + web-channel-as-PWA
fallback were recorded in M0).

Next: M4 — wake bus: word-boundary variant gate over realtime segments
(in-memory only), wake_session capture windows, intent parse + dispatch
(create_task via board, note via memory, query via bounded turn),
wake_confirmation via M3, kill switch mid-session,
wake_hit_to_notification_ms metric.

## M4 — Wake bus (2026-07-30)

Shipped:
- `lib/wake.mjs` (WakeBus): unicode-aware word-boundary regex over the
  configured variants (letter/number lookarounds, since \b fails on
  accented variants like "zéca") - matches "Zeca,"/"ZECA?"/"zéca", never
  "zecar"/"azeca", asserted. (Shipped under the operative's former name;
  the spellings here are the current ones - see M8.)
- In-memory wake_session per session_id: capture opens on a hit with the
  post-token remainder, extends per segment, closes on
  `wake_silence_close_ms` of silence or the `wake_max_capture_ms` hard
  cap; segment-identity dedupe (start|end|text) means Omi redelivery can
  never double-dispatch; idle sessions GC'd. Non-hits: counters only,
  never persisted, never logged with content (I5). The ONLY persistence
  is the assembled command text as a `wake_command` capture_event with a
  wake-results ref.
- Dispatch: ONE combined classify-and-handle model call on the cheap
  gateway lane (the operative answers queries from its own memory/board
  context), then deterministic fitting-side actions: create_task /
  create_event -> board card (origin_id omi:wake:<event>, originChannel
  omi, marked source line); note -> vault memory with provenance; query ->
  answer in the confirmation; unknown or any failure (gateway down,
  unparseable reply, board down) -> note saved + an HONEST confirmation
  saying so.
- Kill switch honored mid-session: flag off between hit and close =
  nothing dispatches, nothing persists (counter only).
- `wake_hit_to_notification_ms` observed per dispatch
  (last/sum/count in the counters file, on /health).
- Wired: realtime ingress hands segments to the bus only when
  `wake_enabled`; server constructs the bus with real deps.
- Tests: `tests/omi-channel-wake.test.ts` (11) covering every M4
  acceptance criterion.

Deviations: create_event lands as a Kanban card titled "Event: ..." (no
calendar write from the fitting; the orchestrator owns calendars via its
connectors when the card runs) — added to DECISIONS.md.

Next: M5 — ask_zeca chat tool: manifest endpoint (absolute URLs from
public_base_url + ?key=), handler auth (app id + uid), bounded fast path
(<10s wall, AbortController, friendly partial answer on overrun).

## M5 — Chat tool ask_zeca (2026-07-30)

Shipped:
- `lib/chat.mjs`: manifest per the verified ChatTools format (one tool,
  `{query}` param, POST, `auth_required: false` since the wearer IS the
  single pinned user; description written to capture any question about
  the user's tasks/projects/schedule/memories/reasoning). Endpoint is
  absolute from `public_base_url` with the URL shared secret baked in
  (Omi sends no credential on tool calls - I8), relative fallback for
  App-Home-URL resolution; the manifest route itself requires the key.
- Handler auth: chat flag + key + app_id vs sealed OMI_APP_ID + uid
  pinned/validated from the BODY (tool calls carry uid in the payload).
  Rejections counted per reason, error text user-facing.
- Bounded fast path: cheap-lane blocking turn (the operative answers from
  its memories/board context), Promise.race deadline at 8.5s with the
  fetch itself aborting at 9.5s; overruns and gateway failures return a
  friendly partial answer as HTTP 200 (never an Omi-side timeout);
  offline gateway says so; `chat_answer_ms` observed.
- Server routes wired: `POST /omi/chat`, `GET /omi/tools-manifest`; the
  501 scaffolding is gone (every /omi route is now real).
- Tests: `tests/omi-channel-chat.test.ts` (10) - manifest validation,
  budget adherence, overrun partial answer, throw degrade, full auth
  matrix, disabled-by-default, live server round-trip.

Deviations: none new.

Next: M6 — backfeed: Import API client (memories into Omi), fingerprint
ledger dedupe, sources completed_cards/decisions/daily_digest, flag off.

## M6 — Backfeed (2026-07-30)

Shipped:
- `OmiApi.createMemories`: Import API per the verified shape
  (`/v2/integrations/{app_id}/user/memories?uid=`, Bearer `sk_` Import key
  — a DIFFERENT credential from the App Secret; structured memories with
  tags, `text_source: other`); 429/5xx retried with backoff, 401/403/404/
  422 fail loudly without retry.
- `lib/backfeed.mjs`: sources per `backfeed_kinds` — completed cards
  ("Garrison completed: <title>. <outcome snippet>" + tailnet deep link;
  cheap id-key pre-check so unchanged done cards never cost a detail
  fetch), explicit decisions from triaged capture events, and an optional
  once-per-day digest. Client-side fingerprint ledger (the real API has
  NO dedupe and returns no ids); a non-retriable failure stops the run
  instead of hammering the API and ledgers nothing, so a fixed key
  resends everything.
- Template hygiene: redactSecrets pass on all content; no internal ids
  beyond the card deep link (asserted).
- Runs in-process on a 30-min interval when `backfeed_enabled` (the
  sources share this fitting's lifecycle, so a scheduler job would only
  fire into a dead board); `scripts/backfeed.mjs --run` for the runbook.
- Tests: `tests/omi-channel-backfeed.test.ts` (8).

Deviations: backfeed cadence is an in-process interval rather than a
scheduler job (recorded in DECISIONS.md).

Next: M7 — observability counters on /health + status page, RUNBOOK.md,
HUMAN_SETUP.md, funnel-ensure script, full local E2E demo on fixtures
with all flags on.

## M7 — Observability, docs, human checklist (2026-07-30)

Shipped:
- Counters per pipe surfaced on GET /health (merged across the server /
  triage / backfeed writer files) AND rendered on the status page — the
  spec's named counters all exist (`events_in`, `dropped_by_rule`,
  `cards_created`, `wake_hits`, `notifications_sent`, `chat_calls`) plus
  per-reason rejections and the wake latency observation; wake-bus logs
  and counters carry no transcript content (I5).
- `scripts/funnel-ensure.mjs`: idempotent, PROD-guarded funnel setup
  mounting ONLY /omi at :8443 (never :443, never dev); deliberately NOT
  hooked into prod:redeploy — public exposure stays a human act.
- `OMI_API_BASE_URL` testing hook on the Omi cloud client.
- `RUNBOOK.md`: state layout, kill-switch table, fixture replay,
  failure-mode triage, key rotation, uid re-pin, funnel on/off.
- `HUMAN_SETUP.md`: subscription warning (~1200 free min/month), device
  installs, vault seals, funnel click-path with off-box verification,
  private-app creation (App ID/Secret, sk_ Import key, Chat Tools
  Manifest URL), Developer Mode webhook URLs, flag-by-flag turn-on with
  verification, the spoken smoke test ("Zeca, create a test task called
  hello garrison") with expected outcomes/timings, day-summary caveats,
  and the post-go-live measurement list.
- Acceptance: `tests/omi-channel-e2e.test.ts` — the full local demo on
  fixtures with ALL flags on: idempotent double replay -> one-model-call
  triage (card + memory + tip, discarded dropped by rule, empty second
  tick = zero calls) -> spoken wake command -> card + confirmation with
  latency metric -> ask_zeca answer -> kanban lifecycle relay ->
  idempotent backfeed -> counters for every pipe on /health.

Deviations: funnel-ensure is human-invoked, not redeploy-invoked
(recorded in DECISIONS.md).

## M8 - Operative renamed Gary -> Zeca (2026-08-13)

The operative answers to **Zeca**. Two things in this fitting are named
after it, and both changed:

- **Wake word.** Default variants are now `zeca,zeka,zecca,zéca,ze ca`.
  The split form is there because the transcriber sometimes breaks a
  two-syllable name across a space; whitespace inside a variant matches a
  hyphen too. `seca`/`sega` are deliberately NOT variants - near-homophones
  that are also ordinary words would wake the operative out of ambient
  speech.
- **Chat tool.** `ask_gary` -> `ask_zeca`, in the manifest, the handler and
  the status message.

The rename forced a gate change rather than a substitution. "Gary" is rare
in a Portuguese-speaking house; **"Zeca" is an ordinary given name**, and
the old gate fired on the token ANYWHERE in a segment - so every "o Zeca
ligou" would have opened a capture window and fed the next sentence to the
operative as a command. The gate is now two halves: `wakeRegex` finds the
token, and `isAddressPosition` requires it to be ADDRESSED - opening the
utterance or a clause, or after at most three vocative lead-ins ("hey",
"ok", "não", "então"). The Portuguese article "o" is excluded from that
list on purpose, which also costs the vocative "ó Zeca" (they are the same
word once accents are folded); losing one vocative beats admitting every
third-person mention.

Side effect worth having: the name in object position no longer self-
triggers, so Garrison's own outbound copy ("tell Zeca to run card 4F2A")
is inert to the pendant. `ack.mjs`'s speakability guard stays a bare
substring check anyway - it fails closed by design, and diverging in the
stricter direction is what its comment already blesses.

Compatibility: a stored `wake_variants` made up entirely of retired
spellings (`gary,garry,gerry,géri`) is read as unset and falls through to
the current default, logged once at startup. Nothing is written back.

Manual step that cannot be done from here: the tool name lives in the Omi
private app's cached manifest, so the app must be re-saved from the phone.
Not an outage though - `/omi/chat` never inspects `tool_name` (it authorizes on
key + app_id + uid and reads `query`), so a stale manifest still gets a real
answer; what is stale is the name and description Omi's own model sees when
deciding to call the tool. See HUMAN_SETUP.md §10.

## Done

All milestones M0-M7 complete, 2026-07-30; M8 (rename) 2026-08-13.
75 omi-channel tests plus the kanban pinning suites green; typecheck
clean; validation pipeline PASS. Live wiring is HUMAN_SETUP.md.
