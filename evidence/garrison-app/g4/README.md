# G4 - capture page, node switching, APNs deep links

Evidence for gate G4 of the Garrison app plan (docs/decisions/2026-09-garrison-app.md,
decisions D35, D37-D39). The gate gives the app its own surface inside the shell
(`/capture`, rendered only when the native bridge is present), replaces the
sidebar's node badge with a switcher that works in a browser and in the app, and
closes the push loop: capture-service now sends an in-app route (`data.path`)
beside the absolute link, and the shell follows it when the app relays a tap.

| file | what it proves |
|---|---|
| `vitest.txt` | the full vitest run on the G4 tree (sidebar grouping, node-switch URL building, capture-service APNs payload with `path`) |
| `playwright-capture.txt` | `tests/e2e/capture-page.spec.ts`: a browser sees the fallback and no Capture menu entry; a stubbed `window.Capacitor` renders the native panel and the entry |
| `xctest.log` | `xcodebuild test` on the mini: 91 tests, 0 failures, including the new `PushRoutingTests` (`data.path` wins, flat `path` accepted, non-shell paths dropped) |
| `sim-capture-page.png` | the app (iPhone 17 Pro simulator, seeded node) landed on `/capture` through the COLD-START route lane (`GARRISON_OPEN_PATH`, a DEBUG seam that queues the path in `PushRouter` exactly as a push tap on a closed app does): node, recording, notifications, pendant sections over the live node, crumb clear of the status bar |
| `testflight.txt` | the dispatch of the TestFlight workflow and its outcome |

Not captured on the simulator: the switcher dropdown open (no tap automation
on the mini; the browser half is covered by the e2e spec and the app half by
the operator step below).

## Shell

- `src/lib/native-bridge.ts` is the ONLY reader of `window.Capacitor`: typed
  facades for the five plugins, `isNativeApp()`, and `isShellPath()` (the same
  rule `PushRouter.swift` applies before a route reaches the page).
- `src/components/capture/BridgeGate.tsx` decides "native or not" after mount,
  in one place; `CapturePage.tsx` hangs the four sections off it. A browser gets
  one line pointing at the record button in Conversations.
- `src/components/chrome/NodeSwitcher.tsx` replaces `NodeBadge` in the sidebar.
  It reads `/api/mesh/nodes` on open; in a browser a row navigates to the same
  path on the peer's tailnet host (`src/lib/node-switch.ts`), in the app it
  selects the matching stored node and asks the app to reload (D38). Rows the
  app has not been given are disabled with the reason.
- `src/components/chrome/PushRouteListener.tsx` mounts in `AppShell`: it follows
  `GarrisonPush.pushRoute` events and drains `pendingRoute()` for a cold start.
- The sidebar's Command group gains `Capture` only with the bridge
  (`CAPTURE_ITEM` in `Sidebar.tsx`).

## capture-service

`lib/notify.mjs` `appPathFor()` derives the shell route from an explicit `path`
or from a link on this node's `GARRISON_APP_URL`; `send()`, `deliver()` and
`POST /notify` carry it as `data.path` next to `link` and `tag`. A link on any
other origin yields no path (the app must not open a peer's route as its own).
`tests/capture-service-apns.test.ts` pins the payload.

## What the simulator does and does not prove

The simulator proves the page gates on the bridge, the sections render over a
live node, and the switcher opens. It cannot prove microphone consent, the
broadcast picker, APNs registration, a push tap landing on `data.path`, or a
node switch reloading into another node. Those need the phone (plan rule). The
operator step: install the TestFlight build, open Capture from the menu, tap
Record microphone (consent sheet, then `live`), tap Enable notifications, send
`POST /notify` with a `cardUrl` on this node and tap the notification, then
open the node switcher in the sidebar and switch to a peer the app knows.
