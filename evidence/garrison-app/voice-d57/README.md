# D57 evidence: the pushed answer shows in-app; a triage-only answer is spoken

Node side of the 2026-09-04 06:15Z hit (`~/.garrison/capture/wake-results/01M1NGXWH40Z9H66RVCAGENM2E.json`
on this Mac): `intent: conversation_turn`, `conversation_id: chat-mtmk7lbe-efclxz`,
three frames, `delivery: push`; `reply.duty: triage`, `reply.delivery: push`.
capture-service log: `wake reply 01M1NGXWH40Z9H66RVCAGENM2E -> triage (700 chars, push)`.
APNs accepted the push (200). A test push sent from this Mac with
`POST http://127.0.0.1:8097/notify` (tag `ask`) reached the phone with the app
in the background; the user confirmed it ("i see the push now"). Pushes that
arrived with the app in front on the conversation showed nothing: Capacitor's
`NotificationRouter` was the `UNUserNotificationCenter` delegate
(`handleApplicationNotifications` defaults to YES) and completed `willPresent`
with no presentation options.

- `vitest.txt`: `tests/talk-capture-feedback.test.ts`, 7 tests green, with the
  new idle-fallback cases (`settleCaptureIdle`) and `describePushStatus`.
- `npx tsc --noEmit`: the only error is in another agent's uncommitted
  `tests/capture-service-pronunciation-aliases.test.ts` (missing declaration for
  a new `.mjs`), none in the D57 files.
- The native half (`ios/`) is verified by `ios/Tests/BridgePluginRegistryTests.swift`
  `testBridgeLeavesNotificationsToPushManager` on the mini's XCTest run and by the
  phone check in `HANDOFF-garrison-app.md` item 3e once the TestFlight build from
  the D57 commit is installed.
