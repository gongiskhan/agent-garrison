# D59 evidence - vault write-through, ElevenLabs quota fallback, visible phone-voice reason (2026-09-04)

- `authority-keys-after.txt` - key NAMES held by the mesh secret authority after
  the push (27; `ELEVENLABS_API_KEY` present). Values were never fetched.
- `resolve-from-macbook-pro.txt` - `POST /v1/secrets/resolve` from this node
  returns both TTS keys, nothing missing.
- `health-macbook-pro-after.json` - capture-service `/health` after the heal +
  the fallback restart: `elevenLabsApiKey: true`, `ttsBackend: "deepgram"` with
  `ttsFallback.reason` naming the ElevenLabs `401 quota_exceeded` wall
  (0 of 30212 credits left on the account).
- `tts-probe-headers.txt` - `POST /api/voice/tts` through the talk router
  answers 200 audio/mpeg while ElevenLabs is parked (Aura rendered the clip).
- `vitest.txt` - the three suites: vault write-through (4), voice incl. the
  fallback block (22), capture feedback incl. fallback reasons (12).

The mini and dev-madrid were healed (`elevenLabsApiKey: true`) with the
pre-fallback code; they pick up the fallback on their next fast-forward +
capture-service restart.
