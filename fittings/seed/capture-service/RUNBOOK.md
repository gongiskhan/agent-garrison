# Capture service — runbook

Operational reference for the iOS companion's Garrison-side fitting. Human
setup (vault keys, phone install, TestFlight) lives in
[`HUMAN_SETUP.md`](./HUMAN_SETUP.md); design decisions in
[`../../../docs/adr-companion.md`](../../../docs/adr-companion.md); the build
log in [`PROGRESS.md`](./PROGRESS.md).

## Where things are

- Server: own-port fitting, port from `GARRISON_CAPTURESERVICE_PORT`
  (committed map 8097; sandboxes add their profile offset). Status file
  `$GARRISON_HOME/ui-fittings/capture-service.json`; the page at `/` is the
  session list, `/sessions/<id>` the (live) transcript view.
- State: `$GARRISON_HOME/capture/` (override `GARRISON_CAPTURE_DIR`) —
  `sessions/` (deterministic session records), `transcripts/<id>.json`,
  `media/<id>/audio.log` + `frames/*.jpg`, `events/` (the shared triage
  inbox; the store LAYOUT is the contract omi's tick reads),
  `index.json` (session -> event dedupe), `devices.json` (APNs tokens),
  `notify-ledger.json` (per-day push cap), `notify-seen.json` (idempotency),
  `acks-log.jsonl` (ids and outcomes only, never text), `counters-*.json`.
- The phone talks to `/capture/stream` (websocket, Bearer `CAPTURE_TOKEN`),
  `POST /capture/devices`, and the authed session read API. `POST /ack` and
  `POST /notify` are the kanban fan-out sinks (loopback/tailnet only; nothing
  here is ever funneled — v1 rides Tailscale).
- Voice REST (the one voice layer for every surface, D20): `POST /stt`
  (raw clip bytes in, `{transcript, confidence, language, model}` out) and
  `POST /tts` (`{text, format?: "mp3"}` in, `audio/mpeg` out with
  `X-Voice-Backend` and `X-Clip-Id`), both top-level and Bearer
  `CAPTURE_TOKEN`. The browser reaches them through the shell's voice proxy,
  automations through `scripts/connector.mjs` (connector "voice", actions
  `transcribe` / `synthesize`, reads the service url from the status file and
  the Bearer from `CAPTURE_TOKEN`). A clip rendered by `/tts` is the same clip
  the phone fetches unauthenticated at `/speak/<id>.mp3`. `GET /health` carries
  `voice: {stt, tts, ttsBackend, restEnabled}` and `keyConfigured` (= `voice.stt`).
- Text ingest (D24): omi-channel forwards its realtime segments to
  `POST /capture/ingest/text` (Bearer `CAPTURE_TOKEN`; `{source: "omi",
  session_id, segments: [{text, speaker?, is_user?, start?, end?}]}`; 202
  `{session, accepted}`). Each `<source>:<session_id>` is a socket-less text
  session in the ingress: no media log, no transcript, no session record on
  disk and no capture_event when it ends - the idle timer
  (`text_session_idle_ms`, default 2 min) drops it from memory and bumps
  `text_sessions_closed`. Segments cross the shared echo guard, then feed the
  omi wake bus only (source `omi`, memory prefix `omi`, the same
  speak-first-then-push notifier as the companion and pendant buses), so a
  spoken "Zeca, ..." picked up by the Omi device dispatches like one heard by
  the phone.
- Active conversation (D25): a delegate reply carries the gateway's
  `session_id`; for `active_conversation_window_ms` (default 5 min) the same
  bus resumes that conversation instead of its deterministic
  `<origin>-wake:<session>` key. `POST /capture/conversation/active`
  `{session_id}` pins one explicitly (200 `{session_id, until}`), `GET` reads
  the pin, `DELETE` clears it (204). Pin and window are process memory: a
  restart forgets both, by design. Counters
  `wake_delegate_resumed_window` / `wake_delegate_resumed_pin` say which won.

## Kill switches (I9) — all default OFF

| flag | pipe | off means |
|---|---|---|
| `enabled` | session + device ingress | upgrade and `/capture/*` answer 403; nothing stored |
| `transcribe_enabled` | Deepgram lane | sessions store media without transcripts; no STT billing |
| `wake_enabled` | wake bus | segments feed transcripts only; mid-capture sessions never dispatch |
| `notify_enabled` | APNs push | receipts say "notify disabled"; web-channel fallback still used by /notify callers? No — the chain starts at the flag, so delivery is skipped entirely |
| `speak_enabled` | voice sink | acks fall through to push; toggling off silences within one ack |
| `tts_enabled` | spoken clips (phone acks AND `POST /tts`) | phone speaks acks in its own voice; `/tts` answers 503 and `/health` reports `voice.tts: false`; no TTS billing |
| `tts_backend` | which engine speaks (`auto` / `elevenlabs` / `deepgram`) | not a switch but a selector: `auto` takes ElevenLabs when its key is sealed, else Deepgram Aura, else no TTS; an explicit engine without its key means no TTS (503 on `/tts`, phone-voice acks), never a silent swap. Cache ids carry the backend, so switching never replays the other engine's clip |

`POST /capture/ingest/text` follows `enabled` (403) like the websocket; its
segments only reach the wake bus while `wake_enabled` is on, so the kill switch
covers the Omi device too.

`POST /stt` has no flag of its own: it is off when `enabled` is off (403), or
when `DEEPGRAM_API_KEY` is not sealed (503, `voice.stt: false`). Unsealing
`CAPTURE_TOKEN` closes every authed surface at once (403 "not sealed").

Config changes apply at the next `up` (env-fingerprint heal) or immediately
via `POST /api/fittings/capture-service/restart`.

## The two model lanes (unchanged from omi — do not collapse them)

Wake classification pins `classify_target` (default `cc-haiku-low`, ~6s);
unpinned it lands on the composition's duty cell (measured 82s). Delegation
is the full operative, unpinned, ten-minute budget, nobody waiting — ack
first, answer as a second notification.

## Latency legs

`wake_capture_ms` + `wake_classify_ms` + `wake_notify_ms` on `/health`
(plus `wake_hit_to_notification_ms` as the felt total and
`speak_confirm_ms` for the sink round-trip). Read them separately: a single
end-to-end number cannot say which leg regressed and has already produced
one wrong diagnosis. Typical: capture ~1-5s (punctuated finals close early),
classify ~6s pinned, notify sub-second.

## Echo suppression — false positive vs transcription failure

A sentence missing from a stored transcript has two very different causes:

- **Echo suppression** (by design): the app's own spoken ack returning
  through the mic. Diagnose from counters — `realtime_echo_suppressed`
  moved, `echo_registered` moved shortly before, and the missing text
  resembles a recent ack. The suppression window is ~30s, token-containment
  0.8 with a 3-token floor, biased toward letting speech through: a missed
  suppression costs one deletable card; over-suppression eats real words.
- **Transcription failure**: `transcribe_disconnects` / `transcribe_errors`
  moved, or `transcribe_skipped` (flag/key), or the Deepgram side dropped
  (gaps are lost words by design, counted, never a crashed session).
  Sample several sessions before concluding anything systemic — the omi
  runbook's lesson stands.

## Fixture replay and the E2E

```bash
# full-protocol driver against a local/sandboxed instance (see its header
# for coverage limits — it starts at the wire, not at sound):
node scripts/replay-client.mjs run --fixture pt-command --twice --drop-at 80
node scripts/replay-client.mjs bad-token
node scripts/replay-client.mjs malformed

# the whole loop, all flags on, boundaries mocked:
npm run e2e:companion

# real-key Deepgram smoke (SKIP + exit 0 without the key):
DEEPGRAM_API_KEY=... node scripts/deepgram-smoke.mjs pt-command

# replay a REAL captured session's packets against live STT with any params
# (the tool that root-caused the language=multi garbage, 2026-08-13):
DEEPGRAM_API_KEY=... node scripts/replay-stt.mjs \
  ~/.garrison/capture/media/<sessionId>/audio.log \
  "model=nova-3&language=pt&smart_format=true&interim_results=true&keyterm=Zeca"
# decode a session to a listenable WAV (ogg via python, wav via ffmpeg):
python3 scripts/audio-log-to-ogg.py ~/.garrison/capture/media/<id>/audio.log /tmp/s.ogg && ffmpeg -i /tmp/s.ogg /tmp/s.wav

# regenerate the committed audio fixtures (macOS: say + ffmpeg):
bash scripts/make-fixtures.sh
```

Test hooks (env-only, never in config_schema):
`GARRISON_CAPTURESERVICE_DG_URL` redirects the STT socket to
`scripts/mock-deepgram.mjs` AND, with its scheme flipped (`wss` -> `https`,
`ws` -> `http`), the REST lane (`/v1/listen` clips, `/v1/speak` Aura clips),
so one mock base covers both lanes; `GARRISON_CAPTURESERVICE_APNS_URL`
redirects the push gateway to a local h2c mock.

## Key rotation

All secrets live in the Vault, delivered at spawn; rotate by updating the
vault value then `POST /api/fittings/capture-service/restart`.

- `CAPTURE_TOKEN`: generate a new random value, update the vault, restart,
  then paste the new token into the app's Settings (old sessions' sockets
  drop and re-auth fails until the phone updates — deliberate).
- `DEEPGRAM_API_KEY`: rotate at Deepgram, update the vault, restart. Only
  live sessions notice (their sockets reconnect with the new key).
- `APNS_P8`/`APNS_KEY_ID`: mint a new APNs auth key in the Developer portal
  (keys are team-wide), seal content + id, restart. `APNS_TEAM_ID` never
  changes. A wrong key fails loudly per push with per-token reasons.

## APNs troubleshooting

- `/health` secrets block shows which of the three APNS_* keys are unsealed.
- Receipts (server log, `notify <tag> -> companion-push:...`) carry the
  APNs reason: `BadDeviceToken`/`Unregistered`/410 mean the token is dead
  and was pruned (`apns_tokens_pruned`) — reinstalling the app or switching
  device re-registers on next launch. `TooManyRequests`/5xx retry with
  Retry-After honoured (capped 5 min) then degrade to the web-channel
  thread (`notify_fallback_web`).
- `notify_capped`: the per-day cap (`notify_max_per_day`) tripped; delivery
  degrades until midnight UTC.
- TestFlight builds use the PRODUCTION gateway — `apns_environment` stays
  `production`; `sandbox` is only for Xcode-run development builds.
- A loopback URL in a notification is a bug by definition (the phone is
  never on this host): `notify_loopback_link_stripped` counts the strips;
  fix the caller to send tailnet-paired links.

## TestFlight lane

`npm run ios:testflight` locally (fail-fast env check; see
`scripts/ios-testflight.sh`) or dispatch the CI workflow that lives in the
PRIVATE ios-thing repo (agent-garrison is public and carries no signing
assets — its match storage and ASC secrets stay there):

```bash
gh workflow run garrison-ios.yml -R gongiskhan/ios-thing -f lane=beta
# first push-enabled build only:
gh workflow run garrison-ios.yml -R gongiskhan/ios-thing -f lane=beta -f match_force=true
```

The App Store Connect APP RECORD is a one-time manual step (HUMAN_SETUP.md)
— record creation has no API-key path, verified three ways in the Fastfile
header comment.

## Server refuses to start

A live pid holds the status file (stop it first) or the canonical port is
taken — it never falls back to a shifted port.

## Pendant Direct operations

- Flags: `pendant_enabled` (default off) gates mode "pendant" sessions on
  the same websocket ingress; `capture_policy` (`wake_only` default |
  `ambient`) applies ONLY to pendant sessions. Mic sessions never read it.
- wake_only storage contract (asserted in tests/pendant-capture.test.ts):
  no media log, no transcript, no session record, no session capture_event.
  The wake path persists exactly what omi's does: a wake_command event,
  wake-results, the card. Counters carry everything else
  (`pendant_sessions_unpersisted`, `transcripts_dropped_policy`).
- Feedback loop: server pushes {type:"feedback"} events (wake_detected,
  segment_captured, window_closed, task_created, task_failed) on the pendant
  session socket; the app acks with {type:"feedback_ack"}. Latency on
  /health: `wake_to_device_ack_ms*` (target < 1500) and
  `card_commit_to_created_ack_ms*` (target < 2000). `feedback_wake_deduped`
  moving means the interim watcher is beating the final to the wake pulse -
  that is the design, not a bug.
- The pendant e2e (sandboxed, external-free, scenario matrix incl. both
  policies, mid-window disconnect, duplicates, near-misses, unacked
  feedback): `npm run e2e:pendant`. The replay client speaks the pendant
  wire dialect: `node scripts/replay-client.mjs run --mode pendant
  --fixture pt-hellogarrison --cadence real`.
- Pendant wake identity: source "pendant", origin pendant:wake:<event>,
  thread pendant-reports; triage identity added additively in omi-channel's
  TRIAGE_SOURCES (ambient sessions only - wake commands never batch-triage).
- BLE layer: docs/pendant-protocol.md is the wire truth; the Companion's
  transport does connect-by-retrieval, 200 ms chipset-level reconnect, and a
  4 s audio liveness watchdog (one forced CCCD re-arm) after every
  reconnect. Pairing-lost stops auto-reconnect and needs the user.
