# ADR — Garrison iOS Companion (capture-service + ios/)

Status: accepted (M0, 2026-08-13). Decisions for the companion build per
[`COMPANION_IOS_SPEC.md`](./COMPANION_IOS_SPEC.md) §7 M0. Every choice below
was made against recon of the live code, not the spec's assumptions; where the
two disagree the disagreement is listed in
`fittings/seed/capture-service/DECISIONS.md`.

## 1. Project generation: XcodeGen, pbxproj never committed

`ios/project.yml` is the committed source of truth; `Garrison.xcodeproj` is
generated (`xcodegen generate`) and gitignored. Not a preference call: the
TestFlight automation being ported from ios-thing runs `xcodegen generate` in
both CI jobs and inside the fastlane lane, so a committed pbxproj would be
overwritten on every build anyway. XcodeGen 2.46.0 is installed on the Mac.
The project.yml carries forward ios-thing's two hard-won signing rules
verbatim: the sdk-qualified `CODE_SIGN_IDENTITY[sdk=iphoneos*]` override and
the repetition of signing keys at target level (xcodegen's preset otherwise
injects "iPhone Developer" over the project-level value).

Targets: `GarrisonApp` (application, `com.gomes.garrison`),
`BroadcastExtension` (app-extension, `com.gomes.garrison.broadcast`),
`Shared/` compiled into both targets as sources — ios-thing has no shared
framework target and neither do we; two copies of ~200 lines beats dynamic
linking inside a memory-capped extension. App Group:
`group.com.gomes.garrison`. Deployment target iOS 17.0.

## 2. Triage generalization: one engine, second inbox root, source-parameterized

The triage engine stays where it lives — `omi-channel/lib/triage.mjs` — and
remains the ONLY engine (spec I1). Recon found it already source-agnostic
except for an enumerated leakage list (hardcoded `omi:` originId prefixes,
`originChannel:{channel:"omi"}`, `provenance.omi_conversation_id` reads,
prompt wording, memory tag/filename prefixes). The generalization is:

- The capture-service keeps its own store at `$GARRISON_HOME/capture/` using
  the same store layout as omi (`events/<id>.json`, `index.json`, per-writer
  counters). The store *layout* is the sharing contract; there is no
  cross-fitting import (house rule; the gateway-client precedent).
- The omi-triage scheduler job stays the single tick. Its baked env prefix
  gains `GARRISON_CAPTURE_EVENTS_DIR` (projected only when the capture fitting
  is selected). The tick constructs a second store over that root and drains
  BOTH pending inboxes into ONE batch → ONE model call per non-empty tick
  across all sources. Dedupe keys already embed the source
  (`omi:…` / `companion:…`), so one dedupe space falls out for free.
- The leakage list is fixed by reading source-dependent values off the event
  (`event.source`, `event.provenance`, `event.origin_prefix`) instead of
  literals. Omi events keep byte-identical behaviour; that is asserted by the
  existing omi triage tests continuing to pass unchanged.
- Wait-for-context: the spec asks to "preserve" a hold that does NOT exist in
  today's triage (recon-verified). It is added in M4: a companion session
  emits its `capture_event` only at session end (so an open session can never
  be carded), and the rule layer holds a too-thin event (below a transcript
  floor) as `pending` without consuming a model attempt until either a later
  event from the same device arrives in the batch or a max-hold age expires.

Why not a shared `$GARRISON_HOME/triage/inbox/`: migrating omi's live store
is invasive, touches state the spec says not to touch, and buys nothing the
second-root mechanism doesn't.

Edge accepted for v1: triage physically runs inside omi-channel, so a
composition with capture-service but no omi-channel has no triage tick. The
default composition equips both; recorded in DECISIONS.

## 3. APNs sender placement: inside capture-service

The sender (ported from ios-thing's zero-dependency `apns.js`: ES256 JWT with
`dsaEncoding: 'ieee-p1363'`, ~40-min JWT cache, HTTP/2, per-token
`{status, reason, dead}` outcomes, idempotent finalize with timeout) lives in
`capture-service/lib/apns.mjs`. The fitting owns the device registry
(`$GARRISON_HOME/capture/devices.json`, populated by `POST /capture/devices`),
the `.p8` secret scope, the per-day cap ledger, and the backoff. Secrets:
`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_P8` (PEM content in the vault; base64
also accepted, same sniff as the fastlane lane), `APP_BUNDLE_ID` as config
(`apns_topic`), not a secret.

Delivery seams — no kanban-loop routing-table edits at all:

- `POST /notify` (the existing 404-tolerant `fanOutNotification` contract):
  implementing it makes the fitting a notification sink the moment it runs.
- `POST /ack` (the `fanOutAck` contract): echo-fingerprint registration +
  speech forwarding + APNs fallback (M5b).
- Triage-created cards for companion-origin events: the generalized notifier
  resolves the capture-service from its status file and POSTs, mirroring
  `sendWebChannelFallback`. The scheduler-spawned triage process never
  re-checks the fitting's `notify_enabled` flag — the owning server is
  authoritative (the RelayNotifier lesson, spec §11 failure 4).

Receipts are keyed by `means` (`companion-push`), never by list position.

## 4. Wake-module sharing: byte-identical copy + lockstep test

Cross-fitting imports are forbidden, so `wake.mjs` and `echo-guard.mjs` are
copied byte-identical from omi-channel into capture-service, and
`tests/companion-lockstep.test.ts` asserts both copies match the originals —
the same discipline `run-spec-lockstep.test.ts` applies to the routing-field
mirrors, and the stricter successor of the ack.mjs wakeRegex copy. A drift
edit fails CI until both sides are synced. Everything WakeBus needs (store,
board, notifier, runFn, operativeFn, cfg, now) is already injected, so the
copy runs unmodified over companion segments once ingress normalizes Deepgram
results to the omi segment shape (`{start, end, text, is_user, speaker}`).

The copy is taken from current HEAD: the operative is now **Zeca** (variants
`zeca,zeka,zecca,zéca,ze ca`). An address-position gate shipped with the
rename (`b3a82ec3`) and was removed the same day (`5d510fb4`, operator's
call) — the live gate is token-anywhere on word boundaries. Every spec phrase
"Gary, …" is "Zeca, …" at runtime; fixtures use Zeca.

Classification calls pin `routing:{target: classify_target}` (default
`cc-haiku-low`); delegation goes unpinned with the two-notification pattern.
Latency is counted in the same three legs (`wake_capture_ms`,
`wake_classify_ms`, `wake_notify_ms`).

## 5. Media storage layout

Root `$GARRISON_HOME/capture/` (override `GARRISON_CAPTURE_DIR`), all writes
atomic (tmp + rename), ulid ids, per-writer counters — the omi store
conventions:

```
sessions/<sessionId>.json        session record: mode, consent, device_name,
                                 started_at/ended_at, end_reason, seq high-water
                                 marks, transcript/media refs, status
transcripts/<sessionId>.json     final Deepgram segments (normalized shape)
media/<sessionId>/audio.log      append-only framed Opus packet log
                                 (seq, ts, len, bytes per record) + audio.idx
media/<sessionId>/frames/<seq>.jpg   JPEG stills (screen_audio mode) — these
                                 ARE the stored keyframes; no fMP4 in v1
events/<id>.json + index.json    capture_event store, omi layout (triage contract)
devices.json                     APNs device-token registry
notify-ledger.json               per-day push cap ledger
counters-server.json             counters (no transcript text ever — I5)
acks-log.jsonl                   bounded ack receipt log (id, kind, outcome,
                                 spoken receipt — no text)
```

Audio is an append-only log, not a file per frame (a 1 h session at 20 ms
packets would be ~180k inodes). Idempotent replay: a frame whose seq is
already recorded is dropped before the write; double replay of a fixture set
is byte-identical. JPEG frames are naturally one file per seq.

The wire protocol difference from the spec is recorded in DECISIONS: ios-thing
has NO fMP4 encoder (recon part 1) — screen video is JPEG stills at ~1.5 fps
with a proven extension-memory discipline. v1 keeps that proven path
(`{seq, ts, bytes}` framing unchanged); an fMP4 encoder is new risk against a
hard memory ceiling for zero v1 value ("no interpretation of screen content").

## 6. Speech: AEC in audio mode; APNs in screen_audio mode

- **Audio-only sessions** (dictation, meetings, car): the app owns the session
  socket and speech rides it (`{type:"speak"}`). Speaking while the mic is hot
  relies on the platform voice-processing unit: `AVAudioSession` category
  `.playAndRecord`, mode `.voiceChat`, `.defaultToSpeaker` — hardware AEC.
  If real-device use shows AEC leakage (M9 smoke), a "speak only when mic is
  cold" setting is the fallback; the echo guard makes the residual cost one
  deletable card, never a loop.
- **Screen+audio sessions**: the mic is captured by the broadcast EXTENSION
  (a separate process; its capture is not AEC-coupled to the app's speaker),
  so in-session speech is NOT attempted — acks fall through to APNs. The
  spec's "same socket when a session is live" holds for audio mode only
  (DECISIONS line).
- The echo guard registers the fingerprint at `POST /ack` time — BEFORE any
  speak instruction is forwarded — and suppression runs in ingress before the
  wake gate, exactly as omi does. Both defences stay independent of
  `assertSpeakable` at render time.

## 7. Echo-guard sharing

Byte-identical copy (`lib/echo-guard.mjs`, 84 lines) + the same lockstep test
as the wake module (§4). One EchoGuard instance per server process, injected
into ingress and the request handler — never two (the omi wiring lesson).

## 8. Fitting shape (locked)

- `faculty: channels`, `provides: [{kind: channel, name: companion}]`,
  `consumes: vault (one), memory-store (optional-one)`, `own_port: true`,
  `default_port: 7097` (free in the 70xx family; prod 8097, codex 27097),
  `component_shape: script`, no `ui.views[]` — the own-port page is the view
  (omi precedent).
- `secret_scope: [DEEPGRAM_API_KEY, CAPTURE_TOKEN, APNS_TEAM_ID, APNS_KEY_ID,
  APNS_P8]` — fail-closed: no scope, no secrets.
- Every pipe behind its own default-off flag: `enabled` (ws + HTTP ingress),
  `transcribe_enabled` (Deepgram, billed only while a session is live),
  `wake_enabled`, `notify_enabled` (APNs), `speak_enabled` (the voice sink).
  A flag off answers 403 on the implemented surface; 501 marks
  not-yet-implemented milestones (omi convention).
- Verify hook: `scripts/capture.mjs --probe` → `CAPTURE-OK`, read-only,
  gateway-independent.
- Server follows the omi house rules: resolved-cfg-object-only (no ambient
  env re-reads), EADDRINUSE fatal, status-file live-pid guard, SIGTERM/SIGINT
  cleanup, `/health` with flags/secrets/counters blocks.
- Auth: `Authorization: Bearer CAPTURE_TOKEN` on the websocket upgrade and
  every `/capture/*` HTTP call, timing-safe compare via fixed-length digests.
  `/ack`, `/notify`, `/internal/*` stay loopback/tailnet-only by construction
  (no funnel is ever mounted for this fitting — v1 rides Tailscale).

## 9. TestFlight lane (M8 shape, decided now)

Ported from ios-thing's Fastfile/ios.yml with the same env names
(`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, `APPLE_TEAM_ID`,
`MATCH_PASSWORD`, `BUNDLE_ID`). Differences:

- **Match storage: `gongiskhan/ios-certificates`** (exists, private, empty).
  `agent-garrison` is PUBLIC, so signing assets must not live on a branch of
  it — that is the entire reason not to copy ios-thing's
  same-repo-branch arrangement. A fresh `MATCH_PASSWORD` is generated and
  sealed at M8.
- The lane must also run LOCALLY on this Mac (Xcode 26.2 present), not only in
  CI: `npm run ios:testflight` wraps `bundle exec fastlane beta` with env
  sourced from the environment. Team id is known (N3AN3Z32JN, recon);
  a candidate ASC key exists locally (`AuthKey_58TCW7N893.p8`); missing
  issuer id / key mismatch at M8 is the one legitimate mid-run stop, asked
  precisely.
- The stale feature-branch push trigger from ios-thing's workflow is not
  copied.

## 10. Coordination note

The spec's `begin_planning` / `declare_intent` coordination tools are not
present in this session's toolset; the fallback discipline applies (disjoint
files, prompt commits, never `git stash`/`git checkout --`/whole-tree ops).
Files this run touches: `ios/**` (new), `fittings/seed/capture-service/**`
(new), `data/library.json` (+1 entry), `compositions/default/apm.yml`
(+1 channels selection, flags off), `omi-channel/lib/triage.mjs` +
`lib/scheduler-jobs.mjs` + `lib/notify.mjs` (M4/M5, behind flags),
`tests/capture-service*.test.ts` + `tests/companion-lockstep.test.ts` (new),
`package.json` (two scripts), repo docs.
