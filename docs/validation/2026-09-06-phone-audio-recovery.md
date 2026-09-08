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

## MacBook Pro deployment and live transport

Source fix `0d456718` and selected-composition fix `2fbda098` were committed
locally; public pushes remained disabled. Authority CAS 41 -> 42 and exact
readback confirmed the one scalar/comment update. The existing unrelated
composition ordering diff was preserved.

The Mac deployment used a temporary launchd job with RunAtLoad true and
KeepAlive false: exactly one run, exit zero, then bootout. The default
composition restarted at 18:15:29 UTC with 17/17 views healthy and degraded
false. The running capture process had phone-audio transcription true; its
installed ingress, config and fitting manifest matched source byte-for-byte.
Private backup and deployment log: `~/.garrison/backups/phone-audio-20260906T181205Z/`.

A separate Chromium smoke at 18:16 UTC used the real AudioContext and
MediaRecorder with a generated synthetic WAV, not mocked audio APIs. It made
exactly one request through the Mac's HTTPS same-origin `/api/voice/stt` route.
The live provider returned 200 and the expected synthetic phrase with zero
word errors. Capture and browser closed cleanly; no conversation message was
sent. Results are retained in the backup's `verification/` directory; the
private harness and synthetic fixture remain under
`/private/tmp/garrison-audio-transport-smoke/` on this owner node. This proves
browser-to-provider audio transport, separately from the pending iPhone test.

The Air's SSH endpoint still timed out during this rollout. Its audio-code
update is pending reconnection; no Air deployment is claimed.

## Dev-madrid deployment

The same private Git bundle fast-forwarded the existing `main` branch to
`2fbda098`; no branch was created and no public push occurred. The existing
manifest ordering and node-local lockfile were backed up and preserved. An
external systemd one-shot completed with exit zero and no restarts. The default
composition restarted at 18:18:14 UTC. Verification at 18:20:20 UTC found
17/17 views healthy, degraded false, zero live capture sessions and
`screen_audio_transcribe=true` in the running process. Ingress/config hashes
matched tested source. Owner-node evidence is
`~/.garrison/rollout-backups/phone-audio-20260906T181326Z/post-deploy-evidence.json`;
the deployment log remains `/tmp/garrison-phone-audio-rollout-20260906T1813.log`
on dev-madrid.

The same real-browser synthetic-microphone smoke passed against dev-madrid's
HTTPS route at 18:21:05 UTC: healthy voice endpoint, one STT request, HTTP 200,
exact expected phrase (zero word errors), capture closed and browser exited
cleanly, no conversation send. That browser ran on the Mac, so its artifact
stays there at `/private/tmp/garrison-audio-transport-smoke/dev-madrid-live-result.json`.
The completed dev-madrid supervisor was also removed. Both node paths now
have live browser-to-provider proof; the phone and offline Air limitations
above remain unchanged.
