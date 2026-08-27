# Pendant Direct - Mac mini handoff

> **DONE 2026-08-20, except the two human steps.** The Mac mini session ran
> and everything Xcode-gated below is now green: `xcodegen generate` clean,
> `xcodebuild test` **52 tests / 0 failures / TEST SUCCEEDED** (Xcode 26.2,
> iPhone 17 on iOS 26.2 - there is no iPhone 16 runtime on this box), and
> `swift build -c release` for the emulator, which then advertised over real
> Bluetooth. Three fixes were needed; none was the predicted
> CoreBluetoothMock API drift, and one was a REAL transport bug the harness
> caught (ADR D17). What remains is only what a human with a phone can do:
> HUMAN_SETUP sections 9c and 9d. Details in
> [`pendant-direct-report.md`](./pendant-direct-report.md); the rest of this
> document is kept as the record of what the session was asked to do.

The continuation brief for finishing Pendant Direct on the Mac mini (the
machine with Xcode). The MacBook stays Xcode-free by decision; everything
that does not need Xcode is already done, verified, and pushed. This
document is self-contained: read it plus the three companion documents and
you have the full picture.

- Protocol truth: [`pendant-protocol.md`](./pendant-protocol.md)
- Decisions D1-D16: [`adr-pendant-direct.md`](./adr-pendant-direct.md)
- Final report + measured latencies: [`pendant-direct-report.md`](./pendant-direct-report.md)
- Operator setup and the real-device script:
  `fittings/seed/capture-service/HUMAN_SETUP.md` section 9
- Operations: `fittings/seed/capture-service/RUNBOOK.md` (Pendant Direct
  section)

## State as of commit 3cf2b5e5 (2026-08-20)

Verified and done:

- Garrison side complete: pendant session mode, capture_policy
  (wake_only | ambient), pendant wake identity, FeedbackBus + interim wake
  watcher, latency metrics, replay client pendant dialect, e2e:pendant.
  Full remote suite green on dev-madrid: 5983 tests / 525 files, omi and
  companion suites untouched.
- iOS app COMPILES AND SHIPS: the ios-thing CI lane (run 32377268024)
  built GarrisonApp + BroadcastExtension with the complete pendant layer
  on a hosted Xcode runner and uploaded the build to TestFlight. So every
  SHIPPING Swift source is compile-verified.
- The OTA emulator builds and runs (verified on the MacBook via the
  build.sh swiftc fallback).

NOT yet done at the time this brief was written - all three are now
resolved except the human steps in item 3:

1. The iOS simulator TEST suite has never run: the test target (and only
   the test target) has never been compiled. That includes the new
   PendantHarnessTests / PendantFixtureTests / MockPendantTransportTests /
   PendantFeedbackMappingTests, the CoreBluetoothMock layer
   (PendantMockPeripheralTests + the PENDANT_MOCK_BLE branch of
   PendantBLETransport.swift), and the six pre-existing suites against the
   changed Shared/ sources.
2. `swift build` for tools/pendant-emulator via SPM proper (the swiftc
   fallback works; SPM is untested because the MacBook's CLT SwiftPM is
   broken).
3. The emulator rehearsal with a real iPhone, then the real-device script
   (human steps, HUMAN_SETUP section 9c/9d).

## Mac mini session: exact steps

Prerequisites: Xcode with the iOS platform installed, an iOS simulator
runtime, `xcodegen` (brew install xcodegen), network for SPM resolution,
and this repo at main (>= 3cf2b5e5).

```bash
cd ios
# Team id only matters for device signing; simulator tests don't sign.
# Real team id if you have it in the env: N3AN3Z32JN.
APPLE_TEAM_ID=${APPLE_TEAM_ID:-N3AN3Z32JN} xcodegen generate

# Pick an available simulator: xcrun simctl list devices available
xcodebuild test \
  -project Garrison.xcodeproj \
  -scheme GarrisonApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO
```

Then the emulator (from repo root):

```bash
cd tools/pendant-emulator
swift build -c release        # SPM path; bash build.sh is the fallback
./.build/release/pendant-emulator
```

Definition of done for the session:

1. xcodegen generates cleanly, resolving the new CoreBluetoothMock package
   (test target only - check the app target gained no package dependency).
2. xcodebuild test green: all six pre-existing suites plus the four new
   pendant suites.
3. The emulator builds via SPM and runs.
4. Any fixes committed with plain descriptive messages and pushed to main;
   update the "Verification state" section of pendant-direct-report.md
   (and add ADR entries for any non-obvious decision).
5. Hand the human HUMAN_SETUP section 9c (emulator rehearsal with the
   iPhone) and 9d (the real-device script).

## What will most likely need fixing, in order of likelihood

1. **PendantMockPeripheralTests.swift and the PENDANT_MOCK_BLE branch of
   `ios/GarrisonApp/Pendant/PendantBLETransport.swift`.** Both were
   written against Nordic CoreBluetoothMock 0.18+ from documentation and
   have never seen a compiler. Expect API-name touch-ups: the
   `CBMPeripheralSpec.simulatePeripheral().advertising().connectable()`
   builder argument labels, `CBMATTError(...)` construction,
   `CBMAdvertisementDataIsConnectable`, the `CBMPeripheralSpecDelegate`
   method signatures, whether `CBMUUID` exists or plain `CBUUID` is used,
   and the typealias block at the top of PendantBLETransport.swift
   (ADR D13 explains the recompile-with-aliases design). Fix the shim and
   the test file, never the production CoreBluetooth branch, unless a
   genuine bug surfaces.
2. **Shadowing ambiguity.** The test target compiles its own copy of
   PendantBLETransport.swift (project.yml adds the file to GarrisonTests
   with SWIFT_ACTIVE_COMPILATION_CONDITIONS PENDANT_MOCK_BLE) while also
   doing `@testable import GarrisonApp`. If Swift reports an ambiguous
   `PendantBLETransport` (or ambiguous Shared types like PendantUUID used
   by the local copy), the intended resolution order is local-module-wins;
   if the compiler disagrees, qualify references in the tests or exclude
   the app-module symbol via a typealias. Worst case, rename the
   recompiled class with a `#if PENDANT_MOCK_BLE` alias.
3. **MockPendantTransport timing tests.** They run at speed 50 with
   generous expectations, but they are first-run timing tests on a new
   box; if one flakes, widen the script's timeline (not the assertions).
4. **New Shared code under the app's Swift settings.** Everything
   typechecked under the CLT on macOS, and the app target already built in
   CI, so surprises here should be limited to the test target's stricter
   Debug settings, if any.

## Ground rules carried over (do not relearn these the hard way)

- The wake gate is token-anywhere BY DECISION (2026-08-13, operator call);
  never reintroduce a vocative/address-position rule.
- `wake.mjs` (and five other lib files) are byte-identical lockstep copies
  between omi-channel and capture-service, pinned by
  tests/companion-lockstep.test.ts. Edit the omi original, cp across.
- Node-side validation never runs on a Mac: `make remote-check` snapshots
  the worktree to dev-madrid (needs the SSH setup in
  docs/REMOTE_MAC_WORKFLOW.md). iOS-side fixes should not touch node code;
  if one does, validate remotely before pushing.
- Fixture generation is Mac-local by design (`say` + ffmpeg):
  capture-service scripts/make-pendant-fixtures.sh is additive; the four
  original fixtures must stay byte-identical.
- No new git branches; work lands on main; plain commit messages, no
  AI attribution or co-author trailers, hyphens only in docs.
- Do not run `npm run prod:redeploy` from an agent session; the human
  lands prod. All pendant flags default off, so prod is behaviorally
  unchanged until then anyway.

## Live-loop smoke after tests are green (optional but recommended)

The prod capture service is reachable at
`https://dev-madrid.tail31efa.ts.net:8498` (tailnet serve for port 8097).
For a live phone test WITHOUT touching prod config, run a dev-profile
instance instead, or wait for the human to redeploy and set
`pendant_enabled: true` (+ `capture_policy`) on the composition. The
Companion needs its base URL + CAPTURE_TOKEN in Settings (HUMAN_SETUP
section 5); the Pendant screen reads the policy from /health and shows
whether the server-side flag is on.
