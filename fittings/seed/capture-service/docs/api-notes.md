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

## Deepgram pre-recorded (the `/stt` clip lane)

- Endpoint: `POST https://api.deepgram.com/v1/listen` + the same query
  params as streaming; the fitting sends `model=<stt_model>`,
  `smart_format=true`, `punctuate=true`, `language=<stt_rest_language or
  stt_language>`.
- Auth: `Authorization: Token <DEEPGRAM_API_KEY>` (same scheme as the socket).
- Body: the raw clip bytes, `Content-Type` = the recording's type
  (`audio/webm` from a browser MediaRecorder, `audio/m4a` from the phone).
  Deepgram sniffs the container; the header is advisory.
- Response: `results.channels[0].alternatives[0].{transcript, confidence}`;
  the fitting returns `{transcript, confidence, language, model}` and maps
  any non-2xx to 502 `{error: "deepgram upstream failed", backend, status,
  detail}` with a 200-char excerpt of the upstream TEXT body (never audio).
- Base URL: `cfg.dgRestBaseUrl`, derived from `GARRISON_CAPTURESERVICE_DG_URL`
  by scheme flip so tests point both lanes at one mock.

## Deepgram Aura text-to-speech (the `deepgram` TTS backend)

- Endpoint: `POST https://api.deepgram.com/v1/speak?model=<tts_deepgram_model>`
  (default `aura-asteria-en`; on Aura the model IS the voice).
- Auth: `Authorization: Token <DEEPGRAM_API_KEY>`.
- Body: JSON `{text}`; `Accept: audio/mpeg` selects mp3 so the clip is the
  same shape ElevenLabs produces and the phone's `/speak/<id>.mp3` serves it
  unchanged.
- Cache id: `sha256("deepgram <model> <text>[ <lang>]")` - a different
  input from the ElevenLabs id (`<model> <voiceId> <text>[ <lang>]`, kept
  byte-identical so existing on-disk clips stay valid), so switching
  `tts_backend` never replays the other engine's recording.

## This fitting's voice REST (D20)

- `POST /stt`: Bearer `CAPTURE_TOKEN`; raw bytes, `Content-Type` of the
  recording (default `audio/webm`), 8 MB cap (413), optional `?language=`.
  200 `{transcript, confidence, language, model}`; 400 empty body; 503
  `DEEPGRAM_API_KEY not sealed`; 502 upstream.
- `POST /tts`: Bearer `CAPTURE_TOKEN`; JSON `{text, format?: "mp3", lang?:
  "pt"|"en"}`. 200 `audio/mpeg` with `X-Voice-Backend` and `X-Clip-Id`; 400
  empty text, text over 600 characters (the caller chunks), or a format other
  than mp3; 503 when no backend can speak (`tts_enabled` off, or no key for
  the selected backend); 502 upstream with the backend named.
- `GET /health`: `voice: {stt, tts, ttsBackend, restEnabled}` plus
  `keyConfigured` (= `voice.stt`) and `secrets.elevenLabsApiKey`.

## This fitting's text ingest and active conversation (D24, D25)

- `POST /capture/ingest/text`: Bearer `CAPTURE_TOKEN`; JSON `{source: "omi",
  session_id, segments: [{text, speaker?, is_user?, start?, end?}]}`.
  `source` must be in the allow-list (`omi`); `session_id` is 1-80 chars of
  `[A-Za-z0-9_.:-]`; `segments` is an array (empty allowed - it only extends
  the idle timer). 202 `{session: "<source>:<session_id>", accepted}` where
  `accepted` counts the non-empty segments that survived the echo guard; 400
  on invalid JSON or any missing/invalid field with the reason in `error`;
  401 bad Bearer; 403 `enabled` off or `CAPTURE_TOKEN` not sealed; 413 over
  the body cap. Idempotent for the session: the same key on the next call
  reuses the live text session.
- `GET /capture/conversation/active`: Bearer; 200 `{session_id, until}` with
  both `null` when nothing is pinned or the pin expired (`until` is ISO-8601).
- `POST /capture/conversation/active`: Bearer; JSON `{session_id}` (1-200
  chars); 200 `{session_id, until}`, `until` = now + `active_conversation_window_ms`;
  400 when `session_id` is missing.
- `DELETE /capture/conversation/active`: Bearer; 204, idempotent.
- Any other method on `/capture/conversation/active`: 405.

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
