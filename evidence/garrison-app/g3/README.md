# G3 - the Capacitor app: shell in a webview, five native plugins

Evidence for gate G3 of the Garrison app plan (docs/decisions/2026-09-garrison-app.md,
decisions D1, D4, D6, D32-D36). The gate turns the existing `ios/` Swift project
into a Capacitor host: the webview loads the Garrison shell from a node over the
tailnet, and the native side is reached through `GarrisonNode`, `GarrisonCapture`,
`GarrisonSpeech`, `GarrisonPush` and `GarrisonPendant` (stub).

There is no Xcode on this machine. Builds and tests run on the Mac mini over
ssh (Xcode 26.2, xcodegen, iPhone 17 Pro simulator); TestFlight comes from the
`garrison-ios.yml` workflow in `gongiskhan/ios-thing` (`fastlane beta`).

| file | what it proves |
|---|---|
| `xctest.log` | `xcodebuild test` on the mini against the G3 tree: 87 tests, 0 failures (`** TEST SUCCEEDED **`) |
| `sim-bootstrap-no-node.png` | fresh install, no node configured: the bundled bootstrap page with the add-node form |
| `sim-shell-talk.png` | a seeded node (`GARRISON_NODE_ORIGIN` pointing at this Mac's tailnet origin): the real shell at `/talk` rendered inside the Capacitor webview, with the shell chrome offset below the status bar |
| `testflight.txt` | the dispatch of the TestFlight workflow and its outcome |

New XCTest files: `NodeRecordTests` (NodeStore record model, migration from the
legacy capture keys, token never exposed), `BridgePluginRegistryTests` (the five
plugins register under the fixed `jsName`s and the bridge factory builds them).
The AckLog test went with AckLog (D34); the Exchanges decode test went with the
SwiftUI `ConversationView` it exercised.

## What the simulator does and does not prove

The simulator shows the bootstrap page, the node seed, the shell load over the
tailnet, and the safe-area layout. It cannot prove: microphone capture through
`GarrisonCapture.start({kind: "microphone"})` with the consent sheet, the
broadcast picker for `screen_audio`, APNs registration, or the pendant. Those
need a phone (plan rule: the phone is the criterion). The operator step is:
install the TestFlight build, add this node from the bootstrap page with a
capture token, open Conversations, confirm the shell loads and the status bar
does not overlap the chrome.

## Shell change in this gate

`viewport-fit=cover` (D36) made the page run edge to edge inside the app, so the
shell now offsets its own chrome by the top inset (`--shell-safe-top` in
`src/app/globals.css`) and tells Conversations not to add it again
(`--talk-safe-top`). Web push inside the app reports itself unsupported
(`isNativeApp()` in `packages/talk/ui/push-client.ts`); APNs is the app's job.
