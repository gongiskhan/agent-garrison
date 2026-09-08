# G5 - record button + digest

Gate: a conversation in the app carries a Record button; the recording that
starts from it names the conversation; when the recording ends the digest
lands in that conversation as an assistant message and a push deep-links
back to it. Decisions D40-D42 in `docs/decisions/2026-09-garrison-app.md`.

## What shipped

Phone path (screen + microphone via the broadcast extension):

- `packages/talk/ui/record-button.tsx` - the Record button. Rendered only when
  the shell hands the talk UI a native capture bridge (`TalkAppProps.captureBridge`,
  wired in `src/components/talk/TalkPage.tsx` from `useNativeBridge()`), so the
  browser build of Conversations is unchanged (D37 holds: the webview never
  touches audio). Starts `screen_audio` with `{ conversationId }`, shows
  Starting / Stop recording / Stopping, folds `broadcasting` from the plugin's
  `captureState` events and a status poll while not idle.
- `ios/GarrisonApp/Plugins/GarrisonCapturePlugin.swift` - `start` accepts
  `conversationId` (validated against the thread-id vocabulary
  `[A-Za-z0-9_-]{1,80}`, `BAD_CONVERSATION` otherwise). Microphone sessions pass
  it straight to `CaptureController.start(consent:conversationId:)`; broadcast
  sessions park it in the App Group (`AppGroup.setBroadcastConversationId`)
  because the system picker starts the extension, and `SampleHandler` consumes
  it once (`takeBroadcastConversationId`).
- `ios/Shared/CaptureProtocol.swift` + `CaptureUploader.swift` -
  `session_start.conversation_id` on the wire, omitted when nil.
- `fittings/seed/capture-service/lib/ingress.mjs` - validates and persists
  `conversation_id` on the session record.
- `fittings/seed/capture-service/lib/digest.mjs` - builds the digest (mode,
  duration, device, transcript clipped to 6000 chars head+tail, honest
  no-transcript reasons) and posts it as ONE assistant message to
  `POST <app>/api/threads/<id>/messages` with idempotency key
  `capture-digest:<session id>`; then `sendPush` with `path: /talk/<id>`,
  tag `recording_digest`. Never throws; counters `digest_posted`,
  `digest_post_failed`, `digest_skipped_no_app`.
- `fittings/seed/capture-service/scripts/server.mjs` - `onSessionEnd` calls
  `postConversationDigest` when the record names a conversation.

Not shipped (D42): the Mac recording path through `screen-share-default`. The
plan's D14 premise (screen-share exposes a recording that capture-service can
ingest) does not match live code; listed in the handoff.

## Evidence in this directory

- `vitest.txt` - full suite after the fix to
  `tests/web-channel-conversation-surface.test.ts` (the structural test slices
  the `<ConversationView` mount; the adornment was hoisted into a `useCallback`).
- `playwright-capture.txt` - `tests/e2e/capture-page.spec.ts` incl. the new
  "conversation composer: the record button appears with the native bridge and
  passes the conversation id" case, desktop-chromium + mobile.
- `xctest.log` - `ios/Tests` on the Mac mini simulator: 93 tests, 0 failures
  (new: `testConversationIdVocabulary`, `testBroadcastConversationIdIsConsumedOnce`,
  wire-shape assertion for `conversation_id`).
- `live-digest.txt` - the digest posted end to end on THIS node after the
  redeploy: a `session_start` naming a fresh thread, `session_end`, the thread
  read back holding the assistant digest message. Token read in-process from
  the composition `.env`, never printed.
- `redeploy.txt` - tail of `npm run node:redeploy` (capture-service restarted
  on the digest code).
- `testflight.txt` - the TestFlight dispatch for this gate.

## Phone criterion (operator)

The simulator cannot run the broadcast extension. On the TestFlight build:

1. Open a conversation in the app; the Record button sits beside the microphone.
2. Tap Record, confirm the system broadcast picker, speak, stop.
3. The digest appears in that conversation; the push opens `/talk/<id>`.
