# G7 - the pendant through the plugin, mock first (2026-09-02)

Decision D44 in `docs/decisions/2026-09-garrison-app.md`; ADR D19 in
`docs/adr-pendant-direct.md`; plugin surface in `docs/pendant-protocol.md`
section 10.

## What shipped

- `ios/GarrisonApp/Plugins/GarrisonPendantPlugin.swift`: a test-only
  `controllerOverride` seam; every controller use goes through it, production
  resolves to `PendantController.shared` (the ownership source check in
  `PendantFeedbackMappingTests` still passes).
- `ios/Tests/PendantPluginMockTests.swift`: the mock harness. A
  `PendantController` on `MockPendantTransport`, driven through the plugin's
  Capacitor methods and listeners: status before connect, connect reaching
  `connected` through `pendantState` with battery 87 on `pendantBattery`,
  disconnect staying paired, forget dropping the pairing, lost frames in the
  payload, ambient consent mirrored from the app group.
- `packages/talk/src/router.mjs`: `GET /api/voice/sessions/<id>/events`
  relays capture-service's live session stream (interim and final segments,
  then `{"done":true}`) through the shell. Bad ids are 400; no provider 503;
  an upstream error becomes an SSE `event: error` frame.
- `src/components/capture/CapturePage.tsx`: the pendant section reads the
  plugin's real vocabulary (`connectionState`, `paired`, `lostFrames`,
  `uploaderState`, `battery`, `sessionId`), offers Pair/Connect, Disconnect
  and Forget, and shows a "Hearing" panel fed by the relay while a session
  is live. Fixed on the way: the page read `status.state`, a key the plugin
  never emits, so a real phone would have shown "reading" forever.
- `src/lib/native-bridge.ts`: `PendantStatus` matches `statusPayload()`.

## Evidence

- `xctest-mock-run.log`: `PendantPluginMockTests` 6/6 on the mini's simulator
  (`TEST SUCCEEDED`).
- `vitest-targeted.txt`: talk-voice-router (24, five for the relay),
  capture-page and native-bridge suites, 37/37.
- `playwright-capture-page.txt`: `tests/e2e/capture-page.spec.ts` 8/8 on
  desktop-chromium and mobile, including the connected-pendant flow with a
  fulfilled relay stream.
- `typecheck-reload.txt`: `tsc --noEmit` clean; `npm run node:reload` exit 0.
- `live-relay-probe.txt`: over the tailnet, an unknown session id comes back
  as `text/event-stream` with `event: error` / `upstream 404`; a short id is
  400 `bad session id`.
- `testflight.txt`: the beta build kicked off after this gate.

## Finding worth keeping

A `CAPPlugin` built with a bare init has nil `eventListeners` and
`retainedEventArguments`; only the bridge's `load(on:)` creates them, and
`notifyListeners` silently drops every event without them. Any plugin test
harness must set those tables (and `pluginId`/`pluginName`) before `load()`.

## Not in reach here

No pendant hardware on this desk during the run. The phone criterion for G7
(pair, connect, forget and the "Hearing" transcript with the real device on
a real phone) is the operator's, listed in `HANDOFF-garrison-app.md`.
