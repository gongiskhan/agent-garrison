# Garrison iOS Companion: Implementation Spec

One long-running autonomous task. Target: the Garrison repo, on a macOS host. August 2026.

> **Revision 2 (2026-08-11).** Updated from what the Omi integration session
> proved live on 2026-08-09/10. Every change is marked **[R2]** with the evidence
> behind it. The largest change: **the app is now the voice sink**, which is why
> this is being built sooner. Read §2.5 and §11 before starting - they contain
> failures this codebase has already paid for once.

> **Revision 3 (2026-09-02).** The app is now a **shell**: a Capacitor 8.5.1
> webview host that loads the node's own web build over the tailnet and exposes
> the phone's native capabilities to that page through five plugins. Every
> SwiftUI screen except the consent sheet is gone; the capture path, the
> broadcast extension, the pendant stack and the speech sink are unchanged and
> sit behind the plugins as backends. The new top section below describes the shell. Rev 2 sections that
> describe a deleted screen carry a one-line **[R3]** note and are otherwise
> left as written - the invariants, the wire protocol, the ack layer and the
> failure list still hold. Decisions: D1, D4-D7, D32-D36 in
> [`decisions/2026-09-garrison-app.md`](./decisions/2026-09-garrison-app.md).

## Rev 3 (2026-09-02): the shell app

### What changed and why

Rev 2 built a native SwiftUI app with its own screens (start/stop, sessions,
settings, delivery log, pendant). The September 2026 plan moved the web channel
into the Garrison shell as Conversations at `/talk`, which made the phone's job
"show the shell, add what a browser cannot do": background audio, APNs, the
broadcast extension, BLE to the pendant, speech, and one credential the page
must never hold. So the app became a Capacitor host. The 2026-07-13 memo's
three revisit triggers had all fired, and its low-regret path is exactly what
shipped: the same web build, native plugins only where a capability forces
them. No Capacitor CLI drives the project (`@capacitor/cli` hardcodes
`ios/App/App`); Capacitor is one Swift package in `ios/project.yml` and the
config is a hand-maintained JSON resource (D1).

### The Capacitor host

- `@main struct GarrisonApp: App` stays. Its body is
  `BridgeHost().id(store.currentOrigin ?? "none").ignoresSafeArea()` where
  `store` is `NodeStore.shared`. `BridgeHost` is a
  `UIViewControllerRepresentable` that makes one `GarrisonBridgeViewController`
  and never updates it: `serverURL` is fixed per bridge instance, so **a node
  switch is a bridge recreation** driven by the SwiftUI `id` (D32).
- `GarrisonBridgeViewController: CAPBridgeViewController` overrides
  `instanceDescriptor()`: `serverURL` = the current node's `shellOrigin`,
  `appStartPath = "talk"` when a node exists (the app opens on Conversations),
  `errorPath = "index.html"`, user agent suffix `GarrisonApp/<version> (<build>)`,
  `contentInsetAdjustmentBehavior = .never`, `allowLinkPreviews = false`.
  `capacitorDidLoad()` registers the plugins from `GarrisonPlugins.make(host:)`
  by instance; nothing auto-registers (`packageClassList` is absent from the
  config). `viewDidLoad()` issues no second load: a superseded provisional load
  would fire `didFailProvisionalNavigation` and pull the error page in.
- Navigation policy is Capacitor's: top-level URLs on the node origin or
  `capacitor://localhost` stay in the webview, any other host opens in Safari.
  iframes are not affected, so fittings embedded at `/embed/<id>` and own-port
  84xx origins render inside the shell as they do in a browser.
- `capacitor.config.json` (`ios/GarrisonApp/Resources/`): `appId
  com.gomes.garrison`, `webDir public`, `server.iosScheme capacitor`,
  `server.hostname localhost`, `ios.contentInset never`,
  `ios.allowsLinkPreview false`, `ios.scrollEnabled true`. It carries no
  `server.url`; the runtime descriptor sets it from the node record.
- Deep links (D5). Push payloads carry `data.path` (a shell path such as
  `/talk/<conversationId>`); `PushManager.didReceive` hands it to
  `PushRouter.shared.route(path:)`. The `garrison` URL scheme
  (`garrison://open?path=/talk/...`) reaches the same router through
  `.onOpenURL`; only paths starting with `/` are accepted, so the webview stays
  on the node origin. A route arriving with the page listening is delivered as
  the `pushRoute` event; without a listener the host loads `shellOrigin + path`.
  A cold-start route is parked in `PushRouter.pendingPath`, which the shell
  consumes through `GarrisonPush.pendingRoute()`; until it does (G4) the host
  navigates after the first load finishes (KVO on the webview's `isLoading`).
- Launch behaviour. `PendantController.shared.connect()` on launch and on
  `scenePhase` foreground for a known pendant, as before. Push registration at
  launch is `PushManager.shared.refreshRegistrationIfAuthorized()` and only when
  a node exists: it re-registers silently when permission is already granted
  and never prompts. The first permission prompt is `GarrisonPush.register()`
  called from the page, in context. `Info.plist`: `UIBackgroundModes` is
  `[audio, bluetooth-central]` (there was no `audio` before), plus
  `CFBundleURLTypes` for `garrison`.
- Simulator seam (`#if DEBUG` only). `NodeStore.seedFromEnvironmentIfRequested()`
  reads `GARRISON_NODE_ORIGIN` and `GARRISON_CAPTURE_TOKEN` (optional
  `GARRISON_NODE_NAME`, `GARRISON_CAPTURE_URL`) from the process environment,
  upserts and selects that node, and never logs the token. `xcrun simctl launch`
  passes them as `SIMCTL_CHILD_<VAR>`. `FixtureStreamer.autostartIfRequested()`
  is unchanged.

### The bundled bootstrap page

`CAPBridgeViewController.loadWebView()` guards on the bundled start file and
`exit(1)`s when it is missing, even with a remote `server.url` (D32). So the
bundle ships `ios/GarrisonApp/Resources/public/` as a folder reference:

- `public/index.html` is the bootstrap AND the offline page: one file, inline
  CSS and JS, no external assets, `color-scheme: light dark`, system fonts,
  safe-area insets under `viewport-fit=cover`. With no node configured
  `serverURL` is nil and the bridge loads it from `capacitor://localhost`; with
  `errorPath = "index.html"` the same page loads when the node is unreachable.
  Capacitor injects `window.Capacitor.Plugins` into local pages too, so the
  page drives `GarrisonNode` directly: with a current node it shows "Node
  unreachable", the node name and origin, a Retry button (`GarrisonNode.reload`),
  the node list (tap = `select`) and a collapsed "Add a node" form; with no node
  it shows "Connect to a Garrison node" with the form (shell origin, optional
  name, capture token, optional capture URL) which calls `add` then `select`.
  Opened in a plain browser it says "This page only runs inside the Garrison
  app." The planned native `OfflineView` / `NodePickerView` were never written.
- `public/talk/index.html` exists only so the guard passes when
  `appStartPath = "talk"`; the real `/talk` is served by the node and the
  placeholder is never displayed.

### The node record (D4, D35)

`ios/Shared/NodeStore.swift` (Foundation + Combine only; it compiles into the
broadcast extension as part of `Shared/`):

```swift
struct NodeRecord: Codable, Equatable {
    var name: String            // unique key, default: first DNS label of the host
    var shellOrigin: URL        // scheme + host [+ port], no path
    var captureBaseURL: URL     // default: same scheme + host, port 8497 (8400 + 8097 % 1000)
    var token: String           // capture token; never leaves the native side
}
```

`NodeStore.shared` keeps `[NodeRecord]` under the App Group key `node.list` and
the selected name under `node.current`. Selecting a node **mirrors** its
`captureBaseURL` / `token` into the legacy `capture.baseURL` / `capture.token`
keys, so `CaptureController`, the broadcast extension, `PendantController`,
`ClipPlayer` and `PushManager` keep reading `AppGroup.baseURL` / `token`
unchanged; removing the current node clears them. On first run with legacy keys
present and no list, `migrateLegacyIfNeeded()` builds one selected record
(`shellOrigin` = the legacy base with its port dropped, `captureBaseURL` = the
legacy base). The token is written once through `GarrisonNode.add` and is
**never returned to JavaScript**: `current()` and `list()` report `hasToken`.
The page is same-origin with the node, but the webview is not in the data path
(I2) and a leaked token would let any script on the shell speak to
capture-service with the phone's identity.

### The five plugins

All under `ios/GarrisonApp/Plugins/`, registered in the order of
`GarrisonPlugins.jsNames = ["GarrisonNode", "GarrisonCapture", "GarrisonSpeech",
"GarrisonPush", "GarrisonPendant"]`. Each is `final class GarrisonXPlugin:
CAPPlugin, CAPBridgedPlugin` with `identifier == jsName`, every method returns a
promise, errors are `call.reject(message, code)` with the codes listed, and
timestamps are milliseconds since the epoch. The page reaches them as
`window.Capacitor.Plugins.<jsName>.<method>(args)` and
`.addListener(event, cb)`; no `@capacitor/core` import is needed. Plugin
methods run on a background queue and hop to the main actor before touching
UI; `bridge?.viewController` is the host for any native sheet.
`ios/Tests/BridgePluginRegistryTests.swift` pins the names and method sets.

#### GarrisonNode (backend `NodeStore.shared` + the host)

| Method | Resolves | Rejects |
|---|---|---|
| `current()` | `{name, shellOrigin, captureBaseURL, hasToken}`; `{}` when no node (not a rejection) | |
| `list()` | `{nodes: [{name, shellOrigin, captureBaseURL, hasToken, current}]}` | |
| `add({shellOrigin, token, name?, captureBaseURL?})` | the record as in `current()` | `INVALID_ORIGIN` (`NodeRecord.normalizedOrigin` failed), `INVALID_TOKEN` (blank) |
| `select({name})` | `{name}`; the bridge is recreated after the promise resolves | `UNKNOWN_NODE` |
| `remove({name})` | `{}` | `UNKNOWN_NODE` |
| `reload()` | `{}`; reloads `shellOrigin` (or the bundled page when no node) | |
| `info()` | `{appVersion, build, platform: "ios", bundleId}` | |

#### GarrisonCapture (backend `CaptureController`, owned by the plugin, + the broadcast heartbeat + `BroadcastPicker`)

| Method | Resolves | Rejects |
|---|---|---|
| `status()` | `{phase: idle\|connecting\|live\|interrupted\|failed, error?, sessionId?, startedAt?, ackedFrames, broadcasting, broadcastError?, microphone: granted\|denied\|undetermined, consentSuppressed}` | |
| `start({kind: "microphone"})` | `status()` once start was invoked. Presents the native `ConsentSheet` unless `capture.consentSuppressed`; only `onProceed` reaches `CaptureController.start(consent:)` | `NO_NODE`, `ALREADY_RUNNING`, `CONSENT_DECLINED` |
| `start({kind: "screen_audio"})` | `status()` once the App Group heartbeat reports the broadcast live (polled every 1 s, up to 30 s). Native code can only present the system picker (D6) | `BROADCAST_NOT_STARTED` (with the extension's last error appended when present) |
| `start({kind: other})` | | `BAD_KIND` |
| `stop({kind?})` | `status()`. `microphone` (default): `controller.stop()`; `screen_audio`: presents the picker again, the system sheet being the only way to end a broadcast, and resolves without waiting | |
| `consent()` | `{suppressed}` | |
| `setConsentSuppressed({suppressed})` | `{suppressed}` (the former "Skip the consent notice" toggle) | |

Event `captureState` (the `status()` payload) fires on every
`CaptureController` phase / session id / acked-frame change and, while the
broadcast heartbeat differs from the last emitted value, every 2 s.

#### GarrisonSpeech (backend `SpeechUtterer` in `SpeechSink.swift` + the `speak.*` keys)

| Method | Resolves | Rejects |
|---|---|---|
| `speak({text, rate?, volume?, voiceId?, lang?})` | `{completed}` when the utterance finishes or is cancelled; audio session activated and released around it exactly as `ClipPlayer` does; defaults come from the `speak.*` keys and `SpeechSink.localVoice(for:)` | `EMPTY_TEXT` |
| `stop()` | `{}` | |
| `voices({lang?})` | `{voices: [{identifier, name, language, quality: default\|enhanced\|premium}]}` | |
| `settings()` | `{master, info, cues, rate, volume, voiceId?, quietStart, quietEnd, muteUntil}` with the defaults `SpeechSink` reads (true, true, true, system rate, 1.0, none, -1, -1, 0) | |
| `configure({any subset of the settings keys})` | `settings()` after writing; each value type-checked, unknown keys ignored | |
| `muteFor({minutes})` | `settings()` (`muteUntil = now + minutes * 60`) | |
| `unmute()` | `settings()` | |

These are the §5b controls: the deleted `SettingsView` toggles became plugin
methods so the capture page (G4) can host them.

#### GarrisonPush (backend `PushManager.shared`)

| Method | Resolves | Rejects |
|---|---|---|
| `register()` | `status()` once the authorization result is known (prompts if needed, then registers; the token upload finishes asynchronously and surfaces via `pushStatus`) | |
| `status()` | `{authorization: notDetermined\|denied\|authorized\|provisional\|ephemeral, registered, detail}` (`detail` is `PushManager.status`; `registered` is `detail == "registered"`) | |
| `pendingRoute()` | `{path?}` from `PushRouter.takePendingPath()` | |

Events: `pushRoute` `{path}` (emitted by the host, `retainUntilConsumed`), and
`pushStatus` `{detail}` on every `PushManager.status` change.

#### GarrisonPendant (backend `PendantController.shared`; the plugin never creates a controller and never connects on its own)

| Method | Resolves | Rejects |
|---|---|---|
| `status()` | `{connectionState (lowerCamelCase case name), paired, battery?, sessionId?, uploaderState, lostFrames, hapticSupported?, capturePolicy?, pendantFlagOn?, ambientConsent}` | |
| `connect()` | `status()` | |
| `disconnect()` | `status()` | |
| `forget()` | `status()` after disconnect and `AppGroup.pendantIdentifier = nil` | |

Events: `pendantState` (the status payload) on connection state / session id /
uploader state change, `pendantBattery` `{battery}` on battery change. The app,
not the plugin, reconnects a known pendant on launch and foreground; the
transport auto-adopts the first identified peripheral, so there is no `scan()`
(D7). `ios/Tests/PendantFeedbackMappingTests.swift` pins the ownership.

### Consent stays native (D33)

Invariant I6 outranks the shell. `ConsentSheet.swift` is kept unchanged and
`GarrisonCapture.start({kind: "microphone"})` presents it in a
`UIHostingController` sheet (`.medium` detent) over the bridge view controller;
the copy ("If you have people around, always ask for consent.") and the "Don't
ask me again" toggle are as before. The web page never sees the decision, only
the resulting `captureState`. `GarrisonCapture.consent` /
`setConsentSuppressed` expose the persisted checkbox.

### What was deleted (D34)

`ContentView.swift`, `ConversationView.swift`, `SettingsView.swift`,
`SessionsView.swift`, `AckLog.swift` and `Pendant/PendantView.swift`. `AckLog`
existed for the Sessions screen's delivery log and the notification handlers'
readable copy; with no reader left, its three append sites (`PushManager`,
`CaptureController`, `PendantController`) and
`testAckLogAppendsBoundedNewestFirst` went with it. The records that mattered
never lived there: spoken receipts go back to capture-service and digests land
in Conversations (G5). `PushManager.swift` was rewritten around the plugin
(authorization on request, silent refresh at launch, `didReceive` routes
`data.path`); registration and token upload are as before.

### What stayed

- **The broadcast extension**, `ios/BroadcastExtension/**`, byte for byte: it
  still reads `capture.baseURL` / `capture.token` from the App Group and writes
  the heartbeat the plugin polls.
- **The capture path**: `CaptureController`, `Shared/CaptureUploader`,
  `OpusEncoder`, `SessionSpool`, `CaptureProtocol`, `BroadcastPicker`,
  `FixtureStreamer`; the §4 wire protocol and the I7 resume rules are
  untouched. The app remains outside the data path (I2).
- **The pendant**: `PendantController`, `PendantBLETransport`,
  `PhoneFeedbackSink`, `Shared/Pendant/**` and the mock stack, now reached
  through `GarrisonPendant`.
- **The speech sink**: `SpeechSink` / `SpeechUtterer` / `ClipPlayer`, clip first
  and synthesizer fallback (§5b), now also callable from the page through
  `GarrisonSpeech`.
- **Tests**: `ios/Tests/NodeRecordTests.swift` (migration, mirroring,
  normalisation) and `BridgePluginRegistryTests.swift` (names and method sets)
  are new; the rest of the suite is unchanged apart from the two edits above.
- **The one shell change**: `viewportFit: "cover"` in `src/app/layout.tsx`, so
  the `env(safe-area-inset-*)` padding Conversations already declares stops
  being zero under `contentInset: never` (D36).

Toolchain (Xcode 26.2 on the mini, XcodeGen, `capacitor-swift-pm` 8.5.1,
TestFlight through the ios-thing workflow) is recorded in
[`adr-companion.md`](./adr-companion.md) §11.

## 1. Context and goal

This task builds Garrison's iOS companion app and everything it needs on the
Garrison side, end to end, in one run, finishing with a build on TestFlight.

The app is deliberate, session-based capture: the user presses a button, the
phone records the screen and listens to the microphone (or audio only), and the
user stops it when done. A consent notice appears before capture starts ("if you
have people around, always ask for consent") with a "Don't ask me again" checkbox
that persists. No always-on anything: continuous ambient capture stays with the
Omi channel, which already exists. This app is for meetings, dictation, car
sessions, and thinking out loud.

**[R2] It is also Garrison's mouth.** The pendant cannot speak (Omi's BLE surface
is device-to-app only; the DevKit 2 speaker is a beeper with no exposed
characteristic), and the operator does not wear earbuds. Today an answer reaches
them as a push notification that truncates, whose tap target is the Omi chat.
Measured on 2026-08-09: a delegated answer was generated correctly, delivered
successfully (`omi-push:ok`, HTTP 200), and the operator still could not read it.
The companion app closes that hole - it can speak, it can show the full text, and
it is not subject to Omi's 10-messages-per-hour chat cap. Speech is therefore a
first-class deliverable of this run (M5b), not a later addition.

By the end of the run, the full loop must work against Garrison: live
transcription with a visible transcript, wake commands ("Zeca, ...") during a
session, memories persisted, tasks created on the Kanban Loop through the
existing triage (with its wait-for-context batching), iOS push notifications out
(including asks the user answers by voice), **[R2] spoken acknowledgements while
the app is foregrounded**, and the app uploaded to TestFlight through the App
Store Connect automation ported from the iOS thing project.

Three references, none of them dependencies:
- **iOS thing** (local checkout, path provided via env): proven Swift code for
  screen broadcast plus audio streaming to a server, and the App Store Connect /
  TestFlight automation to port.
- **The Omi open-source repo** (MIT): patterns for audio session handling,
  permissions onboarding, and background behavior. Read, learn, reimplement;
  never vendor their code wholesale.
- **fittings/seed/omi-channel** in this repo: the house reference for fitting
  shape (own port, flags off, status file, counters, sandboxed tests) and the
  home of the triage, wake, and notification seams this task extends.
  **[R2]** Read its `RUNBOOK.md` first - the "two model lanes" and "transcript
  quality" sections describe traps this app will hit identically.

## 2. Invariants (non-negotiable)

- **I1 One brain, one triage.** No second task-extraction path. Companion capture
  events flow through the same triage engine the Omi channel uses, preserving its
  mechanics: rule filters first, one batched model call per non-empty tick TOTAL
  across all sources, dedupe by origin id, and the wait-for-context behavior
  (never card a lone fragment; hold short sessions until enough transcript has
  accumulated or the session has ended). Generalize the existing triage; do not
  duplicate it.
- **I2 Source-agnostic rails.** Everything ingested becomes a `capture_event`
  with `source: "companion-ios"`. Nothing downstream reads companion-specific
  fields. The Omi channel and this app are siblings feeding the same rails.
- **I3 Session-based only.** Capture starts and stops by explicit user act. The
  app never records outside a session. No ambient mode exists, even behind a flag.
- **I4 Cost gates.** STT is billed only while a session is live. Zero LLM calls at
  ingress. Models run only in triage ticks and on wake hits.
- **I5 Log privacy.** Session transcripts are user-initiated content and are
  stored by design, but logs and counters never carry transcript text. Wake
  handling keeps the omi-channel rules.
- **I6 Consent context.** Every session records whether the consent sheet was
  shown or was suppressed by the checkbox, and the mode (screen_audio or audio).
  This travels in `capture_event` provenance.
- **I7 Idempotency and fast acks.** Chunked upload with per-chunk acks and resume
  by last acked sequence. Replaying a session's chunks twice yields identical
  state. Dedupe by session id.
- **I8 Secrets via vault.** `DEEPGRAM_API_KEY`, `CAPTURE_TOKEN`, `APNS_TEAM_ID`,
  `APNS_KEY_ID`, `APNS_P8` (or a path convention the vault supports),
  `APP_BUNDLE_ID` as config. Nothing sensitive in code, fixtures, or Info.plist.
  **[R2, corrected 2026-09-02] `DEEPGRAM_API_KEY` IS in the vault** and is read
  by capture-service, which is the voice layer (`kind: voice`) since the
  `deepgram-voice` fitting was retired. `ELEVENLABS_API_KEY` is optional and,
  when sealed, selects ElevenLabs for read-aloud (`tts_backend: auto`). M0
  preflight reports which keys are sealed: no `DEEPGRAM_API_KEY` means no live
  transcription and `/stt` answers 503; no ElevenLabs key only changes the TTS
  backend.
- **I9 Flags default off.** The capture-service fitting ships inert like the omi
  channel did. The app ships with no hardcoded hosts; base URL and token are
  settings.
- **I10 iOS discipline.** SwiftUI, no third-party UI frameworks. The broadcast
  upload extension stays memory-safe (well under the ~50 MB extension ceiling)
  and does no business logic: encode, hand off, nothing else. Reuse the encoder
  and uploader approach that already works in iOS thing.
  **[R3]** Historical as to the first sentence: the app is a Capacitor 8.5.1
  webview host (the one shipping dependency, D1); the extension clause stands.
- **[R2] I11 Never optimistic.** No acknowledgement - spoken, pushed or shown -
  is emitted before its outcome is confirmed. This already exists as a structural
  rule in `fittings/seed/kanban-loop/lib/ack.mjs`: acks are built only from
  post-persistence event kinds, by whitelist. The app inherits it and must not
  add an "optimistic UI" that says "task created" before the card write returns.
  A spoken confirmation of something that did not happen destroys trust in the
  whole layer within a week, at which point the feature is turned off.
- **[R2] I12 The app must not hear itself.** Anything the phone speaks is audible
  to its own microphone during a live session, and to the pendant always. See
  §2.5 - this is the single largest new hazard in this revision.

## 2.5 [R2] The echo problem (read before designing anything that speaks)

Garrison now has an always-on ear. Adding a mouth creates a loop, and the loop is
self-amplifying rather than merely noisy.

Proven on 2026-08-09 against the live system:

- Ambient speech reaching the conversation pipeline **does** become Kanban cards.
  This is the designed behaviour of triage, and it does not distinguish the
  operator's voice from a speaker's.
- The wake regex matches `Zeca` anywhere in a segment with word boundaries.
  Tested directly: `"Zeca created a task, follow up with the lawyer."` is a wake
  hit. `"Created a task, follow up with the lawyer."` is not.
- Template text avoids the wake word, but **slots do not**: they carry free text
  from the operator's own request, so "send Zeca the invoice" renders a sentence
  that re-opens the capture window on the app's own voice.

Three defences, all of which this run must implement for the companion:

1. **Wake-word rejection at render time**, on the finished sentence, not on the
   template. `ack.mjs.assertSpeakable` already does this and skips the ack rather
   than speaking it. Reuse it; do not reimplement.
2. **Echo suppression in the capture-service**, mirroring
   `fittings/seed/omi-channel/lib/echo-guard.mjs`. Every ack carries a normalised
   `echo` fingerprint and its `text`. Matching is **token containment over a
   ~30s window, not hash equality** - the sink speaks one sentence and the
   transcriber returns several fragments with drifted casing, accents and
   punctuation, so equality never fires. Bias toward letting speech through: a
   3-token floor and a 0.8 containment threshold, because a missed suppression
   costs one deletable card while over-suppression silently eats the operator's
   real words and leaves nothing to debug.
3. **Suppress in the ingress, before the wake gate.** A returning ack is not
   conversation either - if it reaches the pre-wake context ring it becomes
   "evidence" for the next command the operator actually issues.

**The companion is worse than the pendant here**, because it speaks and records
on the same device with the same speaker and microphone. Additionally required:

- Do not speak while the session's own microphone is hot unless the platform's
  echo cancellation is engaged. Prefer `AVAudioSession` with
  `.playAndRecord`, `.voiceChat` mode and `.defaultToSpeaker`, which routes
  through the voice-processing I/O unit and applies AEC. State in the ADR
  whether AEC is being relied on or whether speech is deferred to session end.
- The capture-service registers the echo fingerprint **before** the phone is told
  to speak, never after, or the window opens too late.

## 3. Architecture

- **`ios/` at the repo root**: the Xcode project. Targets: the app, the Broadcast
  Upload Extension (plus its Setup UI extension if required), a shared framework
  for the wire protocol and uploader, and an App Group container shared between
  app and extension. Project generation: decide in M0 after reading how iOS thing
  is set up; prefer XcodeGen or Tuist for agent-friendly diffs unless the ported
  automation assumes a committed pbxproj.
- **`fittings/seed/capture-service`**: a new own-port fitting cloned from the
  omi-channel patterns. It terminates the websocket ingress, runs Deepgram live
  transcription (Portuguese and English, diarization on; exact model per Deepgram
  docs at build time), stores per-session transcripts and media, serves a live
  transcript view (plus session list and detail), runs the wake gate on live
  segments, and on session end emits a `capture_event` into the shared triage
  inbox. Video segments are stored per session with keyframes extracted; no
  interpretation of screen content in this version.
  **[R2]** It must also accept `POST /ack` (§5b) and hold an `EchoGuard`.
- **Triage generalization**: extend the existing omi triage so both sources share
  one inbox, one tick, one model call, one dedupe space. The mechanism (shared
  store vs shared lib consumed by one merged scheduler job) is an M0 ADR
  decision; the invariant is I1.
- **Notifications**: a `companion` transport (APNs, token-based auth with the
  .p8 key) added beside the existing omi transport in the notify-origin routing,
  with the existing fallback chain preserved. The fitting keeps a device-token
  registry populated by the app's registration call. Templates: `card_created`,
  `wake_confirmation`, `ask`, `tip`. Per the standing push decision there are no
  action buttons; the notification body carries the card deep link where relevant.
  **[R2] The receipt list is keyed by means, not position** - a send now yields
  `omi-push`, `omi-chat`, and `web-channel` only on failure. Adding `companion`
  must not assume an index.
- **Ask-then-listen semantics (v1)**: an `ask` is just a push carrying a question.
  The user answers by voice with a normal "Zeca, ..." command during a live
  session (or via Omi if it's listening). The orchestrator receives recent-ask
  context so the answer lands connected. No special reply protocol in v1.
- **Transport**: v1 rides Tailscale; the phone runs the Tailscale app and the
  base URL is the tailnet address of the node running the fitting. No new public
  ingress. A funnel mount for external users is explicitly out of scope.

## 4. Wire protocol (the contract between app and fitting)

All messages over one websocket per session, Bearer `CAPTURE_TOKEN` on connect.

- `session_start`: `{ session_id (ulid, client-generated), mode: "screen_audio" | "audio", device_name, consent: "shown" | "suppressed", started_at }`
- Audio frames: Opus, 16 kHz mono, `{ seq, ts, bytes }`, acked by the server as
  `{ ack: seq }`. The uploader resumes from the last acked seq after a drop.
- Video segments (screen_audio mode): fragmented MP4 segments in the encoding iOS
  thing already produces, `{ seq, ts, bytes }`, same ack scheme, interleaved with
  audio.
- `session_end`: `{ reason: "user" | "error" | "timeout" }`
- Device registration (plain HTTPS, same token): `POST /capture/devices { apns_token, device_name }`
- **[R2] Speech delivery** (server → app, same socket when a session is live):
  `{ type: "speak", ack: <ack payload per §5b> }`. When the voice layer produced a
  clip the ack carries `audioPath: "/speak/<clip id>.mp3"` (fetched from the
  capture-service origin with the capture token); without it the app synthesizes
  on device. Out of session the app is reached by APNs instead. The app replies `{ spoken: <ack id>, ok, reason? }` so
  the server knows whether the utterance actually happened - a sink that silently
  drops is indistinguishable from one that is off.
- Offline behavior: the extension and app write to the App Group container while
  the link is down; the uploader drains with retry; a ring-buffer cap keeps disk
  bounded. Chunks arriving late or twice are handled by I7.

## 5. [R2] Consuming the acknowledgement layer (do not invent a parallel one)

The ack layer shipped on 2026-08-09/10 (`bec4bc4e`, `ac3e6ecc`) and was designed
against this app. Read `fittings/seed/kanban-loop/lib/ack.mjs` before writing any
notification or speech code.

- **Discovery needs no registration.** `fanOutAck` POSTs to `<base>/ack` on every
  running own-port fitting and treats 404 as "not for you". A capture-service
  that implements `POST /ack` receives acks the moment it starts. There is no new
  capability kind, no transport map to edit. The same is true of `/notify`.
- **The payload is already companion-shaped**:
  `{ id, kind: captured|created|started|completed|failed, severity: info|error,
  templateId, slots, referent, text, echo, cardId, emittedAt, sourceChannel,
  idempotencyKey }`. Consume it unchanged.
- **`text` is pre-rendered and pre-validated.** It has passed the wake-word check
  and the referent rule (every ack names what it is about, because an ack arrives
  seconds after the utterance that caused it and "Done" is unusable). The app
  speaks `text`; it does not compose sentences.
- **Templates are fixed, never generated.** Latency and honesty both forbid a
  model in this path. The registry is overlayable at
  `$GARRISON_HOME/kanban-loop/ack-templates.json` and an invalid overlay is
  refused whole.
- **`kind: started` and `kind: captured` have templates but no emission seam
  yet.** `started` is a natural fit for "session capture began" and `captured`
  for a note saved from a wake command. Wiring them is in scope for this run.

### 5b The voice-out sink

The companion app is the sink the earlier voice brief specified for the Mac. The
Mac remains unbuilt because its daemon is a 15-second poller with no local
endpoint; the phone has no such problem because the session websocket is already
open and bidirectional.

Behaviour, unchanged in intent from the voice brief:

- Speak only when the app is foregrounded (or in a live session with background
  audio active). Otherwise do not speak, and let the ack fall through to APNs.
- **Queue ceiling of 3.** Beyond it, speak the most recent error and drop the
  rest, or collapse to a count. Ten acks in five seconds must not produce ten
  sentences.
- **Staleness window ~30s.** An older ack is dropped or spoken with an explicit
  time reference, never as if it just happened.
- Errors speak even when info-level acks are muted, unless the sink is off.
- Duck other audio rather than interrupting.
- **Clip first, on-device fallback** (D3, 2026-09-02). The voice layer
  (capture-service) decides what is said and produces the clip - ElevenLabs when
  `ELEVENLABS_API_KEY` is sealed, else Deepgram Aura - and the ack ships with
  `audioPath`; the app plays that clip. `AVSpeechSynthesizer` is used ONLY when
  the ack arrives without `audioPath` (no TTS backend, or the remote call
  failed): a robotic ack beats a silent one. Voice, rate and volume of the
  fallback are settings.
- **Controls**: master on/off reachable in one tap; info acks separately from
  errors; quiet hours; mute-for-N-minutes (the realistic failure is a meeting
  starting).
  **[R3]** The native settings screen that held these is deleted; they are the
  `GarrisonSpeech.settings / configure / muteFor / unmute` plugin methods, hosted
  by the capture page (G4).

### 5c [R2] What the notification must carry

Learned the hard way: a push that truncates and whose tap target does not contain
the message is worse than useless, because it consumes attention and returns
nothing. For APNs the app controls both ends, so:

- The notification body carries the full ack `text` where length allows, and the
  app's notification-service or content extension shows the whole thing.
- Tapping **must** land on the content - the session, the card, or an in-app
  message list - never a generic home screen.
- The app keeps a local, readable log of every ack and notification received.
  This is the thing the operator scrolls when they felt a buzz and missed it.

**[R3]** Historical: the local log (`AckLog` + the Sessions screen's delivery
log) is deleted with the screens that read it (D34); the tap target is now the
shell route in `data.path`, and the readable copy lives in Conversations.

## 6. [R2] Latency and lanes (do not rebuild the 82-second mistake)

Measured on the live system, 2026-08-09:

| Path | Cost |
|---|---|
| Classification pinned to `cc-haiku-low` | ~6 s |
| The same call unpinned, landing on the `other`/L1 duty cell | **82 s** |
| Wake capture window (punctuated sentence) | ~5 s |
| Wake capture window (unpunctuated) | 15 s |
| Full operative turn with tools | 7-90 s |
| Spoken command to acknowledgement, end to end | ~12 s |

Consequences for this build:

- **Every classification call must pin its target.** The fitting sends
  `routing: { target: "cc-haiku-low" }` on the gateway `/chat` call.
  `sanitizeRouting` accepts `target`, `model`, `duty`, `project`, `account`,
  `effort`, `level`, `tier`, `flow`, `phasesOff` from the request body.
  Unpinned, a classification inherits the composition's duty cell and drags the
  operative's whole toolset through a one-shot JSON question.
- **Anything needing tools is a delegation, and nobody waits on it.** The wake
  bus acknowledges within seconds and delivers the real answer on a second
  notification. The app's UI must model this: an in-flight state, then an answer
  that can arrive a minute later. Do not build a spinner that blocks.
- **Timing budgets in tests must exceed the system's own periods.** The triage
  scheduler job runs on a 5-minute cron; a test that waits 2 minutes for a
  triaged card reports a false failure and blames the scheduler. This exact bug
  shipped in the Omi harness and had to be fixed.

## 7. Milestones

Rules as in the omi build: implement, test, update `PROGRESS.md`, commit as
`companion: M<n> <summary>`. Never start M<n+1> with M<n> red. Every deviation is
one line in `DECISIONS.md`.

### M0 Preflight, recon, ADR
- Hard preflight, stop immediately with a precise ask if any fail: running on
  macOS with Xcode and simulators available; the Garrison repo checkout writable;
  `IOS_THING_PATH` env pointing at the iOS thing checkout and readable; vault
  reachable with the I8 secret names present or explicitly marked pending;
  `APP_BUNDLE_ID` decided.
  **[R2]** Expect `DEEPGRAM_API_KEY` to be absent - report it, do not stop.
- Recon: read `fittings/seed/omi-channel` fully (it is the pattern), the triage
  job and store, the kanban notify-origin seams, and iOS thing's capture,
  uploader, and fastlane / App Store Connect automation.
  **[R2]** Also read `lib/ack.mjs`, `lib/echo-guard.mjs`, the omi-channel
  `RUNBOOK.md`, and `scripts/speak.mjs` (the harness pattern M1's replay client
  should follow).
- `docs/adr-companion.md`: project generation choice, triage generalization
  mechanism, APNs sender placement, wake-module sharing approach, media storage
  layout. **[R2]** Add: whether speech relies on AEC or defers to session end
  (§2.5), and how the echo guard is shared between the two fittings without a
  cross-fitting import.
- Scaffold `fittings/seed/capture-service` (flags off, 501s) and `ios/` (project
  skeleton compiles for simulator).
- Acceptance: fitting registers and shows on /health; `xcodebuild` builds the
  empty app for simulator; ADR committed.

### M1 Ingress and protocol
- Websocket ingress per section 4 with token auth, acks, resume, dedupe, session
  store (transcript, media segments, consent context), counters.
- Fixtures: recorded Opus audio (Portuguese and English speech including "Zeca"
  commands), a small fMP4 segment set, duplicate and out-of-order chunk cases, a
  malformed session.
- A node replay client (`scripts/replay-client.mjs`) that speaks the full
  protocol against a local instance; it doubles as the E2E driver later.
  **[R2]** Follow `speak.mjs`: it must FOLLOW each injection to its downstream
  effect and print the card, transcript or answer - or say plainly that nothing
  arrived. A driver that asserts only on 200s proves nothing. It must also state
  its own coverage limits in its header, so a green run is not mistaken for more
  than it covers.
- Acceptance: double replay of the fixture set is byte-identical in the store;
  resume-after-drop works; bad token rejected and counted.

### M2 Live transcription and the transcript view
- Deepgram live client (mocked in tests; one real-key smoke script gated on the
  env var being present), interim and final segments stored per session, live
  view streaming the transcript, session list and detail pages per the
  fitting-view pattern.
- Acceptance: fixture replay produces a stored transcript through the mock; the
  view renders live updates; no transcript text in logs (I5).

### M3 Wake gate on companion sessions
- The omi-channel wake module runs over companion live segments (shared lib or
  extracted module per ADR): same variants, word-boundary rules, silence window,
  dedupe, kill switch, latency metric.
- Dispatch reaches the orchestrator exactly as omi wake commands do.
  **[R2]** "Exactly as" now includes: the pinned cheap lane for classification,
  the `delegate` intent for anything needing tools or the user's own data, the
  two-notification pattern (acknowledge, then answer), and the scheduling rule
  that a spoken DAY ("amanhã", "on Monday") schedules at 09:00 local rather than
  producing an unscheduled card.
- **[R2]** Latency is counted in three legs - capture, classify, notify - not as
  one number. A single end-to-end figure cannot say which regressed and already
  produced one wrong diagnosis.
- Acceptance: the scripted "Zeca, create a test task called hello companion"
  fixture triggers exactly once; near-misses do not; duplicate segments do not
  double-dispatch.

### M4 Triage generalization
- Companion `capture_event`s join the same inbox and tick as omi events per the
  ADR mechanism. Preserve: rule filters free, ONE model call per non-empty tick
  across both sources, wait-for-context, origin-id dedupe, provenance links,
  memory extraction.
- Acceptance: a mixed fixture batch (omi + companion) triages in one model call;
  re-run creates zero duplicates; a thin fragment session is held then carded
  once context arrives; empty tick makes zero calls; memories persist with
  provenance.

### M5 APNs transport
- Token-based APNs sender using the vault .p8; device registry from the
  registration endpoint; `companion` transport wired into notify-origin routing
  beside `omi`, fallback chain intact; templates `card_created`,
  `wake_confirmation`, `ask`, `tip`; per-day cap; 429/5xx backoff.
- **[R2] Two traps, both already paid for once in this repo:**
  1. A process spawned by the **scheduler** does not inherit the composition's
     flags. The omi triage job's env carried only the triage flags, so a notifier
     gating on `notifyEnabled` read false and every triage-created card silently
     degraded to a surface nobody reads. A relay must not re-check a flag it
     cannot know; the owning server is authoritative.
  2. **Backoff must be wider than the limit it is backing off from.** A schedule
     doubling from 1s covers three seconds; a rate-limit window is far wider, so
     every retry burned itself and degraded. Honour `Retry-After`, capped.
- **[R2] Deep links must be reachable from the phone.** The device is never on
  the Garrison host, so a `http://127.0.0.1:<port>/...` link is both unreachable
  and mixed content. Card URLs in notifications must be the tailnet HTTPS pair
  (`toTailnetUrl` / `resolveViewUrl` are the existing helpers). Loopback URLs
  have already shipped into a live notification thread; check yours.
- Acceptance: unit tests against a mocked APNs endpoint; routing honors channel
  toggles; failures retry and log without content; **[R2]** every URL in a
  rendered notification is verified non-loopback.

### M5b [R2] Speech sink
- `POST /ack` on the capture-service: registers the echo fingerprint, then
  forwards to a live session socket as `{type: "speak"}` or falls through to APNs.
- App side: plays the `audioPath` clip when present, `AVSpeechSynthesizer` only
  as the fallback, queue ceiling 3, staleness window, errors always audible,
  controls per §5b, `{spoken: ...}` receipt back.
- Acceptance: an ack emitted with the app foregrounded is spoken within 2s of the
  action completing, through the clip when the ack carries `audioPath` and
  through the synthesizer otherwise; with the app closed nothing is spoken and
  the push still arrives; toggling the sink off silences speech within one ack with no restart;
  ten acks in five seconds do not produce ten sentences; **speaking during a live
  session does not create a card** (the echo guard suppresses the app's own voice
  in the transcript - assert on the stored transcript, not just on counters).

### M6 The iOS app
- Port from iOS thing into `ios/`: broadcast upload extension and encoder,
  uploader hardened to the section 4 protocol with App Group buffering and
  resume, background audio session handling for audio-only mode (AVAudioEngine,
  interruption recovery).
- App proper: big start/stop control with mode selection, consent sheet with
  exact copy and persistent "Don't ask me again", settings (base URL, token,
  device name, **[R2]** voice settings and ack toggles), APNs registration, a
  minimal sessions screen, **[R2]** and the local ack/notification log from §5c.
  **[R3]** Historical: every screen in this bullet except the consent sheet is
  deleted; the shell page and the five plugins replace them (Rev 3 section).
- Tests that run headless on the simulator via `xcodebuild test`: protocol
  encoding, uploader buffering and resume against a local mock server, consent
  persistence, settings. The broadcast path is device-only and is excluded from
  automated tests by design.
- Acceptance: simulator test suite green; the app builds and archives for device;
  a simulator run of audio-only mode streams fixture microphone input to a
  locally running capture-service and the transcript appears in the view.

### M7 E2E on fixtures, all flags on
- The replay client drives the full loop against a sandboxed instance with every
  flag on and external boundaries mocked: session start with consent context,
  audio streaming, live transcript, wake command, card created on the Kanban
  backlog with `origin: companion`, APNs mock push received, **[R2]** ack spoken
  through a mock speech sink and suppressed from the transcript, session end,
  triage tick persisting the memory, ask template exercised.
- Acceptance: one script, `npm run e2e:companion`, green from a clean sandbox;
  counters on /health reflect every pipe. **[R2]** Its wait windows exceed the
  triage cron period; a slow tick is reported as slow, not as failure.

### M8 TestFlight
- Port the fastlane / App Store Connect automation from iOS thing (API-key auth),
  adapted to `APP_BUNDLE_ID` and the `ios/` project: build, sign, upload, wait
  for processing. Missing or broken signing assets are the one legitimate
  mid-run stop: halt with the exact missing item, never improvise around signing.
- Acceptance: the build appears in TestFlight processing (or the run halts with
  the precise signing ask); the lane is committed and rerunnable.

### M9 Docs and human handoff
- `RUNBOOK.md`: state layout, kill switches, fixture replay, key rotation, APNs
  troubleshooting, **[R2]** the latency legs and what each means, and how to tell
  an echo-suppression false positive from a transcription failure.
- `HUMAN_SETUP.md`: seal the vault secrets (**[R2]** including the Deepgram key,
  which does not exist yet); install Tailscale on the iPhone; install the
  TestFlight build; paste base URL and token; first-run consent expectations; the
  spoken smoke test with expected outcomes, timings, and where each counter
  should move; how asks arrive and how to answer them by voice.
- `PROGRESS.md` closed out; deviations complete in `DECISIONS.md`.

## 8. Execution protocol for the session

- Preflight before anything else; the M0 stop conditions are the only acceptable
  early exits.
- Work milestones strictly in order; green tests gate every advance.
- Fixtures over live: Deepgram and APNs mocked everywhere; the only live
  externals in the whole run are the real-key Deepgram smoke (optional,
  env-gated) and the M8 TestFlight upload.
- Fetch current Deepgram and Apple docs before writing those clients; verified
  shapes go in `docs/api-notes.md`; docs beat this spec, record every difference.
- Touch only `ios/`, the new fitting, and the minimal registration seams (triage,
  notify routing, composition), each behind flags.
- **[R2] Coordinate.** Other agent sessions write to this repo concurrently. Call
  `begin_planning` before substantial work and `declare_intent` for the files you
  will touch. **Never use `git stash`, `git checkout --` or any whole-tree
  operation to isolate a problem** - on 2026-08-09 that silently destroyed
  another live session's uncommitted work, and it is unrecoverable. Commit
  promptly so your own work is not the thing swept.
- **[R2] Restarting a fitting is not a redeploy.** Own-port fittings load from the
  checkout seed dir, so `POST /api/fittings/<id>/restart` picks up code changes.
  Do not run `prod:redeploy`. **Do not restart the live omi-channel** - Omi opens
  a circuit breaker after repeated webhook failures and auto-disables the webhook
  after 100 consecutive ones, which silently kills the realtime pipe.
- **[R2] Verify claims before reporting them.** Two conclusions in the Omi
  session were wrong because they rested on a single observation: transcription
  was declared broken on the strength of one bad conversation (13 of the last 16
  were clean), and reminders were declared dead seven seconds before the sweep
  that delivered them. Sample, or read the code, before concluding.
- Commit per milestone; keep the branch mergeable; no force-push.

## 9. Out of scope (do not build)

Always-on or ambient capture in any form; pendant BLE (it lands in this app
later, not now); web push or VAPID; a webview tab (**[R3]** historical: the app
IS a webview since Rev 3); CarPlay; an Apple Watch app;
screen-content interpretation or OCR; Android; App Store release beyond
TestFlight; the Omi setup wizard (separate track); any public ingress for capture.
**[R2]** Also out: the macOS speech sink from the voice brief - the phone
supersedes it for this iteration; and haptics, which remain the right long-term
private channel but must not gate this run (the ack payload already supports a
haptic consumer unchanged).

## 10. Open questions parked for after v1

Apple's on-device SpeechAnalyzer as a Deepgram replacement (cost, Portuguese
support); QR pairing instead of pasted token; a funnel `/capture` mount for
external users; what to do with stored keyframes; whether asks deserve a
dedicated reply protocol once real usage shows how they get answered.
**[R2]** Whether the phone should also carry the readable copy for Omi-originated
messages, retiring the Omi chat mirror and its 10/hour cap.

## 11. [R2] Failures this codebase has already paid for

Short list, all from 2026-08-09/10, all verified. Re-reading this is cheaper than
rediscovering any of them.

1. **A cheap-looking call on an expensive lane.** Classification without a pinned
   target took 82 s because it inherited the operative's full toolset.
2. **A budget shorter than the work.** `ask_zeca` allowed 8.5 s for a lane that
   takes 8-82 s, so every real question timed out and the question was discarded
   rather than queued.
3. **A closed intent set with no escape hatch.** Spoken commands could only
   create cards or notes, so "send Ana a message" had nowhere to go, and the
   answer came from a model with no tools and no data.
4. **A flag read in a process that never received it.** The triage job's notifier
   gated on `notifyEnabled`, absent from its env, so every card silently
   degraded away from the phone.
5. **A credential that was never passed.** Chat delivery skipped as "not sealed"
   because the API client was constructed without the key it needed, while the
   push using a different key worked - so the failure looked like configuration.
6. **A test window shorter than the system's own period.** The harness called a
   healthy pipeline broken and blamed the scheduler.
7. **A retry schedule narrower than the limit it fought.** 1 s + 2 s against a
   rate-limit window measured in minutes.
8. **An unreadable delivery.** The message arrived, the API returned 200, and the
   operator still could not read it - because the surface truncated and its tap
   target was empty.
