# ADR - Pendant Direct

Decision record for the Pendant Direct task: Companion BLE capture of the
Omi pendant, Garrison-owned transcription, and tiered device feedback.
One entry per non-obvious decision, in the order they were taken. The
protocol findings live in [`pendant-protocol.md`](./pendant-protocol.md).

## D1 - Xcode absent at P0 start: proceed with everything Xcode-free instead of a full stop

2026-08-20. The environment precondition check found no Xcode on this
machine (xcode-select resolves to CommandLineTools, `simctl` absent, no
Xcode.app on any volume; only the CLT Swift 6.1.2 toolchain exists,
although /Library/Developer/CoreSimulator residue shows Xcode was
installed at some point). The brief permits an immediate stop for this
case, but the operator's session policy rejected the stop, and the brief
already prescribes a better pattern for its other blocker class (missing
signing assets): finish absolutely everything else first, then list the
exact missing items in HUMAN_SETUP. That pattern is applied here.
A non-interactive install was attempted and is not possible: `mas
install 497799835` requires sudo, and sudo needs a password on this
machine. Decision: all Xcode-independent work proceeds (audit, protocol
research, fixtures, the Garrison-side capture path, wake/window wiring,
feedback bus, e2e, and authoring all Swift sources); `xcodebuild` compile
and simulator test runs are deferred until Xcode is present, and the
exact one-line human step is listed in HUMAN_SETUP. Swift sources are
written to compile cleanly and are validated the moment Xcode lands.

## D2 - Fixture TTS and codec toolchain

2026-08-20. The machine has `say` with Joana (a true pt_PT European
Portuguese voice) plus English voices, ffmpeg with libopus encode and
decode, sox, python3, and node 20. Decision: wake fixtures are generated
with `say` (Joana for Portuguese, a standard English voice for English),
resampled and Opus-encoded through ffmpeg to the pendant codec
parameters documented in `pendant-protocol.md`, so the full decode path
is exercised without paid dependencies. This satisfies the brief's
preference order and adds nothing to the dependency set.

## D3 - Audit outcome: the brief's premises are partly wrong; the repo wins

2026-08-20. The Phase 0 audit (nine parallel readers over the repo and
the BasedHardware/omi sources) found the repo ahead of the brief on
three premises, and per the autonomy contract the repo wins each time.
(1) There is no vocative-position wake rule: an address-position gate
was built with the Zeca rename and removed the same day (2026-08-13,
commit 5d510fb4) on the operator's call; the live gate is token-anywhere
on word boundaries, pinned by tests that explicitly say the
anywhere-match is not an oversight. Pendant Direct reuses the gate
exactly as it is and does not reintroduce position rules. (2) The
companion capture service is not a partial spec - it is a complete,
tested build (websocket ingress with Bearer token auth, framed media
with per-stream contiguous acks and resume, session store, Deepgram
live client pinned to nova-3 language=pt with keyterms, wake bus,
triage integration, real APNs sender with sealed production keys,
spoken-ack sink, replay client, mocked all-flags-on e2e). Everything
here is extension, not construction. (3) The wake audio fixtures were
never recorded saying "Gary": they were synthesized on 2026-08-13,
post-rename, by make-fixtures.sh speaking "Zeca" natively (verified
back to their first commit). No regeneration is owed; this task ADDS
pendant-specific fixtures (multi-utterance window sequences, true
near-misses under the anywhere-gate, malformed BLE frames) instead.
Also noted: the omi suite is now 134 tests across nine files, not 75;
it stays green untouched either way.

## D4 - Device feedback is haptic patterns; the stock surface is sufficient

2026-08-20. Protocol research (docs/pendant-protocol.md section 6)
established that the consumer Omi CV1 has NO speaker (speaker exists
only on the DevKit2 build, as a fragile 312 ms one-shot PCM uploader no
production client uses) and one app-triggerable output: a 1-byte haptic
write (0x01/0x02/0x03 mapping to 100/300/500 ms on CV1) on
CAB1AB96-2EA5-4F4D-BB56-874B72CFC984. Patterns are composed app-side by
spacing writes, exactly as the upstream app does. Decision: the brief's
"device speaker" sink is implemented as a haptic sink with this tier
mapping - wake_detected: one short pulse (level 1); segment_captured:
one short pulse (level 1, shared with wake per the brief's allowance);
window_closed: double pulse (level 2, 2 writes 250 ms apart);
task_created: confirmation pulse (one long, level 3); task_failed: low
triple (level 2, 3 writes 350 ms apart). window_closed (double medium)
and task_created (single long) remain clearly distinguishable. The
five-tier design fits the stock surface, so per the brief's own rule no
custom-firmware proposal document is written. Capability discovery is
optimistic: read the features bitmask (CV1 only), treat a failed read
as 0, and fall back to try-and-swallow on the haptic write, mirroring
upstream. The Companion additionally carries all five tiers as local
sounds/haptics, so a haptic-less DevKit1 degrades to phone-only.

## D5 - The pendant rides the existing capture ingress as a new session mode

2026-08-20. The Companion relays pendant audio over the EXISTING
/capture/stream websocket protocol: reassembled Opus packets (the BLE
3-byte header stripped, exactly one codec frame per binary frame) sent
as kind-0 media frames with the existing 17-byte header, spooled and
resumed through the same App Group SessionSpool the mic path uses. A
pendant session is a session_start with mode "pendant" - additive to
the mode enum ("audio" | "screen_audio"), leaving the malformed-session
refusal of "always_on" and every mic-session behaviour untouched. The
server keeps never decoding audio (Deepgram accepts the raw Opus
packets regardless of 10 ms devkit or 20 ms CV1 framing). Gating: a new
pendant_enabled flag (default false) refuses pendant-mode session_start
independently of the companion flags (I7); the omi channel's flags are
untouched (I3).

## D6 - capture_policy applies to pendant sessions only; no-ambient survives

2026-08-20. The repo actively forbids ambient capture for the iPhone
mic app (COMPANION_IOS_SPEC: "the app never records outside a session.
No ambient mode exists, even behind a flag") while stating that
"continuous ambient capture stays with the pendant" - which is
precisely the surface this task builds. Reconciliation: capture_policy
(wake_only | ambient, default wake_only) is a capture-service config
key that is READ ONLY for mode:"pendant" sessions. Mic sessions
(audio/screen_audio) are deliberate start/stop captures and keep
today's always-persist behaviour, unchanged. For pendant sessions under
wake_only: audio bytes are NOT written to the media log (the ordered
stream keeps its seq/ack/reorder discipline against an in-memory high
water), finalized transcript segments are NOT persisted and NOT logged
with content (counters only), no session capture_event is emitted, and
the only persistence is the wake path itself (wake_command events,
wake-results, cards). Under ambient: today's persistence path runs
(media log, transcript, one session capture_event into the shared
triage tick under its existing one-model-call cost gate). The policy is
enforced at the single persistence seam (the media persist hook +
transcript flush + emitSessionEvent call site), tested for both values.
Known trade-off, accepted: under wake_only a server restart loses the
in-memory high water, so a resuming client may re-send spooled frames;
re-fed audio re-transcribes transiently and card-level dedupe
(origin_id + resolved-title window) still holds. Consent: ambient
requires the stronger one-time Companion notice with a persisted
acknowledgement before a pendant session may start under that policy.

## D7 - Pendant identity: source "pendant"; one inert wake-bus lifecycle hook

2026-08-20. Everything the pendant stream produces carries source
"pendant" through the existing source-agnostic seams: a
PENDANT_WAKE_SOURCE bag (originPrefix "pendant", thread
"pendant-reports", provenance key pendant_session_id) passed to the
same byte-identical WakeBus, and an additive "pendant" entry in
omi-channel's TRIAGE_SOURCES plus the pendant branch in the triage
tick's per-source memory/notify routing - additive per I10, no omi
behaviour change per I3 (unknown sources still fall back to omi
identity exactly as before). Cards created from pendant wake get origin
"pendant", origin_id "pendant:wake:<eventId>", and provenance in the
description, matching the omi/companion pattern. The five feedback
events (wake_detected, segment_captured, window_closed, task_created,
task_failed) do not exist anywhere today (events.mjs is a capture_event
emitter, not a bus), so they are new: a small feedback emitter in
capture-service, fed by ONE additive, optional constructor hook
(default null) on the shared WakeBus that reports window lifecycle and
card outcomes. The hook is inert when absent, omi-channel never passes
it, both lockstep copies are updated in the same commit, and the omi
suite must stay green to prove I3.

## D8 - Wake feedback fires on interims; the WakeBus stays finals-only

2026-08-20. The capture-service wake bus deliberately consumes final
segments only (interims never reach the gate). Changing that would
alter shared-module semantics, so the latency requirement is met beside
it: a lightweight interim watcher in capture-service runs the same
wakeRegex over Deepgram interim results and fires wake_detected (the
feedback event and haptic) at most once per wake window, while command
assembly, close semantics, and dispatch continue to run on finals
through the untouched WakeBus. The watcher is feedback-only - it
persists nothing and creates nothing - so a false interim hit costs one
haptic pulse, never a card. wake_to_device_ack_ms is measured from the
interim wake hit to the Companion's feedback receipt
(type "feedback_ack" on the session socket, carrying the device write
timestamp); card_commit_to_created_ack_ms from board.createCard success
to the same receipt for task_created. Both recorded through the
existing counters.observe mechanism and surfaced on /health. If the
mock e2e shows the wake target unreachable through the server path, the
measured number goes in the report with an ADR entry proposing on-phone
keyword spotting as future work (per the brief; no new services now).

## D9 - No BLE offline-storage sync in this task

2026-08-20. The pendant's storage service (three protocol generations,
documented in pendant-protocol.md section 8) is not implemented. The
Companion's App Group spool already guarantees nothing is lost across
NETWORK drops, which is the brief's stated requirement; BLE-side gap
recovery (audio missed while the phone was away from the pendant) is a
distinct feature with its own sync-and-dedupe design, out of scope
here. The protocol knowledge is recorded so a later task starts warm.

## D10 - Execution order adapted to the missing Xcode

2026-08-20. Garrison-side work (fixtures, capture-service extensions,
wake wiring, feedback bus, replay client, e2e) is fully verifiable via
make remote-check without Xcode, and the OTA emulator plus shared Swift
protocol code build with the Command Line Tools SwiftPM alone. So the
phases execute in the order P0, P1 (fixtures + Garrison harness), P3,
P4, P5 server side, P6 emulator, then the iOS work (P2, Companion UI,
P5 phone side) authored throughout but compiled and tested the moment
Xcode lands, then P7, P8. Phase numbering in reports keeps the brief's
names. House rule respected throughout: npm/vitest runs happen on
dev-madrid via make remote-check (this Mac has no node_modules by
design); fixture generation stays a Mac-local system-tool job exactly
like the existing make-fixtures.sh.

## D11 - CoreBluetoothMock is a test-only SPM dependency

2026-08-20. The repo's iOS app deliberately has zero third-party
frameworks. The CoreBluetoothMock harness (layer 2 of the mock stack)
requires Nordic's CoreBluetoothMock package; it is added via XcodeGen
as a dependency of the TEST target only, so the shipping app targets
keep their zero-dependency property. The in-process MockPendantTransport
(layer 1) and the OTA emulator (layer 3) use no third-party code.

## D12 - e2e:pendant follows the companion-e2e shape

2026-08-20. The Garrison-side end-to-end test boots startServer()
in-process with a sandboxed GARRISON_HOME, mock Deepgram
(GARRISON_CAPTURESERVICE_DG_URL), mock APNs, stub gateway and stub
board - the proven companion-e2e pattern - with every pendant flag on.
The phone-plus-pendant side is played by the extended replay client
(scripts/replay-client.mjs gains --mode pendant, feedback handling, and
a haptic write log with timestamps), so the full loop - fixture audio
in, policy-correct persistence, exactly-one wake, window timings, card
with origin pendant, all five feedback events, tier sequence and
latency assertions from the recorded haptic log - runs from a clean
sandbox with zero real externals, as npm run e2e:pendant. The iOS-side
equivalents run under xcodebuild test with MockPendantTransport.
