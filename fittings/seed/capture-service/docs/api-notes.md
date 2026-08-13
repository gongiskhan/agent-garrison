# External API notes — verified shapes

Fetched and verified against the live docs at build time (2026-08-13), per the
spec's docs-beat-spec rule. Differences from the spec are in `DECISIONS.md`.

## Deepgram live streaming (M2)

- Endpoint: `wss://api.deepgram.com/v1/listen` + query params.
- Auth: `Authorization: Token <DEEPGRAM_API_KEY>` — the **Token** scheme, not
  Bearer (verified on the Authenticating page; Bearer is for short-lived JWTs).
- Params this fitting sends:
  - `model=nova-3` (config `stt_model`) — nova-3 streaming supports
    multilingual code-switching.
  - `language=multi` (config `stt_language`) — the multi set includes
    Portuguese and English, the operator's two languages, switched mid-session.
    `pt`/`pt-PT` are also valid for single-language sessions on nova-2/nova-3.
  - `encoding=opus&sample_rate=16000&channels=1` — **raw Opus packets**
    (`opus` = bare packets; `ogg-opus` would mean the container, which the
    wire protocol deliberately does not carry). `sample_rate` is required
    whenever `encoding` is used.
  - `diarize=true` — response words carry integer `speaker` labels (the API
    reference's streaming response example shows `words[].speaker`).
  - `interim_results=true`, `smart_format=true` (punctuation + capitalization;
    punctuated finals matter downstream: the wake bus closes a capture early
    on sentence-ending punctuation).
- Client control messages (JSON text): `{"type":"KeepAlive"}` (the connection
  drops after ~10s without audio; we send one every 5s when idle),
  `{"type":"CloseStream"}` (flushes the final results, then the server
  closes), `{"type":"Finalize"}` (mid-stream flush; unused here).
- Server messages: `{"type":"Results", channel_index, start, duration,
  is_final, speech_final, channel:{alternatives:[{transcript, confidence,
  words:[{word, start, end, confidence, speaker?}]}]}}`,
  `{"type":"Metadata", ...}`, `{"type":"UtteranceEnd", ...}`,
  `{"type":"SpeechStarted", ...}`.
- Segment mapping here: one Results frame -> one segment
  `{start, end: start+duration, text: alternatives[0].transcript,
  speaker: words[0].speaker ?? null, is_user: speaker in {null, 0}}` —
  `is_user` is a heuristic (the session owner is normally the dominant first
  speaker on a phone mic); the wake bus uses it only to label classifier
  context, never to gate.

## APNs (M5 — to verify at that milestone)

Apple's doc pages are JS-rendered and unfetchable server-side; the working
reference is ios-thing's `mac-bridge/apns.js`, proven in production: HTTP/2 to
`api.push.apple.com` (`api.sandbox.push.apple.com` for development builds),
`POST /3/device/<token>`, headers `apns-topic` (bundle id),
`apns-push-type: alert`, `apns-priority: 10`,
`authorization: bearer <ES256 JWT>` where the JWT is signed with the .p8 using
`dsaEncoding: 'ieee-p1363'` (JOSE r||s — DER is rejected), `kid` header, `iss`
team id, `iat`, cached under 40 minutes (APNs wants 20-60 min refresh).
Payload `{aps:{alert:{title,body}, sound, "interruption-level":
"time-sensitive"}}` paired with the app's time-sensitive entitlement.
`410`/`BadDeviceToken`/`Unregistered` mark a token dead (prune it);
`TooManyRequests`/5xx honour `Retry-After` with a backoff wider than the
limit. Verify against the sandbox before shipping M5.
