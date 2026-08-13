# iOS companion — build progress

Milestones per [`docs/COMPANION_IOS_SPEC.md`](../../../docs/COMPANION_IOS_SPEC.md)
(M0–M9, plus M5b). A milestone is done only with green tests and an entry here.
Design decisions in [`docs/adr-companion.md`](../../../docs/adr-companion.md);
deviations in [`DECISIONS.md`](./DECISIONS.md).

## M0 — Preflight, recon, ADR, scaffolds (2026-08-13)

Shipped:
- Preflight green: macOS 26.3.1 + Xcode 26.2 + iOS 26.2 simulators; repo
  writable; the "iOS thing" reference located as `gongiskhan/ios-thing`
  (IOS_THING_PATH was unset — cloned to `~/Projects/ios-thing`); vault
  verified on the prod host (unlocked; DEEPGRAM_API_KEY, CAPTURE_TOKEN and
  APNS_* pending as the spec predicted, reported not blocking);
  APP_BUNDLE_ID decided: `com.gomes.garrison` (user pick).
- `make remote-doctor` restored to green (origin-URL comparison normalized in
  `scripts/remote-dev.sh`; dev-madrid host key verified and added), so fitting
  tests run on dev-madrid per the house rule — the Mac runs only Xcode work.
- Recon of both reference codebases completed and recorded:
  the omi/triage/ack/echo-guard/notify seams (four-part report) and ios-thing's
  broadcast/uploader/APNs/TestFlight internals (three-part report). Three spec
  assumptions refuted (see DECISIONS): no fMP4 encoder exists, no
  ios-certificates match usage in ios-thing, no shared framework target.
- Mid-run rename absorbed: the operative is **Zeca** (commit `b3a82ec3`), wake
  gate now requires address position; all companion fixtures and defaults use
  the Zeca variants.
- `docs/adr-companion.md`: ten decisions locked (XcodeGen; one-engine triage
  with a second inbox root; APNs sender inside this fitting; byte-identical
  wake/echo-guard copies with a lockstep test; media layout; AEC-in-audio-mode
  speech policy; fitting shape; TestFlight lane with match storage on the
  private `ios-certificates` repo).
- Fitting scaffold: `apm.yml` (faculty channels, own_port 7097, provides
  channel/companion, five vault keys in secret_scope, every pipe a default-off
  flag), `lib/config.mjs` (env-only config, resolved-cfg house rule),
  `lib/store.mjs` (ulid/atomic-write/Counters + CaptureStore roots),
  `scripts/start.mjs` + `scripts/server.mjs` (live-pid status-file guard,
  /health, status page, 501 milestone surfaces, 404 non-sink /ack + /notify),
  `scripts/capture.mjs --probe` verify hook, non-blocking `scripts/setup.sh`.
- Registered in `data/library.json`; stationed in the default composition's
  channels selection with every flag off.
- `ios/` skeleton: XcodeGen `project.yml` (GarrisonApp + BroadcastExtension +
  Shared sources, manual-signing settings carried from ios-thing), minimal
  SwiftUI app, broadcast SampleHandler stub, App Group `group.com.gomes.garrison`;
  `xcodegen generate` + simulator build green (CODE_SIGNING_ALLOWED=NO).
- Sandbox test `tests/capture-service.test.ts` (boot on port 0, /health shape,
  status-file contract, flags-off defaults, 501/404 conventions) green via
  `make remote-test`.

Next: M1 — websocket ingress per spec §4 (token auth, acks, resume, dedupe),
session store, fixtures, replay client.

## M1 — Ingress and wire protocol (2026-08-13)

Shipped:
- `lib/ingress.mjs`: one websocket per session at `/capture/stream`, Bearer
  `CAPTURE_TOKEN` on the upgrade (timing-safe digest compare; 403 disabled /
  403 unsealed / 401 bad token, each counted). Binary media framing
  `[u8 kind][u32 seq][f64 ts][u32 len]` (kind 0 = Opus packet, 1 = JPEG
  still); per-stream contiguous acks `{type:"ack", stream, seq}` — stream-
  tagged because two interleaved streams share one socket. Sessions survive
  socket drops and process restarts (resume answers both high-water marks);
  an ended session refuses to reopen (dedupe by session id); a reconnect
  supersedes its own dying socket; idle sessions close with reason
  "timeout". Malformed session_start closes 1008 with no state created.
  Session records are deterministic (no server wall-clock) — invariant I7's
  byte-identical double replay holds for the whole store.
- `lib/media-log.mjs`: append-only framed Opus log per session (one file, not
  180k inodes), JPEG stills one file per seq; only next-expected seqs are
  ever persisted, with a bounded reorder buffer (256) and dedupe-with-ack for
  everything at or behind the edge; high-water recovered by scanning the log
  (the log is the authority, a truncated crash tail is skipped dead bytes).
- Server surfaces: `POST /capture/devices` (APNs token registry, idempotent),
  `GET /capture/sessions` + `/capture/sessions/<id>` (authed read API for the
  replay client and the M2 view), flag-off answers moved 501 -> 403 for the
  implemented routes. `ws` resolves from the repo root like kanban-loop's.
- Fixtures: real recorded speech as raw Opus packets (Joana pt_PT command,
  Samantha en_US command, pt ambient, en near-miss with Zeca in object
  position; 134-197 packets each) via `scripts/make-fixtures.sh` (macOS
  say + ffmpeg + an Ogg-page parser in python, committed for regeneration);
  JPEG still set; malformed session.
- `scripts/replay-client.mjs`: full-protocol driver in the speak.mjs shape —
  follows every injection to the stored session record and the counters,
  prints the effect or says nothing arrived, states its coverage limits in
  the header (starts at the wire, not at sound; Deepgram not under test;
  byte-identical proof lives in the disk-access test). Modes: run
  (--twice / --drop-at / --mode screen_audio), bad-token, malformed.

Tests (19, green on dev-madrid): end-to-end session with per-stream acks;
duplicate replay acked-at-edge with byte-identical store hash; refused reopen
after end; resume-after-drop from last acked seq; out-of-order reassembly;
bad token counted; disabled 403; malformed close without state; idempotent
device registry; idle timeout; the replay client run as a real subprocess
over the committed fixtures (drop at 50, --twice, effect-following) plus its
refusal modes.

Next: M2 — Deepgram live client (mocked in tests, env-gated real-key smoke),
per-session transcript store, live transcript view + session list/detail.

## M2 — Live transcription and the transcript view (2026-08-13)

Shipped:
- Docs fetched and verified first (`docs/api-notes.md`): endpoint, **Token**
  auth scheme (not Bearer), nova-3 + `language=multi` covers the operator's
  Portuguese/English code-switching, `encoding=opus` means bare packets (the
  wire protocol's exact payload; `ogg-opus` would be the container),
  `sample_rate` required, diarize word-level speaker ints, KeepAlive /
  CloseStream control messages.
- `lib/deepgram-live.mjs`: one Deepgram socket per LIVE session (cost gate
  I4 — billed only while a session is live), fed in seq order by the media
  log's persist hook (exactly-once, deduped); interims in memory for the
  view, finals accumulated and flushed on CloseStream; 5s KeepAlive when
  idle; one delayed reconnect per unexpected drop with a bounded catch-up
  queue (gaps are lost words, counted, never a crashed session); injectable
  wsFactory (cfg escape hatch) so tests run a mock endpoint while asserting
  the REAL URL and Token header the lane would have used.
- Session finalize awaits the transcript flush: `transcripts/<id>.json`
  (segments + word count), `transcript_ref`/`transcript_words` on the session
  record, `session_ended` sent only after both are on disk. Lane failures
  cost the transcript, never the record.
- Own-port view: session list on `/`, per-session page `/sessions/<id>`
  rendering stored finals server-side, live sessions streaming interim+final
  segments over SSE (`/sessions/<id>/events`, replay-then-stream, 15s
  heartbeats). View surface is unauthenticated loopback/tailnet like every
  own-port fitting UI; the programmatic `/capture/*` API keeps Bearer.
- `scripts/deepgram-smoke.mjs`: env-gated real-key smoke (SKIP + exit 0
  without the key) streaming a committed fixture through the same lane and
  printing what arrived — the one live external before TestFlight.

Tests (24 total, green on dev-madrid): segment mapping (diarized speaker,
is_user heuristic, interim/final), verified URL+auth assertions, fixture
replay -> stored transcript + record refs + API + rendered view, live SSE
interim/final streaming mid-session, flag-off and keyless skip paths, and
the I5 console-spy proof that no transcript text reaches logs.

Next: M3 — the wake gate over companion live segments (byte-identical wake
module copy + lockstep test, pinned classification, delegate lane).

## M3 — Wake gate on companion sessions (2026-08-13)

Shipped:
- omi-channel's wake bus and memory writer gained behaviour-preserving
  source-identity parameters (`WakeBus source=` bag, `MemoryWriter
  prefix/label`) — hardcoded "omi" identities would have violated I2 for
  companion events; every default preserves omi behaviour exactly and omi's
  wake/triage/e2e suites pass unchanged.
- Six modules consumed as BYTE-IDENTICAL copies (wake, echo-guard,
  board-client, memory-writer, gateway-client, tailnet-serve), guarded by
  `tests/companion-lockstep.test.ts` — an edit to either side fails CI until
  both are synced (the run-spec-lockstep discipline).
- Wiring: Deepgram FINAL segments (interims are unstable and the settled
  close keys on final punctuation) -> echo guard (one instance per process,
  consulted BEFORE the wake gate; registration arrives at M5b) -> the wake
  bus under the companion identity (source companion-ios, origin
  companion:wake:<id>, provenance companion_session_id, thread
  companion-reports). Classification pinned to `classify_target`
  (cc-haiku-low); delegation unpinned via the copied gateway client.
- `lib/notify.mjs`: the M5 notifier's skeleton — template rendering
  (card_created / wake_confirmation / ask / tip / relay), tailnet-paired
  cardUrl, honest per-means skip receipts ("APNs transport not implemented
  until M5") so the confirmation path runs end to end without pretending a
  push happened (I11).
- Mid-run gate change absorbed: the address-position rule was REMOVED
  (`5d510fb4`) hours after the Zeca rename introduced it — the live gate is
  token-anywhere on word boundaries; fixture comments and docs corrected.

Tests (155 across companion + omi + ack suites, green on dev-madrid): the
spoken fixture command dispatches EXACTLY once with companion identity end
to end (card on a stub board, capture_event + wake-results on disk, the
routing pin asserted on the stub gateway's request body, three latency legs
counted, honest notifier receipt); near-misses ("seca", "zecar") drop;
duplicate segments dedupe; the kill switch kills mid-session; a registered
echo fingerprint suppresses the app's own voice before the gate.

Next: M4 — triage generalization (second inbox root, one tick, one model
call, wait-for-context hold).

## M4 — Triage generalization (2026-08-13)

Shipped:
- One engine, second inbox: omi's `runTriageTick` gains `extraStores` — the
  companion's `$GARRISON_HOME/capture` joins the SAME tick through the
  `EventsDirStore` adapter (store LAYOUT is the sharing contract), discovered
  by directory-existence convention, no registration. One batch, ONE model
  call across all sources, one dedupe space; the triage-result doc is
  written into every participating store root so each state dir stays
  self-contained.
- Source identities (`TRIAGE_SOURCES` keyed by `event.source`) replace every
  hardcoded "omi" in the card/memory paths: origin prefixes, originChannel,
  provenance ref keys/labels, source-context labels, prompt source lines.
  Per-event `memoryWriterFor` / `notifierFor` route memories (companion-
  prefixed vault files) and notifications (a `CompanionRelayNotifier` that
  hands card_created to the capture-service's /notify, which owns the APNs
  flag/cap/registry — the authoritative-server rule; 404 until M5 = honest
  skip).
- Wait-for-context, both halves: the capture-service emits ONE capture_event
  per session at session END only (`lib/events.mjs`, dedupe-by-session-id
  index, consent + mode + device in provenance per I6, the hold floor
  stamped on `normalized.stats`), and the shared rule layer HOLDS a
  thin-fragment session (below its floor) while it is alone — zero model
  calls — releasing it the moment any other event shares the batch or the
  30-minute hold window expires.
- Session kind is always task-eligible (no upstream action-item extractor;
  the model decides from the transcript; card rule text extended).
- The lockstep gate caught its first REAL drift mid-milestone: a concurrent
  commit (`568ce931`) amended omi's `buildDelegatePrompt` after the M3 copy;
  the mirror was re-synced. The mechanism works.

Tests (32 across the M4-affected suites, green on dev-madrid; full-repo
sweep run once — 5156 pass; the two failing `flow-*` suites belong to
another session's in-flight work and read generated state absent from any
clean clone): emission with consent provenance + forever-dedupe; a MIXED
omi+companion batch in one model call with per-source identity on cards,
memories and notifications; re-runs creating zero duplicates via origin
dedupe; the hold-alone / release-on-context / age-release ladder; empty
tick zero calls; rule-layer verdicts stable for both sources.

Next: M5 — APNs transport (ported apns.js, device registry, /notify sink,
caps and Retry-After backoff, non-loopback deep links).

## M5 — APNs transport (2026-08-13)

Shipped:
- `lib/apns.mjs`: ios-thing's proven zero-dependency sender ported faithfully
  (ES256 JWT with `ieee-p1363` — the JOSE r||s signature APNs requires; JWT
  cached under 40 min; HTTP/2 to the production or sandbox gateway per
  config; per-token `{status, reason, ok, dead}` outcomes; the idempotent
  finalize-with-timeout that keeps a dying session from hanging the caller).
  Adaptations: secrets from the vault-delivered cfg (APNS_TEAM_ID /
  APNS_KEY_ID / APNS_P8 — key CONTENT, PEM or base64, same sniff as the
  TestFlight lane), the `retry-after` header surfaced per response, and an
  injectable http2 connect for tests.
- `lib/notify.mjs` grew the real chain: notifyEnabled -> unsealed -> no
  devices -> per-day cap (notify-ledger.json) -> APNs with dead-token pruning
  and up to two retries whose delays honour Retry-After (capped 300s) or use
  5s/25s floors — wider than a burst window (spec §11 failure 7) —
  degrading to the web-channel PWA thread on persistent failure. Receipts
  keyed by means. Loopback deep links are STRIPPED before render
  (unreachable + mixed content on a phone; already shipped broken once).
- `POST /notify` sink: the kanban fanOutNotification contract shape (also
  spoken by M4's CompanionRelayNotifier), idempotency-key dedupe with a 48h
  ledger, title/text/link/tag -> the notifier's chain. Implementing the
  route IS the opt-in; /ack stays 404 until M5b.
- Templates card_created / wake_confirmation / ask / tip / relay all render
  to one plain-text message + one bare link, no buttons; the wake bus's
  confirmations now genuinely push.

Tests (65 across the companion suites, green on dev-madrid; typecheck
clean): offline JWT verification with a throwaway P-256 key (3 parts,
ES256/kid/iss/iat, signature EXACTLY 64 bytes proving P1363, crypto.verify
passes, cache window honoured); PEM/base64 p8 sniff; verified request
headers + aps payload shape via a fake http2 session; dead-token pruning;
Retry-After-honoured 429 retry; persistent-5xx degrade to a real loopback
web-channel stub with the I5 no-content-in-logs spy; the per-day cap;
loopback-link stripping (tailnet links pass); /notify idempotency and the
live toggle.

Next: M5b — the speech sink (POST /ack, echo registration before speak,
socket forwarding, queue ceiling, staleness, receipts).

## M5b — Speech sink (2026-08-13)

Shipped:
- `lib/ack-sink.mjs` — the `fanOutAck` consumer. Order is load-bearing
  (§2.5): the echo fingerprint registers BEFORE any speak instruction
  leaves. A live AUDIO-mode session with a connected socket gets
  `{type:"speak", ack}` (screen_audio never speaks in-session — the
  broadcast extension's mic has no AEC coupling to the app's speaker); the
  app answers `{spoken, ok, reason}` and the server ledgers confirmations,
  failures and 30s receipt timeouts with a `speak_confirm_ms` observation —
  a silently-dropping sink is distinguishable from an off one. Otherwise
  the ack falls through to APNs, SHARING the notification's idempotency
  ledger so one event buzzes once. `POST /ack` implements the contract
  (skipped acks ignored, textless 400); /ack and /notify stay separate
  routes by design. The server ack log keeps ids and outcomes, never text.
- Echo suppression moved to the ONE ingestion point: the transcription
  lane's `suppressFilter` drops a returning ack segment before the stored
  transcript, the live view AND the wake feed — the M5b acceptance asserts
  on the transcript itself. The queue ceiling (3) and staleness window are
  the app's own behaviours and land with the Swift sink at M6.

Tests (25 across the M5b-affected suites, green on dev-madrid; typecheck
clean): speak into a live session with receipt ledgering; sink toggled off
mid-flight silences within ONE ack, no restart; screen_audio and closed-app
paths ride APNs; app-side failure receipts; skipped/textless acks; the
shared idempotency ledger; and the stored-transcript proof — the app's own
fragmented ack comes back through the (mock) mic, is suppressed from the
persisted transcript while the operator's genuine sentence survives, and
the wake gate never fires.

Next: M6 — the iOS app (broadcast extension port, §4 uploader with App
Group buffering, AVAudioEngine audio mode, consent, settings, speech sink,
APNs registration, ack log, simulator tests).

## M6 — The iOS app (2026-08-13)

Shipped (`ios/`, ~2k lines of Swift):
- Shared layer (compiled into app AND extension): `CaptureProtocol` (the §4
  17-byte framing + Codable control messages + ULID-flavoured session ids),
  `SessionSpool` (append-only wire-frame spool in the App Group container,
  two-segment ring keeping disk bounded, crash-safe scan, replay filter),
  `OpusEncoder` (one AVAudioConverter doing 48k Float32 -> 16k mono Opus
  ~20ms packets, with the CMSampleBuffer bridge for the extension), and
  `CaptureUploader` — the hardened engine: spool-before-send, per-stream
  contiguous-ack tracking, reconnect with capped backoff, session_resumed ->
  replay past the server's high-water, {type:"speak"} delivery and {spoken}
  receipts on the same socket.
- App: big start/stop with mode selection (audio in-app; screen via the
  system broadcast picker), the exact-copy consent sheet with persistent
  "Don't ask me again" (consent state travels either way), Settings (base
  URL/token/device name, §5b voice controls: master + info toggles, rate,
  volume, mute-for-60, quiet hours), `CaptureController` (AVAudioEngine
  under .playAndRecord/.voiceChat/.defaultToSpeaker — hardware AEC per ADR
  §6 — with interruption pause/resume), `SpeechSink` (queue ceiling 3 that
  never sacrifices an error, ~30s staleness, honest receipts for every
  decision), APNs registration into the device registry, a sessions screen
  linking to the fitting view, and the §5c local ack/notification log.
- Extension: the proven ios-thing SampleHandler discipline verbatim (1.5fps
  JPEG stills, downscale-to-720, one CIContext, autoreleasepool, drop under
  backpressure) feeding the SAME uploader; audio encoded to the same Opus
  packets; no speech in this process (no AEC coupling).
- DEBUG-only `FixtureStreamer` (simctl-env-driven) streams the bundled
  pt-command fixture through the real uploader; the fitting gained the
  env-only `GARRISON_CAPTURESERVICE_DG_URL` mock redirect (omi's
  OMI_API_BASE_URL precedent) and `scripts/mock-deepgram.mjs`.

Verified:
- 22/22 simulator tests green (`xcodebuild test`): framing round-trip and
  byte layout, control-message wire shapes, server-message parsing, spool
  scan/resume/ring-rotation/crash-tail, speech-sink policy (10-in-5s
  collapse, error never dropped, stale, master/info/mute/quiet-hours), the
  consent + settings + ack-log persistence, and the uploader against a real
  Network.framework WebSocket mock — including hard-drop -> reconnect ->
  replay of exactly the unacked frames, and speak-with-receipt.
- Release build for generic iOS device compiles (signing at M8).
- The live acceptance: the simulator app (fixture autostart) streamed 197
  Opus packets over the tailnet to a sandboxed capture-service on the prod
  host (mock Deepgram behind the env redirect); all packets acked, session
  ended clean, the transcript stored (9 words) and RENDERED on the fitting's
  session view. The broadcast path stays device-only by design.

Next: M7 — the all-flags-on fixture E2E (npm run e2e:companion).

## M7 — E2E on fixtures, all flags on (2026-08-13)

Shipped: `npm run e2e:companion` -> `tests/companion-e2e.test.ts`, green from
a clean sandbox in one run. Every flag on; every external boundary mocked
locally (mock Deepgram behind `GARRISON_CAPTURESERVICE_DG_URL`, a plain-h2c
mock APNs behind the new `GARRISON_CAPTURESERVICE_APNS_URL` env hook, stub
kanban board discovered via the sandbox status file, stub gateway answering
both prompt kinds). The loop proven end to end:

- device registration; the committed replay client as a real subprocess
  (fixture streaming, mid-stream drop + resume, --twice dedupe);
- a live session hears "Zeca, cria uma tarefa..." -> wake gate -> PINNED
  classify (routing asserted on the stub gateway) -> card on the backlog
  with origin companion:wake:<id> -> confirmation push on the mock APNs
  with the right topic;
- the kanban ack arrives at POST /ack, echo registers FIRST, the app
  stand-in speaks it and the {spoken} receipt ledgers; the app's own voice
  comes back fragmented and is SUPPRESSED FROM THE STORED TRANSCRIPT while
  the operator's real sentence survives;
- session end emits ONE capture_event with consent provenance; the shared
  triage tick (run one-shot, as omi's e2e does — the cron cadence belongs
  to the scheduler) makes ONE model call, cards with
  origin companion:<session>:0, persists a companion-prefixed memory with
  provenance, and the relay pushes card_created through /notify -> APNs;
- the ask template goes out through /notify; /health counters reflect every
  pipe (ingress, dedupe, transcription, wake legs, echo, speech receipts,
  pushes, emission).

Coverage limits stated in the test header: Deepgram/APNs are mocks (the
env-gated smoke and TestFlight cover the live halves); the phone's encoder
is the device smoke's job; the scheduler daemon is not under test.

Full companion suite: 55 tests across 10 files, green on dev-madrid;
typecheck clean.

Next: M8 — TestFlight (ported fastlane lane, match on ios-certificates).
