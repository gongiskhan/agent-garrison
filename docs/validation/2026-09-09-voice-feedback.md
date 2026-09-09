# Voice feedback repair — 9 September 2026

The user reported Zeca hearing its own speech, answering a Portuguese wake with
"Yes?", and repeating replies in Portuguese and English. Live inspection found
one pendant connected to the Pro capture service.

## Confirmed causes and changes

- Native speech registered its echo fingerprint before TTS rendering, then let
  it expire after 30 seconds. Playback now refreshes protection after rendering
  and keeps short transcript fragments covered until the completion receipt.
  Lost receipts expire; completion has a bounded 1.5-second STT tail. New user
  sentences and ordinary yes/no answers continue through the guard.
- Native acknowledgements had no speech deduplication. Concurrent requests and
  retries now share one delivery per acknowledgement identity.
- The always-watching Conversations page and the native capture sink could
  independently speak the same stretch. A shared claim keyed by conversation
  and stretch selects one speaker before rendering. A connected native sink
  takes precedence; broadcast-only playback remains available in the page.
- Arbitrary assistant notifications changed the global wake language. Only user
  speech now teaches it; old records without user provenance are discarded.
  Wake-bearing interims teach the cue before it is emitted. Explicit pins and
  the user's words outrank model-generated titles and replies. Spoken prompts
  and provider guidance require one language unless translation was requested.

No native iOS binary, credentials, account routing or capture-source priority
changed. The Mini's separate recovery remains outside scope.

## Verification

The wider capture/pendant regression suite passed 435 checks across 32 files.
After adding the HTTP ownership test and short-cue fragment assertion, the
final affected suites passed 56 checks. TypeScript and the fitting's four
validation checks passed. The HTTP fixture verifies native/page polling in
both orders and replaying a translated version under the same reply identity.
The stored-transcript regression verifies that one-word "Zeca" and fragmented
assistant speech never enter the transcript or wake bus, while real speech does.

These automated checks are not physical-phone acoustic acceptance.

## Initial live verification

Commit `feffa422` is pushed to the Pro permanent branch. A supported fitting-only
restart loaded the server repair at about 17:10 UTC, PID87056. The actual pendant
reconnected and STT/TTS health remained available. One Portuguese test phrase was
forwarded once and confirmed once by the phone through the generated clip, with
zero failures and no new wake/dispatch. No fresh audio packets arrived during
that measurement, so it does not establish acoustic echo suppression on-device.

An isolated Chromium page on the Pro's real HTTPS origin loaded a test bundle of
the changed reply player. The real `/api/voice/spoken` proxy returned HTTP200 with
`speak:false` while the native sink was connected; the player made zero TTS,
clip-playback or synthesizer calls. The existing page's web-push-key HTTP503 is
unrelated to this successful voice request. The shipped app bundle still needs
the full redeploy below; injecting the test bundle is not deployment.

Full deployment is coordinated with the concurrent session-card task, whose
owner has temporarily frozen production builds until its app/gateway changes
reach a verified checkpoint. No peer work was stashed, discarded or deployed
while incomplete.

## Full deployment and final live verification

The session-card owner committed and froze checkpoint `7cffb647`, containing
voice repair `feffa422`. The combined Pro branch was pushed and fully redeployed.
The final composition started at 17:28:36 UTC: all 43 startup checks passed,
17/17 fitting views were healthy, and the node reported no degradation. Capture
PID53976 had STT/TTS, wake and pendant enabled, with one reconnected, speakable
phone session and no Zeca routing error.

Chromium loaded the actual production Conversations chunk
`75.f1cae4748f284f87.js` from the Pro HTTPS origin. Its served bytes contain the
new `replyKey`, `playbackId` and completion registration. A silent page request
to `/api/voice/spoken` returned HTTP200 with `speak:false` because native playback
owned the sink. This verifies the deployed client and proxy, without injecting
the earlier test module. Final browser and node evidence lives on the Pro:
`/tmp/garrison-voice-browser-final.log`, `/tmp/garrison-voice-final-health.json`
and `output/playwright/zeca-voice/deployed-talk.png`.

The temporary `launchctl submit` supervisor unexpectedly repeated after its
first successful exit (`OnDemand=false`). Re-entry was blocked, the second
already-running deployment completed, and the temporary job was removed. Its
wrapper recorded exit127 from rereading the edited running script after the
successful deployment; both deployment completion records and the independent
live health checks above establish the actual outcome. No build or deployment
process remains. Future one-shot supervisors should use an explicit launchd
plist with `RunAtLoad=true` and `KeepAlive=false`, not `launchctl submit` defaults.
The peer's production-input freeze was released immediately afterward.

Physical-phone acoustic acceptance remains open: the connected phone confirmed
the earlier Portuguese clip, but no fresh microphone packets arrived during
that measurement. Reopen the app to load the client change, then verify a real
Portuguese wake/request does not produce a self-trigger, English cue or repeated
translation. No native binary or other mesh node was deployed for this repair.
