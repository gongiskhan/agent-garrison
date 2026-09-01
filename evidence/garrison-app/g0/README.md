# G0 - recon and decisions

Run: Garrison app plan, September 2026. Branch `node/goncalos-macbook-pro`.

## What was verified

- `xctest-baseline.log` - `xcodebuild test` of the current `ios/` project
  (scheme `GarrisonApp`, iPhone 17 Pro simulator, iOS 26.2) on
  goncalos-mac-mini-1 from a fresh build clone of this branch:
  78 tests, 0 failures. The MacBook Pro node has no Xcode, so XCTest runs on
  the mini over ssh for every later gate too.
- `recon-environment.json` - round-1 reader output: iOS project map
  (targets, entitlements, Info.plist, fastlane lanes, Capacitor availability
  through capacitor-swift-pm 8.5.1), toolchain per machine, TestFlight path
  (`gongiskhan/ios-thing` workflow `garrison-ios.yml`), tailnet serve map of
  this node, vault key NAMES present in `compositions/default/.env`
  (values never read).
- `recon-round2.json` - round-2 reader output, six narrow readers, every fact
  with a file:line: shell seams, voice contract (deepgram-voice,
  capture-service, dev-env), web-channel-default server and UI, docs / tests /
  roadmap seams, capture-service internals, omi-channel + screen-share +
  gateway.

## Where the results live

- Decisions, stale-premise table, recon facts and the per-gate file list:
  `docs/decisions/2026-09-garrison-app.md`.
- Nothing in the working tree changed in G0 beyond that file, this directory
  and the `.gitignore` carve-out that versions `evidence/garrison-app/`.

## Gate status

G0 green: decisions file written, XCTest baseline passes, per-gate file list
recorded (section 4 of the decisions file).
