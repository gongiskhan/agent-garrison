# Phone microphone recovery, 2026-09-06

The reported Record failure reached the MacBook Pro capture service: a recent
20.08-second broadcast delivered 1,004 valid Opus frames and 30 video frames.
Numeric-only decoding found substantial audio (RMS -22.93 dBFS, peak -5.38
dBFS), without listening to, exporting, or transcribing the recording. Native
ReplayKit code uploads microphone samples and ignores app playback. Both
reachable nodes had `screen_audio_transcribe=false`; the Mac's transcription
skip counter and missing transcript matched that policy. Existing REST-STT
counters do not establish the cause of the latest dictation attempt.

D66 in `docs/decisions/2026-09-garrison-app.md` records the changed requirement:
explicit Record uses the phone microphone when higher-priority capture sources
are not providing audio. Fresh pendant audio takes priority, then Listen,
then Record. Source selection follows accepted audio and socket state through
the same session, with a two-second freshness bound for a silent connection.
An explicit false flag retains screen-only behavior. SSE subscription lifetime,
media ordering, acknowledgement and persistence remain intact.

Dictation now starts its AudioContext from the tap before awaiting microphone
permission, verifies running audio, and rejects recorder startup failure.
Interrupted capture releases the microphone and resets the Dictating state
while preserving typed text. Record shows native capture/broadcast errors and
explains the iOS system picker's Microphone switch.

Verification uses isolated capture stores and synthetic audio. The 22 new
source-arbitration tests exercise real ingress callbacks and media ordering
with stub sockets/ASR; browser component cases exercise the real React UI with
mocked media APIs. These are distinct from a real microphone/STT transport
smoke and from physical iPhone acceptance. Deployment and final test results
are appended below after verification. No iOS source changed and no new native
release is required by this fix.

The phone gate remains open: with the pendant disconnected, turn Microphone
On in the broadcast picker, start Record and check one harmless spoken Zeca
request; use Dictate to fill an unsent draft; then connect and disconnect the
pendant while Record continues. An unannounced BLE/audio loss can leave up to
two seconds before fallback. Full utterance continuity across that boundary
is not proved by per-packet arbitration.

## Pre-deployment checks

- 90 capture tests passed across six suites: 22 new fallback cases plus 68
  ingress, live mock-Deepgram/SSE, pendant, digest and wake-conversation cases.
  One historical static-mute assertion was updated for the new policy. The
  first fallback run also corrected a test's byte-count expectation to include
  existing media-log headers; production storage behavior did not change.
- 71 focused frontend tests passed, including ten capture startup/resource
  cases and four Chromium component cases (permission denial/retry, recorder
  failure/retry, STT 502, and native Record failure).
- TypeScript typecheck and whitespace checks passed.
- Authority preview at revision 41 changes exactly one semantic scalar,
  `capture-service.screen_audio_transcribe: false -> true`, plus its explanatory
  comment. It preserves every other selection, duty, target and shared file.
