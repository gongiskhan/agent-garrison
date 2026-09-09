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

Deployment and HTTPS verification are recorded below after completion. These
automated checks are not physical-phone acoustic acceptance.
