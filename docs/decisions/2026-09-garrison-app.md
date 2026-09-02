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
  `Bundle.main`). No `capacitor.config.ts`. CORRECTED by D32: the bridge does
  not merely warn when `public/` is absent, `loadWebView()` exits the process,
  so a small bundled `public/` (bootstrap/offline page + start-file
  placeholder) ships in the app; the shell itself is still loaded from the
  node over the tailnet (`server.url`). The config file carries no
  `server.url`; the runtime descriptor sets it from the node record (D4, D32).
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

### D20. The voice REST contract lives on capture-service, top-level, Bearer-gated

Both endpoints sit beside `/speak/<id>.mp3` (top-level, not under `/capture/*`,
whose unknown paths stay `501`) and pass the existing `authorizeHttp` ladder
(403 disabled, 403 no capture token sealed, 401 bad bearer):

- `POST /stt` - body = the recorded clip as raw bytes (`Content-Type` default
  `audio/webm`, 8 MB cap through a new binary body reader; the existing
  `readBody` is utf8/JSON only), optional `?language=` (default
  `stt_rest_language`, itself defaulting to `stt_language`). Deepgram
  `POST /v1/listen?model=<stt_model>&smart_format=true&punctuate=true&language=`.
  `200 {transcript, confidence, language, model}`; `400` empty body; `503` no
  `DEEPGRAM_API_KEY`; `502` upstream failure (status + first 200 chars, never
  the audio).
- `POST /tts` - JSON `{text, format?: "mp3"}`; mp3 only (the browser plays an
  `<audio>` clip and D9 dropped the PCM stream; `wav` from deepgram-voice had
  no caller left). Produces the clip through `ZecaVoice.clipFor` so the browser
  and the phone share one cache and one backend choice. `200 audio/mpeg` with
  `X-Voice-Backend` and `X-Clip-Id`; `400` empty or over `MAX_TEXT_CHARS`
  (600). The browser never sends an over-cap request: ONE chunker
  (`@garrison/claude-chat/voice` `chunkSpeech`, re-exported by talk's
  `voice-clip.ts`) splits at sentence, then clause, boundaries against the cap
  the provider ADVERTISES (`/health voice.maxTextChars`, mirrored by both host
  proxies), falling back to 600 only when a host cannot read it; `503` no
  backend.
- `GET /health` gains `voice: {stt, tts, ttsBackend, restEnabled,
  maxTextChars}` and a top-level `keyConfigured` mirroring `voice.stt`, so a
  reader that still applies `h.keyConfigured !== false` (talk before its G2
  edit, dev-env) stays honest instead of lighting the microphone with no
  Deepgram key.

The `wake_revise_after_ms` / `wake_revise_max_segments` keys that
`lib/config.mjs` reads but `apm.yml` never declared are declared in the same
pass (pre-existing drift, found by the recon).

### D21. TTS backend selection and the clip cache

`tts_backend: auto | elevenlabs | deepgram`, default `auto` = ElevenLabs when
`ELEVENLABS_API_KEY` is sealed, else Deepgram Aura when `DEEPGRAM_API_KEY` is
sealed, else no TTS (`voice.tts: false`, the phone falls back to
`AVSpeechSynthesizer`, D3). `tts_deepgram_model` default `aura-asteria-en` (the
model the retired connector shipped with in `compositions/default`); Aura's
Portuguese coverage is Deepgram's, not ours - the handoff names
`ELEVENLABS_API_KEY` as the credential that buys Portuguese read-aloud. The clip
id (`lib/tts.mjs clipId`) gains the backend and model, so switching backends
never serves the other backend's clip; the `/speak/<id>.mp3` path, the prune
policy and the `tts_cache_max_clips` cap are unchanged.

### D22. The capture token reaches the voice proxy through the host, never the page

One implementation, in `packages/talk/src/router.mjs` (the plan's
`packages/talk/src/handlers/voice.mjs` does not exist): `createTalkRouter`
takes `voice: {fittingId(), token()}` in its options. The shell
(`src/app/api/[[...path]]/route.ts`) resolves the provider from the active
composition's capability graph (`src/lib/voice-provider.ts`, the fitting that
provides `kind: voice`) and reads the token with `scopedSecrets(["CAPTURE_TOKEN"])`
per request (vault locked = `503 voice locked`, never a cached copy). The legacy
own-port host passes `process.env.GARRISON_VOICE_FITTING_ID` and
`process.env.CAPTURE_TOKEN` (its `secret_scope` gains `CAPTURE_TOKEN`; it is
unstationed, so this only keeps the old surface honest, I12). `handleVoiceProxy`
forwards `Authorization: Bearer <token>` and maps a missing provider or token to
`503 {error}` rather than letting capture-service's `403` read as "forbidden
user". `handleVoiceHealth` reads `voice.stt` / `voice.tts` and returns
`{available: stt, keyConfigured: stt, tts, backend}`; `voice-conversation.tsx`
shows the speaker only when `tts` is true. The WebSocket relays
`/api/voice/stream` and `/api/voice/tts-stream` in `packages/talk/src/server.mjs`
are removed (no caller since G1 dropped `voice-capture.ts` / `voice-tts.ts`,
no capture-service counterpart). No Next route pair is added: the catch-all IS
the route handler D9 describes, and a second implementation would drift.

### D23. `GARRISON_VOICE_FITTING_ID` is projected by the runner

In `startOperativeBoundFittings` and `operativeEnvForFitting` (`src/lib/runner.ts`)
the selected entries are run through `resolveCapabilities`; every own-port
fitting whose `consumes` includes `voice` receives
`GARRISON_VOICE_FITTING_ID=<provider id>` (absent when no provider is
stationed). It is part of the projected env, hence of the heal fingerprint, so
swapping the provider restarts the consumers. `dev-env` declares the
`consumes: voice optional-one` it relied on and reads the projected id plus
`CAPTURE_TOKEN` (added to its `secret_scope`) for its `/voice/*` bridge.

### D24. Omi realtime segments are forwarded to the voice layer; omi-channel keeps no wake bus

`fittings/seed/omi-channel/lib/wake.mjs` is a byte-identical copy of
capture-service's (2160 lines, `diff` empty), as are `echo-guard.mjs`,
`board-client.mjs`, `memory-writer.mjs`, `gateway-client.mjs` and `lang.mjs`.
One voice layer means one wake bus:

- capture-service gains `POST /capture/ingest/text` (Bearer capture token; JSON
  `{source: "omi", session_id, segments: [{text, speaker?, is_user?, start?, end?}]}`
  -> `202 {session, accepted}`). It opens a socket-less text session
  (`mode: "omi"`, keyed by `source` + `session_id`) in the ingress, finalised
  after `text_session_idle_ms` (default 120000) of silence, with NO media log,
  NO transcript file and NO `capture_event` (omi-channel's `/omi/memory` batch
  pipe stays the memory path, so nothing is ingested twice). Segments pass the
  shared echo guard, then a third `WakeBus` (`source: OMI_WAKE_SOURCE`, the
  constant that already exists unused in `wake.mjs:658`, memory-writer prefix
  `omi`) wired to the same `speakingNotifier`: spoken through the phone when a
  companion session can hear, else pushed. Replies stop going to the Omi app
  notification API; they land where every other reply lands (one app).
- omi-channel `Ingress.acceptRealtime` hands `heard` segments to a
  `RealtimeForwarder` (new `lib/forward.mjs`): capture-service URL from
  `~/.garrison/ui-fittings/capture-service.json` (the `statusFileUrl` pattern
  in `lib/notify.mjs`), `CAPTURE_TOKEN` from its `secret_scope` (added;
  fail-closed: no token = skipped with a reason, counted
  `realtime_forward_skipped`), failures counted `realtime_forward_failed` and
  shown on `/health` as a `forward` row. No local fallback: with the voice layer
  down the segments are dropped (they were memory-only anyway, I5).
- omi-channel deletes `lib/wake.mjs`, `lib/chat.mjs`, `lib/echo-guard.mjs`,
  `lib/lang.mjs`, the `/omi/chat` + `/omi/tools-manifest` routes, the
  `ChatTool` wiring, `scripts/speak.mjs` `ask` mode, and every config key only
  those read (`chat_enabled`, `public_base_url`, the chat delivery and
  classify/delegate keys - each removed only after `grep` shows no remaining
  reader; triage's own keys stay). `wake_enabled` keeps its name (field names do
  not churn) and now means "forward realtime segments to the voice layer".
  `tests/omi-channel-chat.test.ts` is deleted; `tests/omi-channel-wake.test.ts`
  is deleted after its omi-only cases (by `it()` title diff against
  `tests/capture-service-wake.test.ts`) are ported there; the other omi suites
  lose their chat assertions and gain forwarder ones.
- `compositions/{default,openai}/apm.yml` drop the omi `public_base_url` and
  `chat_enabled` entries in the same hunk that unstations deepgram-voice.

### D25. The active-conversation window keys on the gateway session id

`operativeRunFn` already returns `{reply, sessionId}`; `WakeBus.runDelegate`
(`wake.mjs:1910`) drops the id and always resumes the deterministic
`${originPrefix}-wake:<capture session>` key, so a delegate after a reconnect
or from another source starts a fresh gateway session. G2 keeps a per-bus
`{sessionId, at}` of the last delegate reply and, within
`active_conversation_window_ms` (default 300000), resumes it instead of the
deterministic key. `POST /capture/conversation/active` (Bearer; `{session_id}`)
pins the window to a conversation the user is looking at (the G4/G5 clients use
it; `GET` returns the current pin), `DELETE` clears it. Window state is process
memory, never persisted (a restart forgets it, honestly).

### D26. `connector: voice` is a client of the running service; `deepgram` is an alias resolved once

`fittings/seed/capture-service/scripts/connector.mjs` implements the automations
contract (`--probe`, `catalog`, `call <action> <json>`) by calling the RUNNING
capture-service (`/stt`, `/tts` over loopback from the status file, Bearer
`CAPTURE_TOKEN`), so the automation lane gets the same backend, cache and config
as the browser and the phone. Actions: `transcribe(audio_base64 | path,
mime_type?, language?)`, `synthesize(text, inline?)` (returns `{clip_id,
clip_path, mime, bytes, backend}`; the clip stays on the voice layer at
`/speak/<clip_id>.mp3` and `audio_base64` rides along only with `inline: true`,
since the automation engine persists every action result into the run record
- review finding 9). The manifest gains an optional `connector.secrets:
string[]` (the subset of `secret_scope` a connector call needs); the auth-env
route delivers only that subset when present, the whole scope otherwise -
capture-service declares `[CAPTURE_TOKEN]` and nothing else, so an automation
child receives ONLY the capture token and never the Deepgram, ElevenLabs or
APNs keys (the recon found `auth-env` hands out a fitting's entire scope). A
name in `connector.secrets` that is not in `secret_scope` is a MANIFEST ERROR
(`metadata.ts` superRefine at `connector.secrets`), not a silently dropped
entry: the subset is drawn from the scope or the fitting does not parse.
`connector-invoke.mjs` normalises the legacy id
`deepgram` to `voice` BEFORE calling `auth-env` and maps `voice` to the
`capture-service` directory, so the alias lives in one place and no
`connector: deepgram` is declared on capture-service. The Connectors page shows
`voice` sealed when its `connector.secrets` are present.

### D27. Docs: fix what the code says, annotate what a harness wrote

No `fittings/seed/capture-service/README.md` (the plan names one; the operator
docs are `RUNBOOK.md` + `HUMAN_SETUP.md` and gain the voice surface there).
`docs/RUNTIME_MATRIX.md` is a generated report (`scripts/matrix-harness.mjs`,
2026-07-12); it gets a dated note above the table, not a hand-edited row.
`docs/INSTANCES.md` gains the capture-service row (7097 | 8097 | 8497) and the
four own-port rows it never had (omi-channel, email-channel, whatsapp-web,
remote-shell-runtime), and loses the deepgram-voice row. `CLAUDE.md`'s own-port
list moves to the 8xxx family with capture-service in place of `voice` (27085).
`docs/COMPANION_IOS_SPEC.md` §5b and I8 are corrected to what ships (clip
first, on-device fallback; Deepgram key in the vault).

### D28. Test moves that follow the retirement

`tests/seed.test.ts` swaps `deepgram-voice` for `capture-service` in `seedIds`
(`voice` is a singleton kind; both cannot be resolved together) and re-targets
the dual-connector assertions. `tests/connector-deepgram.test.ts` becomes
`tests/capture-service-connector.test.ts` against the new CLI;
`tests/deepgram-voice-live.test.ts` is deleted (the plan's list). The
`deepgram-voice` directory itself stays until the G8 patch (I12), so
`tests/mesh-serve-ports.test.ts` keeps 8085 in its derived map until then and
is indifferent either way.

Amended after the build: the `data/library.json` entry for `deepgram-voice` is
KEPT, reworded as a legacy entry ("Voice (Deepgram, legacy)", retired
2026-09-02, capture-service is the voice layer). `readLibrary()` auto-registers
every seed directory anyway, so removing the entry only lost the curated
wording; the one de-list lever is `data/library-excluded.json`, which does not
exist and is not created (I12: the old surface stays visible and honest until
the operator's removal patch, the same treatment `web-channel-default` got in
G1).

### D29. Deviations accepted while the G2 build landed (2026-09-02)

The build ran as five disjoint-ownership agents; where an agent read the
contract differently from D20-D28 and the reading was better, the code stands
and the contract is amended here rather than re-litigated:

- `tts_enabled` stays the ONE TTS kill switch; `tts_backend` is a selector
  under it (D21 read as if `tts_backend` alone could turn TTS off).
- `POST /tts` accepts an optional `lang` (`pt` | `en`) so the browser's
  language-tagged clips share the phone's cache keys; `format` is still mp3
  only.
- `POST /stt` validates the body BEFORE the keyless `503`: an empty clip is
  the caller's `400` whatever the vault holds (order: auth, body, key,
  upstream).
- `connector.mjs`: a missing capture-service status file is a plain `Error`
  ("capture-service is not running"), not `awaiting_connector` - the connector
  is connected, the service is down; pausing the run for a "connect" the user
  cannot perform would lie. Only a missing `CAPTURE_TOKEN` is
  `awaiting_connector`.
- omi-channel's `/ack` route is removed outright (404): kanban-loop's
  `fanOutAck` treats 404 as not-for-you, and capture-service serves the one
  `/ack`.
- Every dead omi key (`wake_*` tuning, `delegate_*`, `classify_*`,
  `chat_enabled`, `public_base_url`) is REMOVED from omi's `config_schema`
  rather than parsed-and-ignored; the compositions drop the omi `wake_*`
  values in the same pass. The capture-service selections in both
  compositions already carried the identical tuning
  (15000 / 0 / 45000 / 45000 / 6 / 120000), and the omi text bus reads the
  same live config, so no Omi capture behaviour changed.
- `voiceProviderId()` reads the ACTIVE composition pointer, not the running
  record, so the talk health answers with the operative down; two `voice`
  providers read as "no provider" (the resolver refuses that composition at
  `up()` anyway).
- `OMI_TEXT_WAKE_SOURCE` = `OMI_WAKE_SOURCE` with `logPrefix: "capture-service"`,
  so the log names the process that wrote the line.
- `GET /capture/conversation/active` reports the pin only (the per-bus last
  reply is not a conversation the user chose).
- D25 resume relies on the gateway accepting a session id it previously
  returned as a session key; confirmed against the real gateway on this
  node's redeploy (see the G2 evidence).
- The wake-word guard in `kanban-loop/lib/ack.mjs` now mirrors
  capture-service's `DEFAULT_WAKE_VARIANTS` (gaining `zecke`) and reads
  `GARRISON_CAPTURESERVICE_WAKE_VARIANTS`; the runner projects each fitting
  only its own config, so the env read is a harness hook and the defaults
  govern in production - exactly as before, when the omi name never reached
  kanban-loop's process either.
- `tests/companion-lockstep.test.ts` mirrors omi <-> capture for
  `board-client`, `memory-writer`, `gateway-client`, `tailnet-serve` only, and
  `lang.mjs` capture-service <-> kanban-loop; `wake.mjs` and `echo-guard.mjs`
  have one copy (capture-service) and leave the gate.
- `activeCompositionEnvForFitting` (`src/lib/composition-env.ts`) applies
  `voiceEnvForEntry` too, so a Views Start with the operative down hands a
  voice consumer the same `GARRISON_VOICE_FITTING_ID` as `up()` and the heal
  fingerprint cannot differ between the two paths.
- The chat's disabled voice controls carry the host's health `reason`
  ("Voice unavailable: voice locked") instead of the retired "Voice fitting
  not running".
- `automations/lib/engine.mjs` canonicalises the connector id
  (`deepgram` -> `voice`) before the pause card and the `awaitingConnector`
  record, so the UI names the connector that exists.

### D30. What the G2 adversarial review changed (2026-09-02)

A 28-finding review ran over the G2 diff (evidence: `evidence/garrison-app/g2/review-summary.md`).
Findings were bucketed fixed / mitigated-with-follow-up / pre-existing-debt /
not-a-bug (27 fixed, 1 mitigated); the changes that touched a contract are
recorded here so D20-D29 read true:

- **Health bodies name the fitting, never its URL.** The talk router, the
  dev-env bridge and the claude-chat `VoiceClient` all carry `fitting: <id>`
  plus `maxTextChars`; the provider's loopback `url` from the status file
  stays server-side (CLAUDE.md, the browser-is-remote rule). A host that
  cannot read the advertised cap still chunks at 600.
- **One reason vocabulary, with two more words.** `"voice rest disabled"`
  (provider up, REST lane off) and `"capture token not sealed"` (vault OPEN,
  key absent) join `"no voice provider"`, `"voice provider not running"`,
  `"voice locked"` and `"voice unreachable"`; a locked vault is never
  reported as a missing token. dev-env mirrors every reason but the
  token-unset one (its token arrives in env, so absent means unstationed).
- **The proxy is bounded.** `VOICE_PROXY_TIMEOUT_MS = 20000` on the upstream
  fetch; an over-cap `/stt` body is drained and answered `413` with
  `Connection: close` (never `req.destroy()`, which the browser reads as a
  network error); a client that disconnects mid-stream tears the upstream
  down (`res.on("close")` + `!writableFinished`).
- **Upstream calls are bounded too.** `deepgram-rest.mjs` passes
  `AbortSignal.timeout` (`LISTEN_TIMEOUT_MS` 60 s, `SPEAK_TIMEOUT_MS` 20 s) to
  Deepgram, and `tts.mjs` the same speak budget to ElevenLabs; a hung provider
  is a `502 deepgram unreachable`, not a stuck request.
- **The PTY never inherits the fitting's vault secrets.** dev-env's
  `ptySpawnEnv` strips every name in its `secret_scope` (`PTY_ENV_DENY`, today
  `CAPTURE_TOKEN`; `tests/dev-env-pty-env.test.ts` keeps the list in lockstep
  with the manifest) before spawning a shell or Claude: the bridge speaks to
  the provider, the user's shell does not hold its key.
- **`secretsDelivered` derives from vault state.** A spawn record marks
  secrets delivered only when the fitting consumes the vault AND the env was
  non-empty AND the vault was unlocked at spawn; a locked-vault start with the
  runner's gateway/config projection is keyless and heals on unlock. The
  three recovery paths (`/start`, `/restart`, unlock heal) share one env
  projection, `desiredEnvForFitting` = the running operative's env when the
  operative is up, else vault + active-composition env; the heal takes it as
  `envFor` because `own-port-lifecycle.ts` must not import the runner.
- **Read-aloud is a sequential chunk queue.** claude-chat plays one chunk at
  a time, prefetches the next, and Stop/Pause act on the whole queue
  (`speakRunRef` AbortController, `pausedRef` between chunks). Read-aloud
  controls gate on `ttsUsable = voiceUsable && tts !== false`; the mic keeps
  `voiceUsable`, so a Deepgram-only vault still dictates but does not offer a
  speaker it cannot back.
- **omi-channel** accepts the four realtime envelopes (bare array,
  `{segments}`, `{transcript_segments}`, `{data:{segments}}`), counts
  `realtime_malformed` for anything else while logging only the SHAPE (I5),
  and its status page lists `CAPTURE_TOKEN` beside the Omi credentials. Its
  forwarder to the voice layer (D24) chains the batches of one session so the
  fire-and-forget webhook cannot reorder a spoken command, discovers
  capture-service from the home its own config was loaded with (never
  `process.env` behind the config's back), and reports readiness red after a
  rejected forward until the next batch lands.
- **The voice connector references clips, it does not carry them.**
  `synthesize` returns `{clip_id, clip_path, mime, bytes, backend}`;
  `audio_base64` only with `inline: true` (D26 amended). `transcribe`'s
  `audio_base64` is still one argv element in the automation engine's connector
  spawn, so the catalog says "under about 100 KB, else `path`"; moving connector
  args onto stdin is a protocol change for every connector and is a named
  follow-up, not part of this gate.
- **Contested finding, resolved by evidence.** The reviewer's "connector
  subset lets a connector name an unsealed key" was real in the schema and
  false in the shipped manifest; fixed in the schema (D26 amendment) and the
  D26 tests now use the shipped `[CAPTURE_TOKEN]` contract.
- **Pre-existing debt, out of this gate:** stale `27xxx`/`7xxx` port prose in
  several fitting summaries (browser-default, ports-default, monitor-default,
  power-default, screen-share-default, the retired deepgram-voice) and the
  `docs/INSTANCES.md` tables, which this gate DID rewrite to the committed
  8xxx map. The phantom orchestrator `config: {port: 8087, bind_host}` in
  both compositions (the Orchestrator binds nothing; 8087 is whatsapp-web's)
  is dropped. `tests/e2e/primary-runtime.spec.ts`, dead since the orchestrator
  own-port server retired on 2026-07-20 (it spawned a deleted `server.mjs`),
  is removed; its coverage lives in `tests/orchestrator-policy-store.test.ts`
  and `tests/e2e/muster-orchestrator.spec.ts`.

### D31. Scoped secrets come from the secret authority, and the spawn record tells the truth (2026-09-02)

Found while collecting the G2 live evidence on this node: after the redeploy,
`/api/voice/health` said `capture token not sealed`, capture-service's
`/health.voice` had `stt:false, restEnabled:false`, and omi-channel reported
`CAPTURE_TOKEN unset in the vault` - while `compositions/default/.env` carried
`CAPTURE_TOKEN` and `DEEPGRAM_API_KEY` and the spawn record said
`secretsDelivered: true`. The vault audit had `deliver ok secrets:[]` for
capture-service, dev-env and omi-channel on every up() since the mesh install
(the 01:18 G1 redeploy included), so this predates G2.

Root cause: two secret sources. The composition `.env` is rendered from the
state service (`materializeEnvViaAuthority`, mesh design), but the per-fitting
scoped delivery (`vaultEnvForEntry` -> `scopedSecrets`) still read this node's
LOCAL vault, which the mesh leaves empty on every peer. `secretsDelivered` was
then computed from that empty vault being "unlocked", so the record claimed a
delivery that never happened and the heal never fired. Every vault-consuming
own-port fitting ran keyless on every node but dev-madrid; on the authority
itself the local vault happens to hold the keys, which is why nobody saw it.

Decision, not reopened:

- **One secret source per node.** `scopedSecretsViaAuthority(scope)` in
  `src/lib/composition-sync.ts` is the seam: enrolled -> `POST
  /v1/secrets/resolve` for exactly the scoped keys (fail-closed on grants, the
  authority audits the read); unenrolled -> the local vault as before. It sits
  beside `materializeEnvViaAuthority` so the two projections cannot drift.
- **The spawn record derives from the source answering, not from the local
  vault's lock state.** `vaultEnvForEntry` keeps a per-fitting delivery ledger:
  true when the source answered (whatever it lacked does not exist anywhere,
  so a heal could do no better), false when it could not (locked vault,
  unreachable authority, refused grant). `secretsDelivered` reads the ledger;
  a fitting whose env was composed some other way falls back to the local
  unlock state, which is all a standalone box has.
- **Keyless starts are named.** The audit row says why: `authority-grant`
  (denied, listing the keys), `authority-unreachable` or `vault-locked`
  (outcome `error`), and a successful delivery carries `authority` or
  `local-vault` plus the keys the source did not have.
- **The ledger is a compose-to-spawn handoff, taken once.** The spawn consumes
  the entry and believes it only if the source answered AND every value it
  handed over is in the env actually being spawned; every start is preceded
  by a fresh compose, so a leftover entry never describes a later spawn.
- **A fitting that is not running never has its secrets fetched.** The
  vault-unlock heal pass used to compose the env for every vault consumer in
  the library before asking whether it was running, so the authority audited
  a `deliver ok` to `deepgram-voice` and `web-channel-default` (both
  unstationed) on every unlock. `startOwnPortFitting` now takes the env as a
  thunk, resolved under the per-fitting lock once the start is going ahead.
- **The shell reads the capture token through the same seam.** The talk
  router's `voiceToken()` (`src/lib/voice-provider.ts`) read the local vault,
  so `/api/voice/health` on a mesh peer said `capture token not sealed` while
  capture-service, now fed by the authority, was ready. It now calls
  `scopedSecretsViaAuthority([CAPTURE_TOKEN])`, and a failed read names its
  reason in the router's vocabulary: `voice locked` / `capture token not
  sealed` on a standalone box, `capture token not granted to this node` /
  `secret authority unreachable` on a mesh node (the router gained the two
  reasons and a `tokenReason()` host callback; the UI maps each to its fix).
- The stale `secretsDelivered: true` records on the mesh peers are cleared by
  the next full redeploy (down + up), which this gate ran; no migration.
- Out of scope here, recorded for the handoff: the connector routes
  (`src/app/api/connectors/[id]/{auth-env,oauth-start,oauth-callback}`) and
  `src/lib/cortex-proxy.ts` still read the local vault directly and have the
  same two-source shape on a mesh peer. Voice is the G2 surface; those are
  not.

Tests: `tests/composition-sync.test.ts` (authority delivery, missing keys
named, grant denial audited), `tests/vault-heal.test.ts` (an unreachable
authority spawns keyless with an honest record even though the mocked local
vault says unlocked; the heal pass asks the secret source only about the
fitting it respawns), `tests/voice-provider.test.ts` (token from the seam,
the four reasons) and `tests/talk-voice-router.test.ts` (`tokenReason()`
relayed verbatim, unknown strings fall back to locked, the shell's strings
pinned to the router's). D30's "`secretsDelivered` derives from vault state"
bullet is superseded by this decision.

### D32. Capacitor's start-file guard is fatal, so the app ships a bundled `public/` and lands through `appStartPath` (2026-09-02)

D1 said a missing `public/` is a logged warning. Reading `CAPBridgeViewController.loadWebView()`
(8.5.1) corrects that: `guard FileManager.default.fileExists(atPath:
bridge.config.appStartFileURL.path) else { fatalLoadError() }`, and
`fatalLoadError()` ends in `exit(1)`. `appStartFileURL` is `<public>/<appStartPath>`
even when a remote `server.url` is set, so the bundle carries
`ios/GarrisonApp/Resources/public/` as a folder reference. Three consequences:

- **Landing route.** `loadWebView()` is `public final` and loads `serverURL +
  appStartPath`; a second `load` issued from `viewDidLoad` would cancel the
  provisional one and Capacitor's `didFailProvisionalNavigation` would pull the
  error page in. So the descriptor sets `appStartPath = "talk"` when a node is
  configured and the bundle ships the placeholder `public/talk/index.html`
  (never displayed; it exists for the guard). The app opens on Conversations.
  A cold-start push route is handed to the page through
  `GarrisonPush.pendingRoute()`; until the shell consumes it (G4) the host
  navigates after the first load finishes (KVO on `isLoading`).
- **Bootstrap and offline are one bundled page.** With no node configured
  `serverURL` is nil and the bridge loads `capacitor://localhost/index.html`;
  with `errorPath = "index.html"` the same page loads when the node is
  unreachable. The page calls `GarrisonNode` (Capacitor injects
  `window.Capacitor.Plugins` into local pages too) to add, list, select and
  retry. `Web/OfflineView.swift` and `Web/NodePickerView.swift` from the G3
  list are therefore not written: the only native UI left is the consent sheet.
- **Node switch = bridge recreation.** `serverURL` is fixed per bridge
  instance, so `GarrisonNode.select` publishes a new current node and SwiftUI
  recreates `GarrisonBridgeViewController` (`.id(currentOrigin)`); the plugin
  promise resolves before the teardown.

### D33. Consent stays native inside `GarrisonCapture.start` (2026-09-02)

Invariant I6 outranks the G3 file list: `ConsentSheet.swift` is kept, not
deleted. `GarrisonCapture.start({kind: "microphone"})` presents it in a
`UIHostingController` sheet over the bridge view controller unless
`capture.consentSuppressed` is set, and only `onProceed` reaches
`CaptureController.start(consent:)`. The copy ("If you have people around,
always ask for consent.") and the "Don't ask me again" toggle are unchanged;
the web page never sees the decision, only the resulting `captureState`.

### D34. The delivery log goes with the screens that read it (2026-09-02)

`AckLog` existed for `SessionsView`'s "Delivery log" and the notification
handlers' readable copy. With the SwiftUI screens gone the store has no reader,
so `AckLog.swift`, its three append sites (`PushManager`, `CaptureController`,
`PendantController`) and `testAckLogAppendsBoundedNewestFirst` are removed.
The records that mattered never lived there: spoken receipts go back to
capture-service (`sendSpokenReceipt`) and digests land in Conversations (G5).
`SettingsView`'s controls become plugin methods (`GarrisonSpeech.settings /
configure / muteFor / unmute`, `GarrisonCapture.setConsentSuppressed`,
`GarrisonPush.register`, `GarrisonNode.*`) so G4's capture page can host them.

### D35. The capture token never crosses into the webview (2026-09-02)

`GarrisonNode.current()` / `list()` return `hasToken`, not the token, and
`add()` is the only way in. The page is same-origin with the node, but the
webview is not in the data path (I2) and a leaked token would let any script
on the shell speak to capture-service with the phone's identity. Native code
holds it; `CaptureController`, the broadcast extension and `PushManager` keep
reading `capture.baseURL` / `capture.token`, which `NodeStore.select` mirrors
(D4).

### D36. `viewport-fit=cover` in the shell (2026-09-02)

`packages/talk/ui/styles.css` already pads with `env(safe-area-inset-*)`, but
`generateViewport()` in `src/app/layout.tsx` never set `viewportFit: "cover"`,
so those insets were zero in the installed PWA and would be zero inside the
Capacitor webview (which extends under the status bar with
`contentInset: never`). The one shell change in G3 is that viewport flag; the
simulator screenshot in `evidence/garrison-app/g3/` is the check that the top
bar clears the status bar.

### D37. The shell reads `window.Capacitor` in exactly one module (2026-09-02)

`src/lib/native-bridge.ts` is the only place the shell touches the Capacitor
global: feature detection (`isNativeApp()`), typed facades for the five
plugins, and `isShellPath()` (the same rule `PushRouter.swift` applies). Pages
decide "native or not" through `BridgeGate` / `useNativeBridge()`, resolved
after mount so the server renders one markup for every client. There is no
React provider in `layout.tsx` (the plan's premise): a hook that checks a
global after mount needs none, and a provider would put a client boundary
around the whole tree.

### D38. Node switching: peer URL in a browser, stored record in the app (2026-09-02)

`NodeSwitcher` replaces `NodeBadge` in the sidebar and reads `/api/mesh/nodes`
on open. In a browser a row navigates to the same `pathname + search` on the
peer's tailnet host (`src/lib/node-switch.ts`; a peer without a tailnet host is
listed but disabled). In the app the peer must ALSO be one of the app's stored
nodes (`GarrisonNode.list()` matched by origin), because the token lives there
(D35); a mesh node the app has not been given is disabled with the reason "not
added in the app". Selecting calls `GarrisonNode.select` then `reload` - the
plan's `set()` does not exist; select + reload is the plugin's contract.

### D39. Push deep links carry `data.path`, derived on the node (2026-09-02)

capture-service's `appPathFor()` turns an explicit `path` or a `cardUrl` /
`link` on this node's `GARRISON_APP_URL` into a rooted shell path and the APNs
payload carries it beside `link` and `tag`. A link on any other origin yields
no path: the app must never open a peer's route as its own. The shell follows
routes through `PushRouteListener` (the `pushRoute` event, plus a drained
`pendingRoute()` for cold start); the iOS side was already reading `data.path`
in G3, so G4 changes no Swift beyond `ios/Tests/PushRoutingTests.swift`. The
device registry does not gain a `node` column (plan premise): a device registers
against the node it is loaded from, and the token is per node already.

### D40. The record button records the screen, and the conversation id rides in `session_start` (2026-09-02)

One control in every conversation's composer, rendered only when the host
hands the talk UI a native capture bridge (`TalkAppProps.captureBridge`; the
shell passes its one `native-bridge.ts` module, so the talk package never reads
`window.Capacitor` and D37 holds). Its tap calls
`GarrisonCapture.start({ kind: "screen_audio", conversationId })`: the plan's
"screencast inside conversations" is the screen broadcast (screen + microphone
via ReplayKit), so the button is "Record screen"; microphone-only capture stays
on the Capture page. The conversation id travels as an optional
`conversation_id` on the wire `session_start` (same `[A-Za-z0-9_-]{1,80}`
vocabulary as the thread store's `safeThreadId`, validated on both ends), is
persisted on the session record, and nothing else about the protocol changes.
The app cannot pass arguments to the broadcast extension (the system picker
starts it), so the plugin parks the id in the App Group
(`broadcast.conversationId`) and the extension consumes it exactly once at
`broadcastStarted`; a cancelled or failed start clears it, so a later Control
Center broadcast never inherits a stale conversation.

### D41. The digest is one assistant message keyed by the session id (2026-09-02)

`fittings/seed/capture-service/lib/digest.mjs`: when a session that named a
conversation ends, capture-service builds one message (mode, duration, device,
the transcript or the reason there is none, the recording id) and posts it to
`${GARRISON_APP_URL}/api/threads/<conversation_id>/messages` with
`idempotencyKey: capture-digest:<session_id>`, so a replayed session end posts
nothing twice - the thread store already dedupes on that key. It then sends a
push whose `path` is `/talk/<conversation_id>` through `notifier.sendPush`
only: the Companion-thread fallback would duplicate a message that already
lives in the right thread. No new config flag: a digest is implied by the
conversation id, and the existing `notify_enabled` gates the push as it gates
every other push. The plan's "digest" is this message; summarisation by the
Operative is a follow-up, the transcript is what the user asked to keep.

### D42. Mac recording (screen-share-default as a capture-service client) is deferred (2026-09-02)

D14 stands as the design: the Mac path is `screen-share-default` acting as a
capture-service client (ffmpeg to PCM over the same ws framing, the shell
forwarding `/api/record/*`, `CAPTURE_TOKEN` in its `secret_scope`). It does not
ship in this run: the phone path is the gate criterion, the Mac path is a
second client of a contract that G5 proves with the first, and the usage budget
for this run is spent on the gates that remain. The record button therefore
renders only where a native bridge exists; a browser on the Mac shows the
composer unchanged. Listed in `HANDOFF-garrison-app.md` with the file plan.

### D43. Own-port views embed inside the app; a phone browser keeps the new tab (2026-09-02)

The sidebar's own-port rows had one phone rule: open the fitting's own origin
in a new tab, because the iframe beside the rail is cramped. The app has no
tabs: a `target="_blank"` there navigates the ONE webview to the fitting's
origin and strands the user outside the shell (no menu, no back). So the rule
is now split on the bridge, not on width: a phone BROWSER keeps the new tab; the
app (a native bridge is present) embeds every own-port view at `/embed/<id>`,
same as desktop. At phone width the embed route drops the rail
(`shell-embed-full`) and carries its own bar: safe-area inset on top, Back
(history back, home when there is none), the fitting's library name, and a
Menu button that opens the drawer. Desktop and tablet are unchanged: rail plus
iframe, no bar. The `allow` list stays `clipboard-read; clipboard-write;
microphone; autoplay` - no stationed fitting asked for `camera`.

Found on the way: the runner's one-shot orphan sweep
(`reconcileOrphanedOwnPortFittings`, fired by the first
`/api/runner/<id>/state` read of a server process) SIGTERMs the pid named in any
own-port status file whose composition is not running. The G6 e2e spec had
written the Playwright worker's own pid into its fake `kanban-loop.json`, so
the sweep killed the test runner mid-test and Playwright reported it as a
browser closed early. The spec now triggers the sweep first and names no pid.

### D44. The pendant reaches the page through the plugin, and its words come back through the shell (2026-09-02)

Two seams, both chosen so the hardware can be swapped for the mock without
touching the page or the plugin.

The plugin side: `GarrisonPendantPlugin` already exposed the D7 surface but
was hard-wired to `PendantController.shared`, so the only way to drive it was
a paired device. It now reads its controller through a computed `pendant`
property with one test-only static override (`controllerOverride`); production
never sets it, the source check in `PendantFeedbackMappingTests` (the plugin
observes the shared controller and never builds its own) still holds, and
`PendantPluginMockTests` drives `status/connect/disconnect/forget` plus the
`pendantState` / `pendantBattery` listeners exactly as the bridge does
(`CAPPluginCall` in, resolved payload out) against a `PendantController` built
on `MockPendantTransport`. Capacitor detail worth knowing: a bare `CAPPlugin`
init has no listener tables; the bridge's `load(on:)` creates them, so the
harness mirrors that (`eventListeners`, `retainedEventArguments`, ids, then
`load()`) or `notifyListeners` silently drops every event. The plan's
CoreBluetoothMock-through-the-plugin variant is not needed: the scripted
peripheral is already proven against `PendantBLETransport` in
`PendantMockPeripheralTests`, and the plugin only sees the controller.

The page side: the plan named `/api/capture/sessions/<id>/events` behind a new
`src/app/api/capture/[...path]/route.ts`. The voice surface already lives in
the talk router (D9, D20, D22), so the live transcript is one more route there,
`GET /api/voice/sessions/<id>/events`, relayed by the existing
`pipeUpstreamSse` to capture-service's `/sessions/<id>/events`. The session id
is validated against the provider's own alphabet before any upstream hop; no
provider, not running, and an upstream error are the same named answers the
other voice routes give (503 / 503 / an SSE `error` frame). The token rides
only on the upstream hop when the host holds one (the provider's SSE route
trusts loopback and the tailnet, so it is not required). Nothing new in
`src/app/api`: the `/api` catch-all already mounts the router.

What the page shows changed with it: `PendantStatus` in `native-bridge.ts`
had a `state` key the plugin never emits (the old `PendantSection` was reading
`undefined` and would have shown "reading" forever on a real phone). The type
now matches `statusPayload` byte for byte (`connectionState`, `paired`,
`lostFrames`, `ambientConsent`, ...), and the section shows state, pairing,
battery, capture state, lost frames, policy, Pair/Connect/Disconnect/Forget by
state, and a "Hearing" panel over the relay whenever a `sessionId` is present
(interims replace the open line, finals settle, `{done:true}` closes it).

### D45. The shell viewport caps the scale; phone inputs are 16px (2026-09-02)

The second phone screenshot (Conversations on dev-madrid, converged build)
showed every right- and bottom-anchored control cut off: `+ New` and the Raw
toggle half off the right edge, the composer row half off the bottom, while
the left and top edges (rail, sidebar toggle, status bar clearance) were
right. WebKit on the Mac and the 17 Pro Max simulator against this node lay
the same thread out with everything inside the screen. Measuring the phone
against the WebKit shot: rail 55 vs 52, thread chip 114 vs 109, search box
257 vs 242, the `+ New` left edge 378 vs 354, all one ratio, 1.066 = 16/15.
That is the WKWebView focus zoom: with no `maximum-scale` in the viewport
meta, focusing a field whose font is under 16px zooms the page by 16/font
size and the zoom stays after blur, so the layout viewport outgrows the
screen. The 15px composer and 12px search inputs are exactly that.

Two fixes, both in the shell so every node serves them. `generateViewport`
(`src/app/layout.tsx`) now emits `maximum-scale=1, user-scalable=no` beside
`viewport-fit=cover`: WKWebView honours the cap and never zooms into a field;
Safari keeps pinch-zoom for accessibility regardless of the meta and honours
the cap for the focus zoom, so a phone browser loses nothing. And under
600px the talk skin sets the composer input, the conversation search, the
sidebar prompt and the brief editor to 16px, the size at which WebKit does
not zoom in the first place. No pixel of the Mac layout moves.

On the way: `.wc-backbar` (the Brief / return bar) is the top element of the
column whenever it renders and had no inset, so inside the app its Brief
button sat under the Dynamic Island while the conversation head under it
padded for a status bar it was not touching (the 17 Pro Max simulator shot
before this change). The bar takes `max(8px, env(safe-area-inset-top))` and
the head after it gives the inset up (`.wc-backbar ~ .cc-conversation
.cc-conv-head`).

Not changed: the sidebar Command group is still where the app-only Capture
page (D34) is reached, the phone rail collapsed and the group folded; that
is a discoverability question for the operator, not a defect.

### D46. A phone gets an app bar and a sliding menu; Conversations and Kanban fold under it (2026-09-02)

The operator's third phone check, against the converged build: "make the
menu one of those sliding menus, add a header with the button to open it
like mobile apps usually do, fix the responsiveness of the conversation area,
make the Kanban board and cards nice on mobile". What the phone showed was a
desktop layout squeezed: a 52px collapsed rail down the left of every page,
the `+ New` control floating over whatever the page put in its corner,
Conversations stacking three headers of its own (the floating thread toggle,
the conversation row, the chat status row) under the shell's rail, and the
Kanban view's desktop topbar and five side-by-side columns in a 390px frame.

Shell. Under 720px `AppShell` sets `.shell-phone` instead of `.shell-rail`:
one grid column, no rail. An in-flow sticky `<header class="app-bar">`
(`src/components/chrome/AppBar.tsx`) is the page header: menu button, the
page's name over the node name with a session-state dot, the page's own
controls, and the `+ New` control in the bar's flow (`CompositionCreator
inBar`) instead of fixed in the viewport corner. It absorbs the status-bar
inset (`--app-bar-h: 48px + env(safe-area-inset-top)`), so `.crumbs` drops
its own and the pages that fill the column (`.talk-page`, `.embed-view`)
subtract the bar's height. A page contributes through `useAppBar({title,
back, actions})`; with nothing registered the bar derives the title from the
route (`COMMAND_ITEMS` / `CAPTURE_ITEM` `isActive`, or the fitting's library
name under `/fitting` and `/embed`). The menu is the same `Sidebar`, now
always mounted at phone width as a drawer that slides in from the left
(`transform` plus a delayed `visibility` flip so its controls leave the tab
order when closed) behind a fading scrim; the close button is an X and the
dialog is labelled "Garrison menu". Tapping a row still closes it.

Embedded views. The G6 `.embed-bar` inside `/embed/<id>` is gone; the page
registers `useAppBar({title: <fitting name>, back: true})` and the app bar
puts Back where the menu button was and the menu at the trailing end. One
header component owns every phone header, so the safe-area inset is handled
in exactly one place.

Conversations. The talk skin is left alone; the shell's `talk-page.css`
scopes every phone rule under `.shell-phone .talk-page`, so the tablet,
desktop and standalone-host layouts do not move. The skin's floating thread
toggle is hidden and the app bar gets a Threads button that flips the
drawer through a counter prop (`TalkApp threadsToggle`, the only API added
to the package); the chat's status row (connection dot, model, ctx, theme,
Raw) is hidden inside a conversation; the conversation row is one compact
line, name then search, the id chip and cost chip hidden (they copy and read
from the desktop), the search widening over the name on focus; the thread
drawer and its scrim start under the app bar. The `padding-right` clearance
for the fixed `+ New` control no longer applies at phone width because the
control is in the bar.

Kanban Loop. The fitting's UI (`fittings/seed/kanban-loop/ui/`) gains a
phone layout under 640px (`PHONE_LAYOUT_QUERY` in `ui/phone-layout.ts`, one
query shared by the stylesheet and the components that change shape): a
compact topbar (title, card count, New card, and one 44px overflow control
holding History, Export and Import), a strip of column names and counts
above a one-column-at-a-time carousel (scroll-snapped, the next column
peeking, a chip tap scrolls to its column, the strip follows the scroll),
cards with 44px action buttons and wrapping chips, and the card sheet
full-height with a 44px close. The fitting's own topbar stays when it is
embedded, so under the app bar the name reads twice; the fitting is also the
whole page in a phone browser, where that topbar is its only header. Served
from the fitting's `dist/`, rebuilt by `ui/build.mjs` in the setup hook;
every node rebuilds it on `node:redeploy`.

Not changed: the desktop shell (rail, fixed `+ New`, sidebar) is untouched
above 720px; the Fittings rows still open own-port views in a new tab in a
phone browser (D43). The Playwright specs that opened the drawer through the
old rail's "Expand sidebar" now use the bar's "Open menu"; the embed spec
reads `app-bar` instead of `embed-bar`.

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
| `fittings/seed/capture-service/README.md` exists to edit | no README; the operator docs are `RUNBOOK.md` and `HUMAN_SETUP.md` (D27) | `ls fittings/seed/capture-service` |
| `packages/talk/src/handlers/voice.mjs` forwards the token | no `handlers/` directory; the voice proxy is `packages/talk/src/router.mjs` (`VOICE_STATUS_FILE` :99, `handleVoiceProxy` :287-322, dispatch :3205) and it forwards no `Authorization` header at all (D22) | `packages/talk/src/router.mjs` |
| `fittings/seed/web-channel-default/scripts/server.mjs:97` reads the deepgram status file | after G1 that file is a 25-line re-export of `@garrison/talk/server`; the read is `router.mjs:99` and `fittings/seed/dev-env/scripts/server.mjs:95` | both files |
| `CLAUDE.md:402` names deepgram-voice | the mention is at :410; the own-port list at :193-198 still carries 27xxx ports and `voice` (27085) | `CLAUDE.md` |
| `compositions/default/apm.yml:15,300`, `openai/apm.yml:15,276`, `data/library.json:201-210` | default :15 + :301-306, openai :15 + :270-275, library :200-214 | the files at HEAD |
| "8085 leaves the map" in `tests/mesh-serve-ports.test.ts` | the map is derived from `default_port:` in every `fittings/seed/*/apm.yml` on disk; 8085 stays while the directory stays (I12) and the test only asks for >10 distinct serve ports | `tests/mesh-serve-ports.test.ts:26-40` |
| D13 as first written: aliasing `deepgram` in `connector-invoke.mjs` keeps legacy automations working | auth env comes from `POST /api/connectors/<id>/auth-env`, which resolves the id against `provides` in `data/library.json` and 404s once deepgram-voice is de-listed; the alias must be applied before that call (D26) | `src/app/api/connectors/[id]/auth-env/route.ts:28-32` |
| `auth-env` scopes what an automation child receives | it delivers the fitting's ENTIRE `secret_scope`; a `connector: voice` on capture-service would hand out the Deepgram, ElevenLabs, capture and three APNs secrets (D26 narrows it) | same route :53-57 |
| `docs/RUNTIME_MATRIX.md` is hand-maintained | generated by `scripts/matrix-harness.mjs` on 2026-07-12 (28 fittings, no capture-service row) | file header |
| `docs/COMPANION_IOS_SPEC.md` §5b: on-device synthesis only, no cloud TTS | `ack-sink.mjs:199` ships `audioPath: /speak/<id>.mp3` and `SpeechSink.swift:146-165` plays the clip with the synthesizer as fallback; I8 there also says the Deepgram key is not in the vault | the two source files |
| talk's health probe lights up once capture-service answers `/health` | `handleVoiceHealth` reads `h.keyConfigured !== false`; capture-service's body has `secrets.deepgramApiKey` and no `keyConfigured`, so a keyless node would show the microphone (D20 adds both) | `capture-service/scripts/server.mjs:373-386` |
| omi-channel has its own wake pipeline to keep | its `lib/wake.mjs` is byte-identical to capture-service's (2160 lines), with five more identical helpers; the "second voice layer" is a copy (D24) | `diff` of the two directories |
| removing `deepgram-voice` from `data/library.json` de-lists it | `readLibrary()` (`src/lib/library.ts`) auto-registers every `fittings/seed/*` directory; the JSON is curation only and `data/library-excluded.json` (absent) is the only de-list lever. The entry is kept as a legacy row instead (D28 amendment) | `src/lib/library.ts`, `tests/library-autoregister.test.ts` |
| `fittings/seed/capture-service/lib/triage.mjs` exists (the plan's G2 list) | no such file; triage lives in omi-channel (`lib/triage.mjs`) and stays there | `ls fittings/seed/capture-service/lib` |
| `ZecaVoice` takes an injectable `fetchImpl` at HEAD | it did not; the G2 build added `cfg.fetchImpl` through `startServer` so the REST lanes can be tested without Deepgram | `fittings/seed/capture-service/lib/tts.mjs` |
| omi `public_base_url` / `chat_enabled` sit at `compositions/default/apm.yml:88,92` | they were at :82 and :86 (openai: same offsets); removed with the omi `wake_*` tuning in the same block | the files at HEAD~ |
| `tests/omi-wake-card-commands.test.ts`, `tests/lang-detect.test.ts`, `tests/ack-layer.test.ts` import omi-channel's wake/lang/echo-guard | those modules left omi-channel in G2; the tests import capture-service's copies (the wake lineage) | the three test files |

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

### G2 - one voice layer (file list after the G2 recon; D20-D28 are the contracts)

Provider (`fittings/seed/capture-service/`):

- `apm.yml`: `provides` gains `voice: companion` and `connector: voice`
  (channel stays first so the sidebar icon does not flip); `connector:` block
  (`auth: api_key`, actions `transcribe` / `synthesize`, `secrets:
  [CAPTURE_TOKEN]`); `summary` and `for_consumers` rewritten for the voice
  layer (no "operative", `tests/vocabulary.test.ts`), documenting `POST /stt`,
  `POST /tts`, `GET /health` `voice`, `POST /capture/ingest/text`,
  `POST /capture/conversation/active`; `config_schema` gains `tts_backend`,
  `tts_deepgram_model`, `stt_rest_language`, `active_conversation_window_ms`,
  `text_session_idle_ms`, and declares the drifted `wake_revise_after_ms`,
  `wake_revise_max_segments` (every key with a description, `quality.ts`).
- `lib/config.mjs` (`DEFAULT_PORT` 8097, the new keys, `elevenLabsApiKey`
  already read), `lib/deepgram-live.mjs` (`transcribeClip(cfg, bytes,
  contentType, {language, fetchImpl})` against `cfg.dgBaseUrl` turned into
  https), `lib/tts.mjs` (backend choice, Aura `POST /v1/speak`, clip id with
  backend + model, `available()` per backend), `scripts/server.mjs` (binary
  body reader, `POST /stt`, `POST /tts`, `/health` voice block +
  `keyConfigured`, `POST /capture/ingest/text`, `/capture/conversation/active`
  GET/POST/DELETE, third `WakeBus` for omi), `lib/ingress.mjs` (socket-less
  text session with idle finalise, no media log / transcript / capture_event),
  `lib/wake.mjs` (active-conversation window in `runDelegate`),
  `lib/ack-sink.mjs` untouched unless the speak frame needs a field.
- `scripts/connector.mjs` (new, D26), `RUNBOOK.md` (surfaces + kill switches),
  `HUMAN_SETUP.md` (ElevenLabs optional, browser voice needs Deepgram + capture
  token), `docs/api-notes.md` (the two REST shapes).
- tests: `tests/capture-service-voice-rest.test.ts` (new; in-file REST mock for
  `/v1/listen` and `/v1/speak`, auth ladder, 400/502/503, cache hit header),
  `tests/capture-service-text-ingest.test.ts` (new; session lifecycle, no
  capture_event, echo guard, wake routing to the omi bus),
  `tests/capture-service-connector.test.ts` (new; the CLI against a stub
  service), extend `tests/capture-service.test.ts` (health block, `DEFAULT_PORT`),
  `tests/capture-service-voice.test.ts` (backend selection, clip id),
  `tests/capture-service-wake.test.ts` (window; the stub gateway returns
  `session_id`).

Consumers and the shell:

- `packages/talk/src/router.mjs` (voice options, provider by id, Bearer
  upstream, health block), `packages/talk/src/server.mjs` (drop the two WS
  relays), `packages/talk/ui/voice-conversation.tsx` (speaker gated on `tts`),
  `packages/talk/ui/voice-clip.ts` only if a status shape changes;
  `src/app/api/[[...path]]/route.ts` + new `src/lib/voice-provider.ts` (D22);
  `fittings/seed/web-channel-default/scripts/server.mjs` + `apm.yml`
  (`CAPTURE_TOKEN` in `secret_scope`); `fittings/seed/dev-env/scripts/server.mjs`
  :95/:860 + `apm.yml` (`consumes: voice optional-one`, `CAPTURE_TOKEN`).
- `src/lib/runner.ts` (`GARRISON_VOICE_FITTING_ID`, D23) +
  `tests/own-port-lifecycle.test.ts` / `tests/runner-*.test.ts` coverage;
  `src/lib/metadata.ts` (`connector.secrets`), `src/app/api/connectors/[id]/auth-env/route.ts`,
  `src/lib/connectors-view.ts` (sealed = `connector.secrets` when present),
  `docs/METADATA.md` (the new field), `fittings/seed/automations/lib/connector-invoke.mjs`
  (alias + directory map), `src/components/chrome/Sidebar.tsx:324`.
- `packages/claude-chat/src/voice.ts:2` comment only if it names deepgram.

omi-channel (`fittings/seed/omi-channel/`, D24): `lib/forward.mjs` (new),
`lib/ingress.mjs`, `scripts/server.mjs`, `lib/config.mjs`, `apm.yml`
(`secret_scope` + `CAPTURE_TOKEN`, keys, prose), `scripts/speak.mjs`,
`scripts/omi.mjs`, `scripts/funnel-ensure.mjs` (drop the public_base_url
mention), docs (`RUNBOOK.md`, `HUMAN_SETUP.md`, `PROGRESS.md`, `DECISIONS.md`,
`docs/adr-omi-channel.md`); deletions listed in D24; tests
`tests/omi-channel*.test.ts` + `tests/omi-channel-mjs.d.ts`.

Compositions, registry, docs, tests:

- `compositions/default/apm.yml` (:15 dependency, :301-306 selection, omi
  `public_base_url` + `chat_enabled`) and `compositions/openai/apm.yml` (:15,
  :270-275, same omi keys); both pushed to the state service with rev CAS
  before `up()` (section 2); the Mac's regenerated lock is restored from HEAD.
- `data/library.json` (de-list :200-214; capture-service summary :667-679
  names the voice layer), `tests/seed.test.ts`, `tests/capabilities.test.ts`
  :117-139 (synthetic provider rename), `tests/matrix-harness.test.ts:30-39`
  (cosmetic), `tests/vault-heal.test.ts:35,616-618` (comment + fixture id),
  `tests/own-port-lifecycle.test.ts:203-221` (id string), delete
  `tests/deepgram-voice-live.test.ts`, rename `tests/connector-deepgram.test.ts`
  (D28).
- docs: `CLAUDE.md` (:81 connector example, :193-198 own-port list, :410),
  `docs/CAPABILITIES.md` (:14-17 keep `voice`, :148-150, :283-287),
  `docs/CAPABILITY_CONTRACT.md:41-45`, `docs/FITTINGS.md:197-198` (+ a
  capture-service bullet), `docs/INSTANCES.md:80-97`, `docs/RUNTIME_MATRIX.md`
  (dated note), `docs/COMPANION_IOS_SPEC.md` (:80-88, :200-206, :237-262,
  :407-417), `docs/voice-attended-checklist.md:15`, `docs/UI-FITTINGS.md:86-97`
  stays true.
- `fittings/seed/deepgram-voice/` stays on disk (I12); its removal rides the
  G8 patch with the web-channel fitting.
- evidence: `evidence/garrison-app/g2/` (curl transcripts of `/api/voice/health`,
  `/api/voice/stt`, `/api/voice/tts` through the shell from the tailnet origin,
  a push-to-talk screenshot, the omi forward counter on `/health`, vitest +
  typecheck + playwright summaries, the manifest push revs). Deploy:
  `npm run node:redeploy` (fittings and manifests changed).
- Found by the push-to-talk screenshots, fixed in this gate (the standing
  "be picky about the UI you see" rule): the "Notifications blocked" pill sat
  ON the voice panel for the whole hold (its offset measured `.cc-composer`
  alone; the panel floats above the composer's top edge), and at desktop
  width it sat over the shell sidebar's composition selector (viewport-left
  on a pane that is not at the viewport's left). `packages/talk/ui/composer-inset.ts`
  measures the composer plus the overlays anchored above it (`.wcv-panel`,
  `.cc-slashmenu`, `.cc-railmenu`) and PushEnroller publishes
  `--wc-composer-inset` and `--wc-composer-left`; the pill copy lost its em
  dash. `tests/talk-composer-inset.test.ts`; the parity spec's push-notice
  test now asserts the pill sits inside the conversation pane.

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
  `ios/GarrisonApp/Web/PushRouter.swift`, `ios/Shared/NodeStore.swift`,
  `ios/GarrisonApp/Resources/public/index.html` (bootstrap + offline page) and
  `public/talk/index.html` (start-file placeholder) - D32 replaced the
  planned `OfflineView.swift` / `NodePickerView.swift` with the bundled page,
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
- delete `ios/GarrisonApp/{ContentView,ConversationView,SettingsView,SessionsView,AckLog}.swift`
  and `ios/GarrisonApp/Pendant/PendantView.swift`; keep `CaptureController`,
  `BroadcastPicker`, `ConsentSheet` (D33), `ClipPlayer` (SpeechSink depends on
  it), `SpeechSink`, `PendantController`, `PendantBLETransport` as plugin
  backends.
- edit `ios/Tests/PendantFeedbackMappingTests.swift:72-95` (assert ownership on
  `GarrisonApp.swift` + `GarrisonPendantPlugin.swift` instead of the deleted
  view), drop `testAckLogAppendsBoundedNewestFirst` (D34), add
  `ios/Tests/{NodeRecordTests,BridgePluginRegistryTests}.swift`.
- shell: `viewportFit: "cover"` in `src/app/layout.tsx` (D36).
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

As shipped (2026-09-02; the pre-run plan below it is kept for the deferred Mac
path):

- `packages/talk/ui/record-button.tsx` (new; `RecordButton`, `CaptureBridge`,
  `describeRecordError`), `packages/talk/ui/app.tsx` (`TalkAppProps.captureBridge`,
  the composer adornment gains the button beside the mic when a bridge exists),
  `packages/talk/ui/index.tsx` (exports), `packages/talk/ui/styles.css`
  (`.wc-rec*`, skinned with the mic), `src/components/talk/TalkPage.tsx` (hands
  `nativeCapture` in when `useNativeBridge()` is true; D37).
- capture-service: `lib/digest.mjs` (new: `buildDigest`, `postConversationDigest`,
  `digestIdempotencyKey`, `digestPath`), `lib/ingress.mjs` (`conversation_id`
  optional on `session_start`, validated, persisted on the record),
  `lib/notify.mjs` (`conversationsBaseUrl` exported), `scripts/server.mjs`
  (`onSessionEnd` -> `emitSessionEvent` then the digest when the record names a
  conversation). No `digest_enabled` flag (D41).
- ios: `Shared/CaptureProtocol.swift` (`conversationId` -> `conversation_id`,
  omitted when nil), `Shared/CaptureUploader.swift` (`conversationId` sent in
  `session_start`), `Shared/AppGroup.swift` (`setBroadcastConversationId` /
  `takeBroadcastConversationId`), `BroadcastExtension/SampleHandler.swift`
  (consumes it once), `GarrisonApp/CaptureController.swift` (`start(consent:
  conversationId:)`), `GarrisonApp/Plugins/GarrisonCapturePlugin.swift` (`start`
  accepts and validates `conversationId`; `isConversationId`).
- tests: `tests/capture-service-digest.test.ts` (new, 8), `tests/e2e/capture-page.spec.ts`
  (record button case), `ios/Tests/CaptureProtocolTests.swift` (wire shape, id
  vocabulary, consume-once).
- evidence: `evidence/garrison-app/g5/`.
- Deferred (D42): the Mac path and its files below.

Pre-run plan for the Mac path (not shipped, see D42):

- `fittings/seed/screen-share-default/scripts/server.mjs` (`/record/start|stop|state`,
  capture-service client per D14), `apm.yml` (declare `secret_scope: CAPTURE_TOKEN`,
  config `record_audio_device`), `lib/capture-client.mjs` (the 17-byte framing,
  shared shape with `ios/Shared/CaptureProtocol.swift`).
- shell: `src/app/api/record/[...path]/route.ts` (forward to screen-share by
  status file); the record button's browser branch posts there.
- tests: `tests/screen-share-record.test.ts` (ffmpeg absent path).

### G6 - fittings in the app

As shipped (2026-09-02, D43):

- `src/components/chrome/Sidebar.tsx` (own-port healthy row: new tab only for
  a phone browser, `useNativeBridge()` decides; the app embeds at `/embed/<id>`),
  `src/components/chrome/AppShell.tsx` (`shell-embed-full` at narrow width on
  the embed route hides the rail), `src/app/embed/[fittingId]/page.tsx`
  (phone-width bar: Back, library name, Menu; `useAppShell()`),
  `src/app/globals.css` (`.embed-view`, `.embed-bar*`, `.shell-embed-full`).
  `browser-view-url.ts` unchanged: page-host resolution already picks the
  tailnet URL inside the app.
- tests: `tests/e2e/embed-in-app.spec.ts` (new: phone browser new tab, app
  embed + bar + menu + back, desktop unchanged); `tests/e2e/shell-overhaul.spec.ts`
  (two stale tests repaired: the 2026-08-28 searchbox label, the folded Fittings
  group). Vitest: `sidebar-grouping`, `sidebar-pins`, `view-instances`,
  `instance-isolation`, `mesh-serve-ports`, `vocabulary`.
- evidence: `evidence/garrison-app/g6/` (simulator screenshot of kanban-loop
  embedded in the app with the bar; the phone criterion is on the operator, see
  the handoff). No native code changed: no TestFlight build for this gate.

### G7 - pendant through the plugin, mock first

As shipped (2026-09-02, D44):

- ios: `GarrisonApp/Plugins/GarrisonPendantPlugin.swift` (computed `pendant`
  over `PendantController.shared` with the test-only `controllerOverride`
  seam; surface unchanged from D7), `Tests/PendantPluginMockTests.swift` (six
  cases: status vocabulary before connect, connect -> `pendantState` connected
  + `pendantBattery` 87 + haptics advertised, disconnect keeps the pairing,
  forget clears `AppGroup.pendantIdentifier`, a dropped packet is one
  `lostFrames`, `ambientConsent` mirrors AppGroup). `GarrisonCapturePlugin`
  untouched: the pendant session is the controller's, not the mic lane's.
- shell: `packages/talk/src/router.mjs` (`GET /api/voice/sessions/<id>/events`
  relay, `VOICE_SESSION_ID_RE`), `src/lib/native-bridge.ts` (`PendantStatus`
  in the plugin's vocabulary), `src/components/capture/CapturePage.tsx`
  (`PendantSection` rewrite + `useLiveTranscript`), `CapturePage.module.css`
  (`.transcript*`). The plan's `PendantPanel.tsx` and
  `src/app/api/capture/[...path]/route.ts` were not created (D44).
- tests: `tests/talk-voice-router.test.ts` (+5 relay cases, 24 total),
  `tests/e2e/capture-page.spec.ts` (+1: connected pendant shows state and
  streams the session's words through a fulfilled relay route; the
  GarrisonPendant stubs in the capture and embed specs speak the plugin
  vocabulary), `npm run e2e:pendant` unchanged and green.
- evidence: `evidence/garrison-app/g7/` (XCTest mock run log from the mini,
  playwright, vitest, reload, live relay probe over the tailnet). The pendant
  hardware was not in reach of this run: the phone criterion (pair, connect,
  see the words) is the operator's, listed in the handoff. TestFlight build:
  `evidence/garrison-app/g7/testflight.txt`.

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
