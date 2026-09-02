# The Garrison app: one app, the web channel home, one voice layer

**Date:** 2026-09-01 (G0), updated per gate.
**Plan:** "Garrison app plan: one app, the web channel home, one voice layer,
screencast inside conversations" (September 2026), run as one autonomous task
on the `node/goncalos-macbook-pro` branch.
**Supersedes:** [2026-07-13 Capacitor native-wrap memo](./2026-07-13-capacitor-native-wrap-memo.md)
("do not wrap now"). Its three revisit triggers all hold today: background /
lock-screen voice is a hard requirement (the companion already records with the
screen locked), APNs push is in production, and the app leaves the developer's
hands (TestFlight). The memo's "low-regret path" is exactly what this run does:
Capacitor loads the same web build, native plugins only where a capability
forces them.

This file records every choice the plan left to defaults, every place the plan's
premises disagreed with the live code (code wins), and the per-gate file list.
Evidence per gate lives under `evidence/garrison-app/<gate>/`.

## 0. How this run is executed (topology, verified 2026-09-01)

| concern | where | why |
|---|---|---|
| node-side code, deploy, playwright, vitest | this MacBook Pro, launchd `io.garrison.node`, shell on 127.0.0.1:8777, published at `https://goncalos-macbook-pro.tail31efa.ts.net` (443 -> 8777) | it is the node the plan names |
| `xcodebuild test` (ios/Tests) | `goncalos-mac-mini-1`, clone at `~/build/garrison-ios` tracking `node/goncalos-macbook-pro`, Xcode 26.2, `APPLE_TEAM_ID=4JSNLRYB52 xcodegen generate` | the MacBook Pro has Command Line Tools only, no Xcode.app, ~10 GiB free disk; the mini's live checkout `~/dev/garrison` is on its own node branch and is never touched |
| TestFlight (`fastlane beta`) | GitHub Actions workflow `garrison-ios.yml` in the private repo `gongiskhan/ios-thing`, dispatched with `-f lane=beta -f garrison_ref=node/goncalos-macbook-pro` | the five credentials `scripts/ios-testflight.sh` requires (`ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8 APPLE_TEAM_ID MATCH_PASSWORD`) exist only as secrets of that repo; no Mac holds them. 8/8 recent runs green, 3-4 min each |
| phone install | TestFlight on the operator's iPhone (`iphone172` on the tailnet) | "the phone is the criterion" |

Consequences: every native gate ends with a push of the node branch followed by
a workflow dispatch; the run cannot attach a debugger to the phone, so native
evidence is TestFlight build numbers plus capture-service server logs of what
the phone did.

### Disagreements with CLAUDE.md found in G0

- CLAUDE.md says prod is the systemd unit `garrison-prod.service`. On this Mac
  the supervisor is launchd `io.garrison.node` and the installer's Linux unit is
  `garrison-node.service`; `scripts/garrison-redeploy.sh` / `garrison-reload.sh`
  detect systemd first, then launchd, so both scripts work here unchanged.
- The memory note "tailnet address ...:8445 -> 7777 under io.garrison.dev" is
  dead: the shell is at the bare host (443 -> 8777); `io.garrison.dev.plist`
  exists but is not loaded.
- Listing vault keys with `cut -d= -f1 compositions/default/.env` leaks value
  lines: several values are multi-line quoted blobs. Use
  `grep -oE '^[A-Z0-9_]+=' compositions/default/.env` for key names only
  (the digit matters: `APNS_P8` is a key).

## 1. Decisions taken by this run (defaults the plan left open)

### D1. Capacitor shape A, without the Capacitor CLI on the native side

Shape A (keep XcodeGen, add Capacitor as a Swift package) is the choice, with
one correction the probe forced: `@capacitor/ios` 7.x and 8.x ship only
podspecs, and `@capacitor/cli` hardcodes the native layout `ios/App/App` +
`App.xcodeproj` (SPM mode detected through `App/CapApp-SPM`). `npx cap sync
ios` can therefore never drive `ios/Garrison.xcodeproj` + `ios/GarrisonApp`.

So:

- **Runtime**: `https://github.com/ionic-team/capacitor-swift-pm.git`, product
  `Capacitor`, pinned to the same major/minor as the JS side, declared in
  `ios/project.yml` `packages:` exactly like `CoreBluetoothMock` already is, and
  added to the `GarrisonApp` target dependencies. `Cordova` is not linked (no
  Cordova plugins).
- **Version**: Capacitor **8.5.1** (`@capacitor/core` 8.5.1 in the shell's
  `package.json`, `capacitor-swift-pm` tag 8.5.1). It needs Xcode 16+ and iOS
  15+; the project targets iOS 17.0 and builds on Xcode 26.2 / `macos-26`.
- **Config**: a hand-maintained `ios/GarrisonApp/Resources/capacitor.config.json`
  bundled as a resource (`CapacitorBridge` reads `capacitor.config` from
  `Bundle.main`). No `capacitor.config.ts`, no `webDir` stub in the tree: the
  bridge warns `missingAppDir` when `public/` is absent, which is a logged line,
  not a failure, and there is nothing to bundle - the shell is loaded from the
  node over the tailnet (`server.url`). The bundled `server.url` is a placeholder;
  the real origin is set at runtime by `GarrisonNode` (see D4).
- **Host**: `@main struct GarrisonApp: App` stays (the source-text test
  `testPendantIsOwnedByTheAppNotByAView` asserts on its contents). The SwiftUI
  root becomes a `UIViewControllerRepresentable` hosting
  `GarrisonBridgeViewController: CAPBridgeViewController`, which overrides
  `capacitorDidLoad()` to register the five plugins by instance.
- **First shipping-target dependency**: ADR D11 ("zero third-party frameworks
  in shipping targets") is knowingly retired by the plan's Capacitor decision;
  `docs/adr-companion.md` gets a superseded-by note in G3.
- **Fallback B** (Capacitor-generated project) is not needed; recorded here as
  rejected because it would move the broadcast extension, entitlements and the
  manual-signing rules the ADR calls load-bearing.

### D2. Web channel becomes the shell route `/talk`, named "Conversations"

- Route: `src/app/talk` (list) and `src/app/talk/[conversationId]`. Sidebar
  Command entry "Conversations". The old surface `web-channel-default` keeps its
  code and its port and is **unstationed by default** in `compositions/default`
  and `compositions/openai` (D16); removal of the code is a later,
  operator-triggered follow-up (plan section 7, invariant I12).
- The gateway stays where it is; the shell reaches it through ONE Next route,
  the optional catch-all `src/app/api/[[...path]]/route.ts`, which mounts the
  talk router (`createTalkRouter` from `@garrison/talk`) behind the
  Request/Response shim in `src/lib/node-handler-shim.ts`. Next's route
  precedence keeps every specific `src/app/api/<name>/` route ahead of it, so
  the shell's own API is untouched and the talk paths (`/api/chat`,
  `/api/threads`, `/api/push/*`, `/api/voice/*`, `/api/stream`,
  `/api/session-stream`, `/api/claude/*`, `/api/notify`, ...) resolve on the
  app at the paths the transports already used. One engine per process on
  `globalThis.__garrisonTalkMount`; the gateway URL is read live from
  `activeGatewayBaseUrl()`. The browser only ever sees same-origin URLs.
  (G0 had planned one mount per path family; a single catch-all is what shipped
  because the router already dispatches on pathname and eleven near-identical
  mounts would have been eleven places to keep the shim contract.)
- The follow-up "ready commit on a branch" the plan asks for in section 7
  collides with the repository's no-new-branches hard rule (CLAUDE.md, AGENTS.md
  "Branch discipline"). Resolution: the removal is prepared as a **patch file**
  under `evidence/garrison-app/g8/remove-web-channel-default.patch`, applied by
  the operator with `git apply` when they decide. No branch is created.

### D3. capture-service is the voice layer (`kind: voice`)

- `fittings/seed/capture-service/apm.yml` gains `provides: - kind: voice, name:
  companion` next to `kind: channel`. `deepgram-voice` is unstationed from
  `compositions/default` and de-listed; its directory stays until the operator
  deletes it (I12).
- The browser push-to-talk and read-aloud endpoints are served by
  capture-service and authenticated with the capture token, which the shell
  obtains server-side (the token never reaches the page as a literal; the shell
  proxies).
- Native fallback exception to I7 ("exactly one TTS path"): `SpeechSink` keeps
  its on-device `AVSpeechSynthesizer` fallback when an ack arrives without
  `audioPath`. Reason: an ack that cannot be spoken because a remote TTS call
  failed is worse than a robotic ack; the plan's intent (one voice layer that
  decides what is said and produces the clip) is preserved, the device only
  fills silence. Documented in `docs/COMPANION_IOS_SPEC.md` in G2.
- TTS backend selection: capture-service's `ZecaVoice` (`lib/tts.mjs`) keeps
  ElevenLabs when `ELEVENLABS_API_KEY` is sealed and otherwise synthesises with
  Deepgram Aura (`POST /v1/speak`, the model deepgram-voice used, keyed by the
  `DEEPGRAM_API_KEY` capture-service already holds). Both produce mp3 clips
  through the same content-hash cache and the same `/speak/<id>.mp3` path.
  Reason: `ELEVENLABS_API_KEY` is not in this node's vault (key names listed
  with the grep above, no value read), so "one voice layer" would otherwise
  mean "no read-aloud in the browser" here. The handoff lists ElevenLabs as an
  optional credential, not a blocker.
- STT for browser push-to-talk is a one-shot REST call (`POST /stt`, body =
  the recorded clip, Deepgram `/v1/listen` behind it). capture-service's live
  lane (`lib/deepgram-live.mjs`) is Opus-packet streaming per session and a
  `MediaRecorder` clip is a webm container, so the REST path is the honest one
  (reader evidence in section 3).

### D4. Node record: shell origin + capture-service URL + token

The App Group today stores one endpoint, `capture.baseURL`, and it is the
capture-service base (port 84xx serve port), not the shell origin the webview
loads. The BroadcastExtension, `PendantController`, `ClipPlayer` and
`AppGroup.request` all read `capture.baseURL` / `capture.token` at use time.

`GarrisonNode` therefore stores a list of node records
`{name, shellOrigin, captureBaseURL, token}` under new App Group keys and, on
`set(...)`, **also rewrites** `capture.baseURL` / `capture.token` so every
existing consumer keeps working without edits. The capture-service URL is
derived from the shell origin plus the mesh serve-port invariant (8400 +
8097 % 1000 = 8497) but stored explicitly, because this Mac's serve map is
off-formula for ten fittings (stale 7xxx-era entries force collision bumps).

### D5. Push deep links are new plumbing, not a wrap

No URL scheme, no associated domain, no `.onOpenURL`; `PushManager.didReceive`
only appends to `AckLog`. G4 defines the payload key `data.path` (a shell path:
`/talk/<conversationId>` or `/embed/kanban-loop?card=<id>`) in
`capture-service/lib/apns.mjs` / `notify.mjs`, and the native handler loads
`shellOrigin + path` into the bridge webview. `UIBackgroundModes` gains `audio`
(there was none; only `bluetooth-central`) in G3.

### D6. Screen-audio recording starts from the system picker only

ReplayKit broadcasts begin only when the user taps `RPSystemBroadcastPickerView`;
native code can present the picker, not start the broadcast, and learns the
outcome through the App Group heartbeat (8 s staleness). `GarrisonCapture.start
({kind: "screen_audio"})` is therefore "present picker, then poll heartbeat";
`captureState` derives from `AppGroup.isBroadcasting` / `broadcastError`.

### D7. Pendant plugin surface follows the transport, not the plan's sketch

`PendantBLETransport` scans filtered on the audio service and auto-adopts the
first identified peripheral; there is no discovered-list API. `GarrisonPendant`
exposes `status()`, `connect()`, `disconnect()`, `forget()` and the
`pendantState` / `pendantBattery` events. `scan()` returning a pick-list is
dropped (would need a new transport API for no user-visible gain: there is one
pendant).

### D8. Working-tree hygiene

`compositions/default/apm.yml` and `apm.lock.yaml` show a permanent
uncommitted diff on this Mac: the runner's autosave strips comments from the
manifest and the local `apm` 0.11.0 rewrites the lock generated by `apm`
0.24.0 on dev-madrid (drops `name`, `version`, `deployed_file_hashes`). Those
two files are committed only when this run changes stationing deliberately
(G1, G2), and then only the intended hunks. Never `git add -A`.

### D9. Browser voice is REST through the shell; no WebSocket in the Next app

The shell runs under plain `next start` (`scripts/garrison-instance.sh:249`);
App Router route handlers cannot upgrade a socket, and adding a custom server
would change every profile's launcher for one feature. So `/talk` does
push-to-talk as record -> `POST /api/voice/stt` -> transcript, and read-aloud as
`POST /api/voice/tts` -> mp3 clip -> `<audio>`. Both are Next route handlers
that call capture-service server-side with the capture token from the vault; the
page never holds the token (I5) and never opens a second origin for voice (I1).
What is dropped: interim transcripts while the button is held and the Aura-2 PCM
`/tts-stream` path (`voice-capture.ts`, `voice-tts.ts`, `pcm-worklet.js`). The
`voice-machine.ts` reducer keeps `ptt` mode and loses nothing observable; the
dev-env fitting keeps its own `/voice/*` bridge (it already proxies REST only).

### D10. The talk engine moves to `packages/talk`; the fitting becomes a thin host

`web-channel-default` is `scripts/server.mjs` (3485 lines of handlers +
listener) plus `scripts/threads.mjs` (2289) plus eight `lib/*.mjs` and the
React UI under `ui/`. I12 says the fitting survives until the operator's
follow-up, and the follow-up must be a small ready patch, so the code cannot be
copied into the shell (two drifting copies) nor left in the fitting with the
shell importing across (`src/lib/*.ts` does import from `fittings/seed/` today,
but then the removal patch would have to move it all). The shared home the repo
already uses for exactly this is `packages/` (`@garrison/claude-chat`,
`@garrison/claude-pty`, linked with `file:` deps). G1 creates `@garrison/talk`
holding the thread store, the handlers and the UI; the fitting's `server.mjs`
and `ui/main.tsx` shrink to hosts that import from it, and the shell mounts the
same handlers at the SAME paths the transports already use (`/api/chat`,
`/api/threads`, `/api/push/*`, `/api/voice/*`, `/api/attachments`,
`/api/brief`, `/api/route-options`, `/api/mesh-threads`, `/api/stream`,
`/api/session-stream`, `/api/claude/*` - none collide with an existing shell
route) through the Request/Response shim the `/api/conversation` mount already
has. Thread files stay at `$GARRISON_HOME/web-channel/threads/<id>.json` so
existing conversations survive the move. The remote-shell workbench's
`/remote-shell/io` socket (the one non-voice WebSocket) connects straight to the
remote-shell fitting's published serve port through `resolveViewUrl`, the same
mechanism every embedded own-port view already uses.

### D11. The route is "Conversations" at `/talk`; roadmap c8.1 is decided by the plan

Roadmap c8.1 left the name open (Signals / Adjutant / CIC). The plan says
"Conversations" and lists it under decisions not to reopen, and the route
renders the conversation store `docs/CONVERSATIONS.md` describes, so the shared
word is alignment, not collision. c8.1 and c8.3 are marked done in G8 with that
name. Roadmap c8.4's preconditions ("c1 in daily use, c3 widgets exist") are
overridden by the plan; G8 records the override in the item text rather than
pretending the preconditions were met.

### D12. Provider discovery by capability, not by filename

`web-channel-default` and `dev-env` find the voice provider by reading the
hardcoded status file `~/.garrison/ui-fittings/deepgram-voice.json`; nothing
projects the resolved provider. G2 has the runner project
`GARRISON_VOICE_FITTING_ID=<provider id>` into the env of every fitting whose
`consumes` includes `voice` (the resolver already knows the pairing), and the
two consumers read `ui-fittings/<that id>.json`. `dev-env` declares the
`consumes: voice optional-one` it silently relied on.

### D13. The Deepgram connector survives on capture-service as `connector: voice`

`deepgram-voice` also provides `kind: connector, name: deepgram` (actions
`transcribe`, `synthesize`) and the automations fitting maps connector id
`deepgram` to it. Retiring the fitting must not silently break an automation, so
capture-service provides `kind: connector, name: voice` with the same two
actions on the same REST endpoints, and `connector-invoke.mjs` maps both
`voice` and the legacy id `deepgram` to `capture-service`.

### D14. Mac recording (G5) is a capture-service client, not a new pipeline

I8 says one record path. The phone path is: broadcast extension ->
`WS /capture/stream` mode `screen_audio` (JPEG frames + Opus audio) ->
capture-service session. `screen-share-default` already captures the Mac screen
as JPEGs (`screencapture -x`, ~1 fps) and this Mac has `ffmpeg`, `sox` and
`rec` under `/opt/homebrew/bin`. So G5 gives screen-share-default
`POST /record/start`, `POST /record/stop`, `GET /record/state` that open the
same capture-service socket as the phone (mode `screen_audio`, its own capture
token from the vault via `secret_scope`), push the frames it already has and
mic audio encoded to Opus with `ffmpeg -f avfoundation`; when `ffmpeg` is
absent the recording is frames-only and says so. The digest is built once in
capture-service at session end (next to `lib/screen-context.mjs`, on the cheap
inference lane, reusing `buildConversationDigest` where the transcript is a
conversation) and posted into the conversation through
`POST /api/conversation/<id>/message`, which is how the phone's digest lands
too. No "Watch" aptidao exists in the repository to reuse (grep over `docs/`,
`roadmap.json`, `fittings/`).

### D15. Gate evidence is versioned

`evidence/` was gitignored as transient mesh-run output. The plan wants
per-gate evidence committed, so `.gitignore` now ignores `evidence/*` except
`evidence/garrison-app/` (large media types under it stay ignored). Reader
output is kept verbatim as JSON so a later gate can cite a file:line without
re-reading the tree.

### D16. "Disabled by default" means unstationed

A composition selection has no `enabled` flag (`x-garrison.composition.selections`
carries `id` + `config` only; `compositions/default/apm.yml`). The two honest
states are stationed (started by `up()`) and absent. G1 therefore removes
`web-channel-default` from the `channels` selection and the `dependencies.apm`
list of `compositions/default` and `compositions/openai` and from their
lockfiles; the fitting stays in `fittings/seed/` and `data/library.json`, so
re-stationing it is one Compose click. A stationed-but-stopped state would have
needed a new schema field for a surface that is on its way out.

### D17. Cross-node Conversations run through the peer's app origin

Before G1 the mesh reached a peer's threads on the web-channel fitting's
published serve port (`8400 + 8083 % 1000`) and deep-linked to
`https://<peer>:8483/?thread=`. With the talk API on the app, the peer's app
origin (`https://<peer-tailnet-host>`, root serve to the app port) answers
`/api/threads...` directly, so `src/lib/mesh/peer-proxy.ts` loses the
serve-port arithmetic, the control-port cache and `peerControlBase`; every
thread row in the allow-list is `upstream: "app"`, and `peerThreadUrl()` builds
`https://<peer>/talk/<id>`. `packages/talk/src/mesh-threads.mjs` builds the same
link for the Conversations sidebar. The http-gateway session registry
(`scripts/lib/session-registry.mjs` `controlSurface()`) reports the app as each
session's control surface from `GARRISON_APP_URL`, which `spawnGateway` now
projects exactly as own-port fittings receive it; the legacy status-file read
remains the fallback for a gateway started without it. Live `tailscale serve
status` had no 8483 mapping on this machine, so the old path was already
unreachable off-box.

### D18. The talk skin is scoped to a host element; the shell service worker carries push

`packages/talk/ui/styles.css` used to style `html`/`body`/`#root` because the
fitting owned its document. Inside the shell those selectors would restyle
Garrison itself, so every document-level rule now hangs off `.talk-host`: the
fitting's `#root.talk-host` and the shell's `<div class="talk-host talk-page">`
(`src/components/talk/TalkPage.tsx`). Tests that mount the UI in a bare
document must add the same ancestor or no token resolves (the focus-ring test
in `tests/claude-chat-session-events-browser.test.ts` is the example). Web push
is a per-origin service-worker concern, so `public/sw.js` (already registered
by the root layout) gained the fitting's `push`, `notificationclick` and
`pushsubscriptionchange` handlers with `/talk` as the default deep link; the
fitting's `ui/sw.js` survives for the legacy host only.

### D19. Consumers reach Conversations app-first; Discuss opens a shell route

Every fitting that posted into the web channel located it through
`~/.garrison/ui-fittings/web-channel-default.json`. With the fitting
unstationed that file is gone, so the resolution order becomes: the app
(`GARRISON_APP_URL`, which the runner projects into every own-port fitting,
setup hook and the gateway) first, the legacy status file second, else skipped
with a reason that names both. The thread API paths already start with
`/api/`, which both hosts accept. Because both hosts share one thread store
(`<GARRISON_HOME>/web-channel/threads/`), the notify fan-outs (kanban-loop
`notify-origin.mjs`, improver `probe-notify.mjs`) add the app as a target and
skip any `web-channel*` status file while `GARRISON_APP_URL` is set, so a
reminder lands once. Discuss links stop targeting `/embed/web-channel-default`:
`buildDiscussUrl` (kanban-loop) and `buildAutomationDiscussUrl` (automations)
default to `/talk`, kanban's `/board/runtime` reports `conversationsRoute:
"/talk"` in place of `webChannelEmbedId`/`webChannelUrl`, and an embedded
fitting asks the shell to open it with a second window-message contract,
`garrison:navigate-route` (`{route, params}`, route allow-listed to `/talk`)
beside the existing `garrison:navigate-fitting`, handled in
`src/app/embed/[fittingId]/page.tsx`. A fitting never hands the browser an
absolute loopback URL; the shell route is relative.

## 2. Stale premises (plan or docs vs code; code wins)

| premise | reality | evidence |
|---|---|---|
| G0/G3 can build and test iOS "locally" | no Xcode on this Mac; XCTest runs on the mini, TestFlight in the ios-thing workflow (section 0) | `xcode-select -p` = CommandLineTools |
| Capacitor added "as Swift packages" via the npm packages / CLI | npm packages carry podspecs only; SPM lives in `capacitor-swift-pm`; the CLI cannot target the XcodeGen tree (D1) | `@capacitor/ios` 8.5.1 tarball; `@capacitor/cli` `dist/config.js` |
| "Background: audio and Bluetooth background modes stay" | only `bluetooth-central` exists; `audio` must be added | `ios/GarrisonApp/Info.plist` |
| `GarrisonPush` wraps an existing deep-link handler | none exists (D5) | `ios/GarrisonApp/PushManager.swift` |
| `GarrisonNode.set(url, token)` persists "the node URL" | the stored URL is the capture-service base, not the shell origin (D4) | `ios/Shared/AppGroup.swift` |
| `GarrisonCapture.start(screen_audio)` starts the session | only the user's tap on the system picker starts a broadcast (D6) | `ios/GarrisonApp/BroadcastPicker.swift`, `BroadcastExtension/SampleHandler.swift` |
| `GarrisonCapture` emits `transcriptSegment` from an existing source | only `PendantView.TranscriptStream` (SSE on the capture-service origin) reads a live transcript; audio mode has none | `ios/GarrisonApp/Pendant/PendantView.swift` |
| `GarrisonPendant.scan()` lists pendants | transport auto-adopts; no list (D7) | `ios/GarrisonApp/Pendant/PendantBLETransport.swift` |
| deleting the SwiftUI screens is test-neutral | `PendantFeedbackMappingTests.testPendantIsOwnedByTheAppNotByAView` reads `PendantView.swift` and `GarrisonApp.swift` from disk | `ios/Tests/PendantFeedbackMappingTests.swift:72-95` |
| capture-service "is nearly" the voice provider | it provides `channel: companion` only; `deepgram-voice` is the sole `kind: voice` provider and `web-channel-default` consumes it `optional-one` | `fittings/seed/capture-service/apm.yml`, `deepgram-voice/apm.yml` |
| capture-service default port 8097 everywhere | `lib/config.mjs` `DEFAULT_PORT = 7097` (stale base family); the env-less verify probe prints `port=7097` | `fittings/seed/capture-service/lib/config.mjs:15` |
| `scripts/ios-testflight.sh` header: first run uses `FASTLANE_LANE=bootstrap` | the Fastfile has deliberately no bootstrap lane | `ios/fastlane/Fastfile` |
| `docs/adr-companion.md` toolchain (XcodeGen 2.46, match repo `ios-certificates`) | xcodegen 2.45.4 here; match repo is `gongiskhan/ios-thing` branch `match-certs` | `ios/fastlane/Fastfile` |
| `/embed/<id>` needs work to resolve tailnet HTTPS | it already does (`/api/fittings/views` attaches `tailnetUrl`; `resolveViewUrl` picks it by page host). The gap is mesh-side: `meshServePort()` does not model collision bumps and this Mac is off-formula for ten fittings | `src/lib/mesh/peer-proxy.ts`, `tailscale serve status` |
| a "Watch" aptidao (screen recording digest) may exist | not in this repository (checked in G0 round 2, see section 3) | grep |
| CLAUDE.md: `compositions/<id>/apm.yml` "= source of truth per composition. Filesystem is authoritative" | on an ENROLLED node the state service is the manifest source: `up()` calls `syncCompositionFromState`, which overwrites the local `apm.yml` whenever its hash differs, so a git edit to a manifest is undone at the next `up()` until the same YAML is pushed to the service (`pushManifestToState`, rev CAS). G1's manifest commit was clobbered by its own redeploy this way; the fix was pushing the HEAD YAML to the service (default rev 28 -> 29, openai rev 2 -> 3), then `down` + `up`. Every future gate that edits a manifest pushes it the same way | `src/lib/composition-sync.ts`, `src/lib/runner.ts` (`up`), G1 evidence `redeploy.txt` |
| a manifest edit through the shell keeps the file as authored | the only production writer, Muster's `mutateManifestAtomic`, re-dumps the YAML and strips every comment; the state copies of both compositions had zero comment lines. Comments in a manifest survive only as long as no Muster mutation happens; the G1 push restored them, and they are not relied upon | `src/app/api/muster/model.ts` (`dumpYaml`) |
| `apm.lock.yaml` is portable and committable from any node | the lock is node-local by design (`composition-sync.ts` never carries it) and its shape follows the node's APM: this Mac runs APM 0.11.0 (no `name`/`version`/`deployed_file_hashes`), dev-madrid wrote the committed lock with 0.24.0. A lock regenerated here reads as 135 deleted lines. The committed lock is dev-madrid's; this run restores it from HEAD after every `up()` and does not commit the Mac's | `apm --version`, `git diff compositions/default/apm.lock.yaml` after `up()` |

## 3. Recon facts that shape the gates

Round-2 reader output (six narrow readers, each fact with a file:line) is
saved verbatim in `evidence/garrison-app/g0/recon-round2.json`; round 1
(environment + iOS) in `recon-environment.json`. The facts below are the ones
a later gate depends on.

**Shell (G1, G4, G6)**

- Sidebar Command entries are data: `COMMAND_ITEMS` in
  `src/components/chrome/Sidebar.tsx:412-470` (`nav:*` id, href, label, lucide
  icon, `isActive`), sorted alphabetically at :601-604; the Fittings group is
  built at :608-646 from `composition.selections` x `data/library.json`. Pins go
  through `GET/PUT /api/sidebar-pins`; `PIN_ID_PATTERN`
  (`src/lib/sidebar-pins.ts:31`) already accepts `nav:conversations`.
  `tests/sidebar-grouping.test.ts:47-59` hardcodes the Command hrefs.
- A phone drawer already exists: `AppShell.tsx` `NARROW_BREAKPOINT = 720`
  (duplicated at `Sidebar.tsx:296`), overlay dialog at `Sidebar.tsx:91-145`;
  below 720 px own-port views open in a new tab (`Sidebar.tsx:293-296`) - the
  one behaviour the app must override (G6).
- Shell PWA exists: `src/app/manifest.ts` (per-node name and icons),
  `public/sw.js` (52 lines: install/activate/fetch only, no `push` or
  `notificationclick` handler), `ServiceWorkerRegistrar` in `src/app/layout.tsx`.
- `GET /api/mesh/nodes` -> `{nodes: MeshNodeRow[], self, degraded}` (id, name,
  accentColor, tailnetHost, platform, status, state, lastSeenAt,
  activeComposition, capabilities, health, isSelf, registered; 503 when the
  state service is down); `peerAppBase(tailnetHost) = https://<host>`
  (`src/lib/mesh/peer-proxy.ts:176-190`). No node switcher exists: only
  `MeshPanel.tsx:312-320` ("Open <node>" new tab) and `NodeBadge.tsx:43-48`
  (-> `/mesh`).
- `/embed/[fittingId]/page.tsx` resolves `tailnetUrl` from
  `/api/fittings/views` and offers "Publish now"
  (`POST /api/fittings/<id>/publish`); the iframe carries
  `allow="clipboard-read; clipboard-write; microphone; autoplay"`.
- The shared conversation router is already mounted at
  `src/app/api/conversation/[...path]/route.ts` with `RequestShim` /
  `ResponseShim` (SSE becomes a `ReadableStream`); the shell has no
  `/api/{chat,threads,push,notify,voice,stream,route-options,mesh-threads,brief,claude,attachments,session-stream}`
  route, so the fitting's paths are free (D10).
- `tests/vocabulary.test.ts` bans `operative(s)` in `src/**/*.{tsx,css}`, every
  `fittings/**/apm.yml`, and the surfaces listed at :143-145 (`src`,
  `fittings/seed/web-channel-default/ui`, kanban-loop ui) with per-file
  allowances at :321-342 for `remote-shell-workbench.tsx`, `shells-modal.tsx`,
  `main.tsx`.
- Next runs as plain `next start` / `next dev` (`scripts/garrison-instance.sh:249-274`);
  no custom server, so no WebSocket upgrade in the app (D9). `next.config`
  has no basePath/assetPrefix/rewrites; `distDir` comes from `NEXT_DIST_DIR`.
- Packages are `file:` deps symlinked under `node_modules/@garrison/`
  (`claude-chat`, `claude-pty`, `state-client`); `@garrison/claude-chat` is
  source-only TSX consumed by the shell already
  (`src/components/garrison/{RouterFeedbackCard,OutboxStrip}.tsx`).

**web-channel-default (G1)**

- Layout: `scripts/server.mjs` (3485 lines, router at :3292-3382, thread routes
  `routeThreads` at :2545-2572, WebSocket upgrades at :3400-3430 for
  `/remote-shell/io`, `/api/voice/stream`, `/api/voice/tts-stream`),
  `scripts/threads.mjs` (2289 lines; `THREADS_DIR` at :46 =
  `$GARRISON_HOME/web-channel/threads`), `lib/{live-event-stream,mesh-threads,push-store,session-transcript,state-client,tailnet-serve,thread-registry,webpush}.mjs`,
  `ui/` (`main.tsx` 2036 lines + transports, voice, rail, remote-shell,
  `pcm-worklet.js`, `sw.js`, `pwa-assets.mjs`, `build.mjs` esbuild ->
  `dist/web-channel.bundle.js`). There is no `server/` dir and no
  `PROGRESS-WEB-PARITY.md` anywhere; parity is defined only by
  `tests/e2e/web-channel-session-parity.spec.ts` (real server + real bundle +
  fake gateway speaking canonical session-event fixtures, survival across a
  process restart via `agentSdkResumeFromThread`).
- Gateway URL = `GARRISON_GATEWAY_URL` or `--gateway-url`, else
  `http://${GARRISON_GATEWAY_HOST||127.0.0.1}:${GARRISON_GATEWAY_PORT||4777}`;
  port fallback `7083` (both pre-re-axis literals; harmless under the runner,
  fixed in passing). The shell knows the gateway through
  `activeGatewayBaseUrl()` (`@/lib/runner`).
- SSE frames handled by name: `open`, `route`, `session_event`, `done`,
  `error`; decoded by `SseFrameDecoder`, appended per thread via
  `appendLiveFrame` (:413-431, :596-627, :1220-1227). Transports are all
  relative: `conversation-transport.ts` (`/api/conversation`),
  `orchestrator-transport.ts` (`/api/chat`, `/api/chat/answer`,
  `/api/chat/interrupt`, `/api/attachments`).
- Push is home-grown VAPID (`lib/webpush.mjs`; subscriptions at
  `$GARRISON_HOME/web-channel/push-subscriptions.json`; keys from
  `VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT` via `secret_scope`);
  `ui/sw.js` handles `push` (notification with `data.link`, up to 2 actions) and
  `notificationclick`.
- Voice consumer: `VOICE_STATUS_FILE` hardcoded to
  `~/.garrison/ui-fittings/deepgram-voice.json` (:97); proxies
  `/api/voice/health|stt|tts` (:281-345) and relays the two sockets (:359,
  :3400-3402). Browser code is same-origin only and unauthenticated
  (`voice-capture.ts:6,68,108`, `voice-tts.ts:2,39,61`,
  `voice-conversation.tsx:30,157-162`); `voice-machine.ts` is a pure reducer.
- Mesh rail: `lib/mesh-threads.mjs` over `lib/state-client.mjs`, served at
  `GET /api/mesh-threads`, rendered by `ui/sessions-rail.tsx`; the thread index
  lives in the state service config doc `web-channel.threads` / `node:<name>`.
- Playwright: `playwright.web-channel.config.ts` drops the Next webServer and
  matches `web-channel-(chat|session-parity).spec.ts`; both specs spawn
  `scripts/server.mjs` with a fake gateway and `page.goto(http://127.0.0.1:<port>/?console=1)`.
  Vitest has 13 `tests/web-channel-*.test.ts` suites importing the fitting's
  modules by path.

**Voice (G2)**

- `voice` is a singleton capability kind (`src/lib/types.ts:158,186-193`);
  provided only by `deepgram-voice` (faculty `connectors`, port 8085, also
  `kind: connector, name: deepgram` with actions transcribe/synthesize);
  consumed by `web-channel-default` (`optional-one`) and, undeclared, by
  `dev-env` (`scripts/server.mjs:95, 858-954` proxies `/voice/{health,tts,stt}`
  for `packages/claude-chat/src/voice.ts`).
- deepgram-voice contract (`scripts/server.mjs:144-150, 744-767`):
  `GET /health`, `POST /stt` (raw audio, content-type default `audio/webm` ->
  `{transcript, confidence}`), `POST /tts` (`{text, format}` -> audio),
  `WS /stream?sample_rate&utterance_end_ms` (linear16 ->
  `ready|speech_started|transcript|utterance_end|error`),
  `WS /tts-stream?sample_rate` (`speak|flush|clear|close` -> `ready` + PCM);
  models nova-2 / aura-asteria-en / aura-2-thalia-en; missing key -> 503.
- capture-service (faculty `channels`, port 8097, `lib/config.mjs`
  `DEFAULT_PORT = 7097` stale): provides only `channel: companion`
  (`apm.yml:365-370`); routes `GET /speak/<hex>.mp3` (unauthenticated clip),
  `GET /health`, `/`, `/sessions/<id>[/events]` (SSE), Bearer-gated
  `/capture/{devices,sessions,exchanges}`, token-less `POST /notify` and
  `POST /ack`, `WS /capture/stream` only (`lib/ingress.mjs:123` refuses other
  paths); any other `/capture/*` -> 501 (`server.mjs:588-596`). Auth ladder
  `authorizeHttp` (:269-285): disabled -> 403, no token sealed -> 403, bad
  bearer -> 401, timing-safe compare.
- STT is `lib/deepgram-live.mjs` `TranscriptionLane`: one Deepgram live socket
  per session, `encoding=opus&sample_rate=16000&channels=1`, nova-3, `pt`,
  endpointing 300, injectable `wsFactory` (mock at `scripts/mock-deepgram.mjs`).
  No one-shot/batch path exists. TTS is `lib/tts.mjs` `ZecaVoice`: ElevenLabs
  `text-to-speech/<voiceId>?output_format=mp3_44100_128`, cache
  `$GARRISON_HOME/capture/tts-cache/<sha>.mp3`, `available()` fails closed
  without `ELEVENLABS_API_KEY` (ack then ships without `audioPath`). Injectable
  `fetchImpl`.
- Gateway client (`lib/gateway-client.mjs:29-173`): `POST ${gatewayUrl}/chat`,
  header `x-garrison-origin: channel`, `channel: "garrison"`, three lanes
  (inference pinned `T0-trivial`, operative with `sessionId`/`sessionTitle`,
  discuss `routing:{duty:"discuss", level}`); continuity is the gateway
  `sessionId` (`<originPrefix>-wake:<captureSessionId>`); only `discussRunFn`
  surfaces `session_id` today (:170). No "James,/Joe," mode words anywhere
  (retired per `docs/CAPABILITIES.md:329-334`).
- `POST /notify` body `{text, title?, link?, tag?, idempotencyKey?}`; APNs
  payload `{title, body, data:{link, tag}}` (`lib/notify.mjs:266`); no route /
  node / conversation fields; degrades to a web-channel thread
  `companion-reports` resolved from `ui-fittings/web-channel-default.json`.
  Devices at `$GARRISON_HOME/capture/devices.json` (none registered on this
  node; 286 web fallbacks in the ledger).
- Store (`lib/store.mjs`): `$GARRISON_HOME/capture/{sessions,transcripts,media/<id>/frames,events,index.json,devices.json,notify-ledger.json,counters-*.json}`;
  status file `ui-fittings/capture-service.json`.
- References to `deepgram-voice` that G2 must touch: `src/components/chrome/Sidebar.tsx:324`
  (icon map), `src/lib/own-port-lifecycle.ts:214` (comment),
  `fittings/seed/automations/lib/connector-invoke.mjs:102`,
  `data/library.json:201-210`, `compositions/default/apm.yml:15,300`,
  `compositions/openai/apm.yml:15,276`, tests
  `capabilities:119-139`, `seed:22,94`, `own-port-lifecycle:203-211`,
  `vault-heal:35,616-618`, `matrix-harness:32`, `connector-deepgram`,
  `deepgram-voice-live`, `voice-machine`, `voice-latency`; docs `CLAUDE.md:402`,
  `docs/{CAPABILITIES,CAPABILITY_CONTRACT,FITTINGS,INSTANCES,RUNTIME_MATRIX,COMPANION_IOS_SPEC}.md`,
  `packages/claude-chat/src/voice.ts:2`. `tests/mesh-serve-ports.test.ts`
  asserts distinct serve ports over the committed own-port defaults.
- Vitest sandboxing: `tests/setup.ts:19-28` points `GARRISON_HOME` at a
  mkdtemp when unset; capture-service and omi-channel suites boot the server
  with an injected env and assert on `ui-fittings/<id>.json` + `/health`.

**Omi, screen-share, gateway (G2, G5)**

- omi-channel (faculty `channels`, port 8094): chat tool `ask_zeca` =
  `GET /omi/tools-manifest` + `POST /omi/chat` (`scripts/server.mjs:631,643`,
  `lib/chat.mjs`), config keys at `lib/config.mjs:133-152`, test
  `tests/omi-channel-chat.test.ts`. Transcripts arrive at `POST /omi/realtime`
  (in-memory wake), `/omi/memory`, `/omi/day-summary` (triage); the fitting
  talks to the gateway directly (`lib/gateway-client.mjs`), never to
  capture-service; `lib/wake.mjs` is a copy of capture-service's (cross-fitting
  imports are forbidden). capture-service's `lib/triage.mjs:26-56` already
  models the pendant/omi sources.
- screen-share-default (faculty `surfaces`, port 8079): `GET /health|/state|/frame`,
  `POST /start|/stop` toggling a `screencapture -x -t jpg
  /tmp/garrison-screen-latest.jpg` poll (~1 fps). No video, no audio, no
  recordings. capture-service already stores 1.5 fps JPEG frames from the phone
  under `media/<sessionId>/frames`; `lib/screen-context.mjs` only picks the
  freshest frame for wake context; no digest logic exists.
- Gateway = `fittings/seed/http-gateway/scripts/gateway-pty.mjs` (5512 lines;
  `gateway.mjs` is a shim). `POST /chat` blocking `{reply, session_id, ...}`
  (400 for `channel: "web"`, which must stream); `POST /chat/stream` SSE
  `open|route|chunk|tool|activity|session_event|done|error`, keepalive 15 s;
  identity = `body.sessionId` or web's `body.thread` (`routeHintsFromBody`
  :3842-3900), `body.images` max 16 (:3862). No gateway-side "active
  conversation" notion; the nearest is web-channel's `runningThreadIds()` /
  `runningSince` (`server.mjs:2244-2280`). Card conversations use
  `/conversation/*` with `conversationId` = card id.
- `packages/claude-pty/src/conversation-http.mjs:72-143` serves `GET /`,
  `:id/log|metrics|summary|handoff/:n|payload/:name|stream`, `POST :id/message`;
  `conversation-digest.mjs:51` exports `buildConversationDigest(events, opts)`.

**iOS (G3-G7)** - see `recon-environment.json` (round 1) for the full map;
load-bearing: `AppGroup.request(path:method:body:)` Bearer, 15 s;
`CaptureUploader.socketURL` https -> wss `/capture/stream`; binary framing 17-byte
header; `PushManager.didReceive` only appends `AckLog`; `BroadcastPicker` =
`RPSystemBroadcastPickerView` with `preferredExtension com.gomes.garrison.broadcast`;
`PendantController.shared` singleton with `connectionState`, `battery`,
`hapticSupported`, `capturePolicy`, `pendantFlagOn`; `UIBackgroundModes` =
`[bluetooth-central]`; no URL scheme, no associated domains, no `.onOpenURL`;
`NSAllowsArbitraryLoads` true; fastlane `beta` lane = Spaceship bundle-id
registration + `match appstore` + `build_app` + `upload_to_testflight`.

**Roadmap** - flat JSON `{title, intro, updatedAt, categories[{id,title,noteRef,items[{id,text,done,sentToKanban,noteRef}]}], notes[{id,title,body}]}`.
Items this run closes: c7.1 (pendant), c7.3 (Companion app; text still says
"Found: partial"), c7.8 (notifications with deep links), c8.1-c8.4 (web channel
into core), c9.1 (node switcher). `docs/GOVERNANCE.md:80-86` currently names a
built-in chat tab as Honesty-Test leakage - that paragraph becomes the
exception text (D2, c8.3), mirrored in `AGENTS.md` and CLAUDE.md's two "no
built-in chat surface" sentences.

## 4. Per-gate file list

Paths are repo-relative. "move" = `git mv` (history kept). Tests listed per
gate are the suites that must stay green or be re-pointed in that gate.

### G0 (this gate)

- create `docs/decisions/2026-09-garrison-app.md`,
  `evidence/garrison-app/g0/{README.md,xctest-baseline.log,recon-environment.json,recon-round2.json}`.

### G1 - web channel into the shell (as shipped; the G0 plan for this gate is superseded by this list)

- `packages/talk/` (`@garrison/talk`, `file:` dependency in `package.json`):
  `src/{router,server,threads,sidebar-state,live-event-stream,thread-registry,webpush,push-store,mesh-threads,session-transcript,tailnet-serve}.mjs`
  moved out of `fittings/seed/web-channel-default/{scripts,lib}` (git renames;
  `router.mjs` is the former `server.mjs` minus its listener, `server.mjs` is
  the own-port listener the legacy host calls); `ui/{app,index}.tsx` and the
  transports, rails, modals, `styles.css`, `voice-machine.ts`,
  `voice-conversation.tsx`, `voice-clip.ts` (D9; `voice-capture.ts`,
  `voice-tts.ts`, `pcm-worklet.js` and the Playwright voice harness under
  `ui/__tests__` deleted). `lib/state-client.mjs` deduplicated into
  `@garrison/state-client` (`scripts/sync-state-client.mjs`).
- `fittings/seed/web-channel-default/`: `scripts/server.mjs` (25 lines) and
  `ui/main.tsx` (7 lines) are hosts importing the package; `apm.yml`
  description/summary and `README.md` say legacy host; `dist/` rebuilt;
  `data/library.json` entry relabelled "Web channel (legacy host)".
- shell: `src/app/talk/page.tsx`, `src/app/talk/[conversationId]/page.tsx`,
  `src/components/talk/{TalkPage.tsx,talk-page.css}`; the ONE API mount
  `src/app/api/[[...path]]/route.ts` over `src/lib/node-handler-shim.ts` (D2);
  `src/app/api/conversation/[...path]/route.ts` deleted (its shim moved).
  `next.config.mjs` adds `@garrison/talk` to `serverComponentsExternalPackages`.
- shell chrome: `src/components/chrome/Sidebar.tsx` (`nav:conversations`,
  `/talk`, `MessagesSquare`), `AppShell.tsx` (`+ New` -> `/talk?new=1`),
  `src/components/muster/DecisionsPanel.tsx` (`/talk/<id>` deep links),
  `src/app/manifest.ts` (`/talk` shortcut), `public/sw.js` (push handlers,
  D18).
- mesh (D17): `src/lib/mesh/peer-proxy.ts`,
  `src/app/api/mesh/nodes/[node]/[...path]/route.ts`,
  `packages/talk/src/mesh-threads.mjs`, `src/lib/mesh/self-snapshot.ts`
  (comment); gateway: `src/lib/runner.ts` (`GARRISON_APP_URL` into
  `spawnGateway`), `fittings/seed/http-gateway/scripts/lib/session-registry.mjs`.
- consumers (D19): `fittings/seed/kanban-loop/{lib/notify-origin.mjs,lib/morning-briefing.mjs,scripts/server.mjs,scripts/discuss.mjs,ui/api.ts}`,
  `fittings/seed/automations/{lib/discuss.mjs,scripts/server.mjs,dist/index.html}`,
  `src/app/embed/[fittingId]/page.tsx` (`garrison:navigate-route`),
  `fittings/seed/{capture-service,omi-channel}/lib/notify.mjs`,
  `fittings/seed/drill/lib/broadcast.mjs`,
  `fittings/seed/improver/lib/probe-notify.mjs`,
  `scripts/web-parity-prod-suite.mjs`.
- compositions (D16): `compositions/{default,openai}/apm.yml` and
  `apm.lock.yaml` drop `web-channel-default` (the intended hunk only, D8).
- tests: the `tests/web-channel-*.test.ts` suites and `tests/voice-machine.test.ts`
  import `@garrison/talk`; `tests/claude-chat-session-events-browser.test.ts`
  mounts under `.talk-host`; `tests/sidebar-grouping.test.ts` pins `/talk`;
  `tests/mesh-proxy.test.ts`, `tests/session-registry.test.ts` follow D17;
  `tests/kanban-*.test.ts`, `tests/automations-discuss.test.ts`,
  `tests/capture-service-apns.test.ts`, `tests/omi-channel*.test.ts`,
  `tests/drill-card-drill.test.ts`, `tests/improver-probe-out-of-band.test.ts`
  follow D19; new `tests/voice-clip.test.ts`; `playwright.web-channel.config.ts`
  + `tests/e2e/web-channel-{chat,session-parity}.spec.ts` drive `/talk` on the
  Next app; `tests/voice-latency.test.ts` deleted with its subject.
- docs: `docs/UI-FITTINGS.md` ("Conversations is a shell route"), `AGENTS.md`
  ("The web channel exception"), `docs/GOVERNANCE.md` (the exception inside the
  Honesty Test list), `CLAUDE.md` (Channel term, shell surfaces, tree,
  own-port list), `docs/DECISIONS.md` (2026-09-01 entry), this file.
- consumers, second pass: `fittings/seed/kanban-loop` `/board/runtime` answers
  `conversationsRoute` (the shell path, not a channel URL) and `ui/main.tsx`
  reads it; `tests/live-vision/kanban-loop-v1d.spec.ts` follows.
- test guards: `tests/setup.ts` clears `GARRISON_APP_URL` for every test (the
  runner projects it into fittings and card PTYs inherit it, so `npm test` from
  a card would otherwise post fan-outs to the user's real threads through the
  shell's `/api/notify`) and pins `TMPDIR` to its realpath (macOS mounts
  `/var/folders` as `/private/var`; ten suites compared a canonicalised path
  with an uncanonicalised one). `tests/e2e/fixtures/talk-app.ts` boots one
  `next dev` per Playwright spec on a scratch `GARRISON_HOME` so the restart
  contract is provable. `tests/helpers/port-free.ts` refuses to start a fixture
  suite whose fixed port already has a listener - a killed run's servers had
  been answering `drill-gate-ui`'s health poll with yesterday's runs.
  `tests/own-port-canonical-port.test.ts` follows an
  `export * from "@garrison/<pkg>/server"` shim to the package listener before
  asserting the EADDRINUSE guard.
- fixed along the way (real bugs the Mac nodes hit, surfaced by the suite, not
  caused by G1): the live-session guard in
  `fittings/seed/file-browser/scripts/merge-actions.mjs` and
  `src/lib/mesh/git-executor.ts` compared cwd strings and failed OPEN on a
  symlinked or subdirectory session - both now use `sessionInTree` (realpath,
  subtree, this node's active sessions only);
  `src/lib/own-port-lifecycle.ts` trusted a recorded pid whenever `/proc` was
  absent, so a stale status file could kill an unrelated process - it now
  reads the birth time from `ps -o etime=` off Linux; `cortex-client`'s
  `resolve_abs` used `realpath -m`, which BSD realpath lacks, so the R5
  symlink escape went undetected on macOS. `tests/workspace-git.test.ts`
  serialises its pump (overlapping intervals doubled replies).
- suite hardening (five full runs to a green one; each run surfaced one more
  load-induced flake, fixed at its root and recorded in
  `evidence/garrison-app/g1/vitest.txt`): `vitest.config.ts` `hookTimeout`
  30s (the browser fixture suites blew the 10s hook default under the parallel
  run); `tests/garrison-call-live.test.ts` and `tests/openai-agents-live.test.ts`
  gate on the model being pulled and the fitting's SDK being installed, not on
  Ollama answering; `tests/drill-gate-ui.test.ts` asserts its ports are free;
  `tests/pendant-capture.test.ts` waits for the operative request, which is
  deliberately deferred past the ack; `tests/claude-chat-session-events-browser.test.ts`
  waits for the revealed text to SETTLE (live prose types in a few chars per
  frame, and an auto-closed intermediate render equals the target before the
  stray-backtick frame).
- found on the live route (the tailnet screenshots, not the suites): the
  shell's `+ New` control is `position: fixed` in the top-right corner of every
  real route and sat on the conversation bar's trailing chip and search box at
  both widths. `/talk` is a real route (only `/embed/*` drops the control), so
  the bar reserves the corner itself: `src/components/talk/talk-page.css`
  gives `.wc-backbar` / `.cc-conv-head` `padding-right: 112px`, 96px under
  560px where the control is icon-only (measured 75px and 77px wide). The
  phone bar then stacked THREE rows (title, id chip, search - 144px of an
  844px viewport): a wrapping flex row breaks lines on the items' auto bases
  before anything shrinks, so `packages/claude-chat/src/claude-chat.css` gives
  the title `flex: 1 1 0` and puts the search last (`order: 1`) under 600px,
  and `packages/talk/ui/styles.css` lets `.wc-conv-id` shrink to at most 45%
  of the row (it ellipsises like it already does at 26ch on the desktop; the
  click copies the whole id). Two rows, 115px.
- left alone: on `/talk` the shell posts `/api/power/heartbeat` (source
  `garrison-shell`) AND the talk app posts `/api/power-heartbeat` (source
  `web-channel`), both relayed to power-default's `/presence`. Presence is a
  recency boolean over `[{source, at}]`, so the duplicate changes nothing;
  removing it means a prop across the package boundary for no observable
  gain. Playwright reports both as `net::ERR_ABORTED` AFTER the 204 - Chromium
  cancelling the unread body of a `void fetch()`, not a failure.
- evidence: `evidence/garrison-app/g1/` (playwright report, phone-width and
  desktop screenshots of `/talk` from the tailnet origin with the measured
  geometry in `tailnet-shots.txt`, test summaries, the live-route probe, the
  redeploy tail with the state-service correction).
- deploy: `npm run node:redeploy` (the composition and `packages/` changed, so
  the fingerprint takes the full path), then `node:reload` for the CSS.

### G2 - one voice layer

- edit `fittings/seed/capture-service/apm.yml` (provides `voice: companion` and
  `connector: voice` with actions transcribe/synthesize; `for_consumers`
  documents `POST /stt`, `POST /tts`, `GET /health.voice`; config keys
  `tts_backend` auto|elevenlabs|deepgram, `stt_rest_language`;
  `active_conversation_window_ms` default 300000), `lib/config.mjs`
  (`DEFAULT_PORT` 8097, new keys), `scripts/server.mjs` (routes `POST /stt`,
  `POST /tts` Bearer-gated, `/health` voice block, `POST /capture/conversation/active`,
  session-end digest hook), `lib/deepgram-live.mjs` (`transcribeClip(bytes,
  contentType, {language})` via Deepgram `/v1/listen`, mockable through
  `cfg.dgBaseUrl`), `lib/tts.mjs` (Aura backend behind the same cache, D3),
  `lib/gateway-client.mjs` (`operativeRunFn` returns `session_id`),
  `lib/wake.mjs` (active-conversation window: reuse the last gateway
  `sessionId` within the window), `lib/ack-sink.mjs` only if the speak frame
  gains a field.
- create `fittings/seed/capture-service/scripts/mock-deepgram-rest.mjs` (or
  extend `mock-deepgram.mjs`) and tests
  `tests/capture-service-voice-rest.test.ts`, extend
  `tests/capture-service.test.ts`, `tests/capture-service-voice.test.ts`,
  `tests/capture-service-wake.test.ts` (window).
- edit `src/lib/runner.ts` / `src/lib/own-port-lifecycle.ts` (project
  `GARRISON_VOICE_FITTING_ID` for consumers of `voice`, D12) +
  `tests/own-port-lifecycle.test.ts`; `fittings/seed/web-channel-default/scripts/server.mjs:97`
  and `fittings/seed/dev-env/scripts/server.mjs:95` (read the projected id),
  `fittings/seed/dev-env/apm.yml` (declare `consumes: voice optional-one`),
  `packages/talk/src/handlers/voice.mjs` (forward the capture token from ctx).
- edit `fittings/seed/omi-channel/scripts/server.mjs` (delete `/omi/chat`,
  `/omi/tools-manifest`, `chatTool` construction), delete
  `fittings/seed/omi-channel/lib/chat.mjs` and `tests/omi-channel-chat.test.ts`,
  edit `lib/config.mjs:133-152` + `apm.yml` (drop chat keys),
  `lib/ingress.mjs` + `lib/wake.mjs` (forward realtime segments to
  capture-service's session model through a new token-gated
  `POST /capture/ingest/text` on capture-service, so wake/discuss/speak run in
  one place; omi-channel keeps memory/day-summary triage).
- edit `compositions/default/apm.yml:15,300` and `compositions/openai/apm.yml:15,276`
  (unstation deepgram-voice; only those hunks), regenerate both
  `apm.lock.yaml`; `data/library.json:201-210` (de-list),
  `fittings/seed/automations/lib/connector-invoke.mjs:102` (D13),
  `src/components/chrome/Sidebar.tsx:324`, `src/lib/own-port-lifecycle.ts:214`.
- tests: `tests/capabilities.test.ts:119-139`, `tests/seed.test.ts:22,94`,
  `tests/own-port-lifecycle.test.ts:203-211`, `tests/vault-heal.test.ts:35,616-618`,
  `tests/matrix-harness.test.ts:32`, `tests/connector-deepgram.test.ts`
  (re-target to capture-service), delete `tests/deepgram-voice-live.test.ts`,
  keep `tests/mesh-serve-ports.test.ts` green (8085 leaves the map).
- docs: `CLAUDE.md:402` and the own-port list, `docs/CAPABILITIES.md`,
  `docs/CAPABILITY_CONTRACT.md`, `docs/FITTINGS.md`, `docs/INSTANCES.md`,
  `docs/RUNTIME_MATRIX.md`, `docs/COMPANION_IOS_SPEC.md` (D3 fallback),
  `packages/claude-chat/src/voice.ts:2`, `fittings/seed/capture-service/README.md`.
- `fittings/seed/deepgram-voice/` stays on disk (I12); its removal rides the
  same G8 patch as the web-channel fitting.
- evidence: `evidence/garrison-app/g2/` (curl transcripts of `/stt`, `/tts`
  through the shell from the tailnet origin, browser push-to-talk screenshot,
  vitest summary). Deploy: `npm run node:redeploy`.

### G3 - the app is a Capacitor shell (native gate, ends in TestFlight)

- edit `ios/project.yml` (package `CapacitorSwiftPM`
  `https://github.com/ionic-team/capacitor-swift-pm.git` exact `8.5.1`,
  product `Capacitor` on `GarrisonApp`; resources include
  `capacitor.config.json`; delete nothing from `BroadcastExtension`).
- create `ios/GarrisonApp/Resources/capacitor.config.json` (`appId
  com.gomes.garrison`, `server.url` filled at runtime, see D1),
  `ios/GarrisonApp/Web/GarrisonBridgeViewController.swift`
  (`CAPBridgeViewController` subclass registering the plugins in
  `capacitorDidLoad()`, loading `GarrisonNode.current.shellOrigin`),
  `ios/GarrisonApp/Web/BridgeHost.swift` (`UIViewControllerRepresentable`),
  `ios/GarrisonApp/Web/OfflineView.swift`, `ios/GarrisonApp/Web/NodePickerView.swift`
  (native-only first-run picker),
  `ios/GarrisonApp/Plugins/{GarrisonCapturePlugin,GarrisonSpeechPlugin,GarrisonPushPlugin,GarrisonNodePlugin,GarrisonPendantPlugin}.swift`
  (`CAPPlugin` + `CAPBridgedPlugin`; pendant is a stub returning `status()`
  only in G3).
- edit `ios/GarrisonApp/GarrisonApp.swift` (`@main` stays; body hosts
  `BridgeHost`; keeps `PendantController.shared.connect()` on `scenePhase`),
  `ios/Shared/AppGroup.swift` (node record `{name, shellOrigin, captureBaseURL,
  token}` with migration from `capture.baseURL`/`capture.token`, D4),
  `ios/GarrisonApp/Info.plist` (`UIBackgroundModes` + `audio`; URL scheme
  `garrison`), `ios/GarrisonApp/PushManager.swift` (route `data.path` to the
  bridge, D5).
- delete `ios/GarrisonApp/{ContentView,ConversationView,ConsentSheet,AckLog,ClipPlayer}.swift`
  and `ios/GarrisonApp/Pendant/PendantView.swift`; keep `CaptureController`,
  `BroadcastPicker`, `SpeechSink`, `PendantController`, `PendantBLETransport`
  as plugin backends.
- edit `ios/Tests/PendantFeedbackMappingTests.swift:72-95` (assert ownership on
  `GarrisonApp.swift` + `GarrisonPendantPlugin.swift` instead of the deleted
  view), add `ios/Tests/{NodeRecordTests,BridgePluginRegistryTests}.swift`.
- docs: `docs/decisions/2026-07-13-capacitor-native-wrap-memo.md` (superseded-by
  line), `docs/COMPANION_IOS_SPEC.md` (Rev 3: shell app), `docs/adr-companion.md`
  (toolchain facts).
- evidence: `evidence/garrison-app/g3/` (mini `xcodebuild test` log, ios-thing
  workflow run URL + TestFlight build number, phone screenshot of the shell
  loaded over tailnet).

### G4 - capture page, node switching, notifications

- create `src/app/capture/page.tsx`, `src/components/capture/{CapturePage,BridgeGate}.tsx`
  (renders only when `window.Capacitor?.isNativePlatform()`; otherwise a
  one-line "open this in the Garrison app"), `src/lib/native-bridge.ts`
  (typed facade over the five plugins, feature-detected),
  `src/components/chrome/NodeSwitcher.tsx` (extends `NodeBadge`: dropdown from
  `/api/mesh/nodes`, full navigation to `https://<tailnetHost><pathname>`;
  native: `GarrisonNode.set()` then reload).
- edit `src/components/chrome/Sidebar.tsx` (capture entry appears only with the
  bridge), `src/components/chrome/NodeBadge.tsx`, `src/app/layout.tsx` (bridge
  detection provider), `src/app/manifest.ts` untouched.
- capture-service: `lib/notify.mjs:266` + `scripts/server.mjs:565-580`
  (structured `data.path`, keep `link`), `lib/apns.mjs` (payload), device
  registry gains `node`; APNs is the only push path for the app (the shell's web
  push stays for browsers).
- ios: `GarrisonPushPlugin` delivers `data.path` to the webview
  (`window.location.assign`), cold-start path queued until the bridge is ready.
- tests: `tests/capture-service-apns.test.ts`, `tests/capture-service-notify.test.ts`
  (new), `tests/mesh-self.test.ts` / `tests/view-instances.test.ts` (switcher
  URL building), `tests/e2e/shell-overhaul.spec.ts` (capture entry hidden in a
  browser), `ios/Tests/PushRoutingTests.swift`.
- evidence: `evidence/garrison-app/g4/` (phone screenshots: capture page,
  switcher, a push that opened `/talk/<id>`; capture-service log lines).
  TestFlight build.

### G5 - record button + digest

- `packages/talk/ui/RecordButton.tsx` (+ wiring in `TalkApp.tsx`): native ->
  `GarrisonCapture.start({mode:'screen_audio', conversationId})` (presents the
  picker, D6); Mac -> `POST /api/record/start` on the shell which forwards to
  screen-share-default.
- `fittings/seed/screen-share-default/scripts/server.mjs` (`/record/start|stop|state`,
  capture-service client per D14), `apm.yml` (`consumes: channel` is not a
  thing; declare `secret_scope: CAPTURE_TOKEN`, config `record_audio_device`),
  `lib/capture-client.mjs` (the 17-byte framing, shared shape with
  `ios/Shared/CaptureProtocol.swift`).
- capture-service: `lib/digest.mjs` (new, next to `screen-context.mjs`),
  `scripts/server.mjs` (`onSessionEnd` -> digest -> `POST
  /api/conversation/<id>/message` on the shell + `POST /notify` with
  `data.path=/talk/<id>`), `lib/ingress.mjs` (`session_start.conversation_id`
  optional field), `lib/config.mjs` (`digest_enabled`).
- ios: `CaptureProtocol.swift` (`conversation_id` in `session_start`),
  `GarrisonCapturePlugin` (`start` accepts `conversationId`).
- shell: `src/app/api/record/[...path]/route.ts` (forward to screen-share by
  status file), `src/app/api/conversation` untouched.
- tests: `tests/capture-service-digest.test.ts` (new), `tests/conversation-digest.test.ts`,
  `tests/screen-share-record.test.ts` (new, ffmpeg absent path),
  `ios/Tests/CaptureProtocolTests.swift`.
- evidence: `evidence/garrison-app/g5/` (a real phone recording's digest
  message screenshot, capture-service session json, Mac recording digest).
  TestFlight build.

### G6 - fittings in the app

- edit `src/components/chrome/Sidebar.tsx:293-296` and `AppShell.tsx` (in the
  app, own-port views embed instead of opening a new tab; `BridgeGate`
  decides), `src/app/embed/[fittingId]/page.tsx` (native back affordance,
  `allow` list gains `camera` only if a fitting needs it),
  `src/components/fitting-views/browser-view-url.ts` (page-host resolution
  already works over tailnet; verify from the app).
- tests: `tests/sidebar-pins.test.ts`, `tests/view-instances.test.ts`,
  `tests/instance-isolation.test.ts`, `tests/mesh-serve-ports.test.ts`.
- evidence: `evidence/garrison-app/g6/` (phone screenshots of kanban-loop,
  dev-env, file-browser inside the app). TestFlight build only if native code
  changed.

### G7 - pendant through the plugin, mock first

- ios: `GarrisonPendantPlugin.swift` full surface (D7:
  `status/connect/disconnect/forget`, events `pendantState`, `pendantBattery`),
  `ios/Tests/PendantPluginMockTests.swift` (CoreBluetoothMock scripted
  peripheral through the plugin), `GarrisonCapturePlugin` mode `pendant`.
- shell: `src/components/capture/PendantPanel.tsx` (status, battery, connect,
  forget; live transcript over `/api/capture/sessions/<id>/events` proxied by
  `src/app/api/capture/[...path]/route.ts` with the token server-side, replacing
  `PendantView.TranscriptStream`).
- docs: `docs/adr-pendant-direct.md`, `docs/pendant-protocol.md` (plugin
  section). Tests: `npm run e2e:pendant` unchanged and green.
- evidence: `evidence/garrison-app/g7/` (mock run log from the mini, phone
  screenshots with the real pendant if it is in reach; if not, the handoff says
  so). TestFlight build.

### G8 - close

- edit `roadmap.json` (items in section 3, `updatedAt`), `AGENTS.md`,
  `CLAUDE.md`, `docs/GARRISON_ROADMAP.md` (decision-log line),
  `docs/DECISIONS.md`.
- create `evidence/garrison-app/g8/remove-web-channel-default.patch`
  (`git format-patch`-style: deletes `fittings/seed/web-channel-default/` and
  `fittings/seed/deepgram-voice/`, their `data/library.json` entries, their
  composition stationing, the `playwright.web-channel.config.ts` if by then
  redundant; not applied), `HANDOFF-garrison-app.md` at the repo root.
- final TestFlight build; final `npm test`, `npm run typecheck`, playwright
  runs, `xcodebuild test` on the mini, all logged under
  `evidence/garrison-app/g8/`.
