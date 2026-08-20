# Pendant Direct - final report

2026-08-20. The Pendant Direct build: the Garrison Companion owns the Omi
pendant over BLE, Garrison transcribes with its own Deepgram pipeline, the
wake word and capture window run over that stream, and the wearer gets
tiered haptic feedback on the device, the phone, and the Companion UI. The
Omi cloud path is untouched behind its existing flags; handing the device
back to the Omi app is a Bluetooth reconnect.

Companion documents: protocol notes in [`pendant-protocol.md`](./pendant-protocol.md),
decisions in [`adr-pendant-direct.md`](./adr-pendant-direct.md), operator
setup in `fittings/seed/capture-service/HUMAN_SETUP.md` section 9, operations
in `fittings/seed/capture-service/RUNBOOK.md` (Pendant Direct section).

## What was built, per phase

- P0 Audit + protocol research. Nine parallel readers over the repo and the
  BasedHardware/omi sources. Headline finding: the brief's premises were
  partly stale - the capture service was already a complete tested build,
  the wake gate is deliberately token-anywhere, and the audio fixtures
  already spoke "Zeca". Deliverables: pendant-protocol.md (GATT profile,
  3-byte framing, codec table, the haptic-only feedback surface with
  firmware citations, connection lifecycle patterns), ADR D1-D12.
- P1 Fixtures + mock harness layer 1. Five new fixtures (pt/en
  hello-garrison wake phrases, a true near-miss, the bare wake word, a
  17 s multi-utterance window sequence) via the additive
  make-pendant-fixtures.sh; the original four stayed byte-identical. Shared
  Swift pendant layer: protocol constants, BLE framing + drop-on-gap
  reassembler, the DeviceTransport abstraction, fixture loader, and
  MockPendantTransport (real cadence, scripted disconnect/reconnect,
  malformed/out-of-order/dropped packets, low battery, recorded haptic
  writes) with its XCTest self-suite.
- P2 Companion BLE layer. PendantBLETransport: service-filtered scan,
  connect-by-retrieval, fixed 200 ms chipset-level reconnect, pairing-lost
  terminal, state restoration, ready-when-all-services-discovered, CCCD
  re-arm plus a 4 s audio liveness watchdog after reconnect, normalized
  UUID keys, pending completions failed on disconnect. Layer 2 of the
  harness recompiles this exact file against Nordic's CoreBluetoothMock
  (test target only) with a scripted pendant peripheral.
- P3 Capture path. Session mode "pendant" on the existing websocket
  ingress behind its own pendant_enabled flag; capture_policy
  (wake_only default | ambient) enforced at the media-persist and
  transcript-flush seams; transient SessionMedia keeps the full
  seq/ack/reorder discipline with zero disk writes; the session record
  itself is not persisted under wake_only.
- P4 Wake + window on the pendant stream. The byte-identical WakeBus reused
  with a pendant source bag (source "pendant", origin pendant:wake:<id>,
  thread pendant-reports); an additive TRIAGE_SOURCES entry and triage-tick
  routing for ambient sessions; one inert optional lifecycle hook added to
  the shared wake module (omi passes nothing; both lockstep copies updated
  together; the omi suite is green and untouched behaviorally).
- P5 Feedback. FeedbackBus with the five lifecycle events, per-window
  wake dedupe, and ack-based latency accounting; an interim wake watcher
  fires the wake_detected feedback early (feedback-only - the authoritative
  window stays on finals); events push to the session socket as
  {type:"feedback"} and the app acks each on its first physical haptic
  write. Device tiers are haptic patterns from the three fixed firmware
  levels (the consumer pendant has no speaker - protocol doc section 6);
  the phone carries all five tiers via foreground generators/sounds and
  background local notifications; the Companion Pendant screen shows the
  live feedback strip and the SSE live transcript.
- P6 Over-the-air emulator. tools/pendant-emulator: CBPeripheralManager
  advertising the real GATT profile, fixture streaming at cadence, haptic
  write printout, interactive button/battery scenario commands. Builds and
  runs on the current Mac today (CLT swiftc fallback; SPM once Xcode
  lands). Two-minute rehearsal procedure in its README.
- P7 Full e2e. npm run e2e:pendant - a clean sandbox, every pendant flag
  on, externals mocked, the phone+pendant played by the real replay client
  at real 20 ms cadence. Scenario matrix: wake-to-card with tier sequence
  and latency targets, true near-miss, duplicate segments, mid-window
  disconnect with resume, ambient policy, and the unacked-feedback
  fallback.
- P8 Ship. Remote suite green (typecheck + 5983 tests / 525 files,
  including the untouched omi and companion suites). Operator docs and this
  report. TestFlight staging per the signing section below.

## Every ADR decision in one list

D1 Xcode absent: proceed with everything Xcode-free, list the human step.
D2 Fixtures via say (Joana pt_PT) + ffmpeg libopus, 20 ms frames.
D3 The repo beat the brief: token-anywhere gate, complete capture service,
Zeca-native fixtures - reuse, do not rebuild or regress.
D4 Device feedback is haptic patterns; the stock surface suffices, so no
custom-firmware proposal exists (per the brief's own rule).
D5 The pendant rides the existing capture ingress as mode "pendant".
D6 capture_policy applies to pendant sessions only; the companion mic app's
no-ambient invariant survives; wake_only persists nothing but the wake path.
D7 Source "pendant" end to end; one inert lifecycle hook on the lockstep
wake module; additive triage identity.
D8 Wake feedback fires on interims; the WakeBus stays finals-only; a false
interim hit costs one haptic pulse, never a card.
D9 No BLE offline-storage sync in this task (protocol documented for later).
D10 Execution order adapted to the missing Xcode; vitest runs on dev-madrid
per the house rule; the CLT SwiftPM is broken so even swift test waits.
D11 CoreBluetoothMock is a test-target-only dependency.
D12 e2e:pendant follows the proven companion-e2e shape.
D13 Harness layer 2 recompiles the real transport under PENDANT_MOCK_BLE.
D14 Phone tiers: foreground generators + sounds, background local
notifications; no new push infrastructure.
D15 The feedback ack rides the first physical device write.
D16 Deliverable docs live in the fitting's HUMAN_SETUP/RUNBOOK + docs/.

## Measured latencies

The e2e wake-to-card run on dev-madrid (real 20 ms fixture cadence, mock
STT timed to real nova-3 behaviour - the interim carrying the wake word
~1.1 s into the utterance, the punctuated final ~1.9 s). The feedback log
of that run, verbatim (the device-write log the brief asks the report to
include; offsets are from stream start):

```
session session_started
audio streamed: last ack 197 of 197
feedback +1465ms: wake_detected [interim]
feedback +2611ms: window_closed (silence)
feedback +2847ms: task_created card 01CARD0001
wake_to_device_ack_ms: 6
card_commit_to_created_ack_ms: 14
no session record stored - the wake_only capture policy at work (expected default)
every packet acked
```

- wake_to_device_ack_ms: 6 ms from the interim wake hit to the client's
  device-write receipt (target < 1500, asserted on every run). Wearer-felt
  wake latency is dominated by STT interim emission - the pulse lands
  ~1.5 s after stream start for a word spoken ~1 s in.
- card_commit_to_created_ack_ms: 14 ms from board-create success to the
  receipt (target < 2000, asserted on every run).
- Wake-hit-to-notification (the whole spoken-command leg through the mock
  classifier): 476-703 ms across the captured runs.

The e2e prints this block into its own output on every run (the
`[e2e:pendant wake-to-card]` marker in the vitest stdout); the tier
sequence asserted is wake_detected [interim] -> window_closed ->
task_created, with segment_captured covered in tests/pendant-capture.test.ts.

## Verification state

- Garrison side: fully verified. make remote-check green - typecheck plus
  the full vitest suite (5983 passed / 38 skipped), including the omi
  channel suites (untouched), the companion suites (one additive /health
  flags assertion extended), the new pendant-capture, pendant-e2e, and
  lockstep suites.
- iOS side: all Foundation/CoreBluetooth sources typecheck under the CLT;
  the app cannot compile locally until Xcode is installed (HUMAN_SETUP
  section 9a has the one-line step). The TestFlight CI lane in the private
  ios-thing repo (which holds the signing secrets) builds agent-garrison
  main on a hosted macOS runner and is the compile-verification and ship
  vehicle until then; xcodebuild test (harness self-tests, transport
  against the scripted peripheral) runs the moment Xcode lands.
- Emulator: builds and runs on the current Mac (verified).

## Known gaps

- The speaker surface: the consumer pendant has no speaker at all; DevKit2's
  is a 312 ms one-shot demo path. Feedback is haptic-only on the device by
  design (D4) - the brief's beep semantics map to pulse patterns.
- The CoreBluetoothMock layer compiles only under Xcode; its API surface was
  written against 0.18+ and may need one touch-up round on first build.
- Under wake_only, a server restart forgets the in-memory high water; a
  resuming client re-sends spooled frames, which re-transcribe transiently
  (D6 trade-off; card dedupe holds).
- On-phone keyword spotting (sub-second wake pulses independent of STT
  interims) remains future work per the brief; the measured server-path
  numbers above did not justify proposing it now.
- Kanban's notify-origin CHANNEL_FITTINGS has no companion or pendant entry
  (a pre-existing gap the audit surfaced): card lifecycle transitions reach
  the phone through the ack fan-out and APNs, not through the origin-thread
  door. Unchanged by this task.
- Pre-existing flake surfaced during validation, unrelated to this work:
  tests/browser-persistent-profile.test.ts ("leaves no chromium behind")
  failed once in three otherwise-identical full-suite runs, with the whole
  chromium tree still alive 60 s after the browser fitting's server exited
  under heavy load - which suggests the shutdown path's Browser.close /
  child-kill escalation can lose track of the chromium process entirely,
  not just run slow. Left unpatched deliberately: the shutdown code guards
  login-continuity semantics this task did not audit, and a blind fix
  could not be verified. Worth its own card.
