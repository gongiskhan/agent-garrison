# D58 - the spoken answer is the voice layer's voice (2026-09-04)

Report: "The feedback is using the default iPhone voice instead of using
Eleven Labs or Deepgram." `speakReply` drove `GarrisonSpeech.speak`, whose
only engine is `AVSpeechSynthesizer`. Fix in
`packages/talk/ui/capture-feedback.ts`: render through `POST /api/voice/tts`
in sentence-sized chunks (600-char cap) and play the mp3 clips in order via
`HTMLAudioElement`; the phone voice speaks only when no clip can be had.

- `vitest.txt`: `tests/talk-capture-feedback.test.ts`, 12 passed (D58
  `speakReply` cases: voice-layer path, master switch, chunked long answer,
  fallback on 503 / offline / unplayable; `chunkForTts`).
- `probe-headers.txt`: `POST /api/voice/tts {"text":"Voice layer check."}`
  against the live shell on this Mac before the reload: 200 `audio/mpeg`,
  5956 bytes, `MPEG ADTS layer III 48 kbps 22.05 kHz mono` (the clip itself
  is not kept). capture-service `/health` at the time: `tts: true,
  ttsBackend: "deepgram", maxTextChars: 600`, ElevenLabs key unset.
- `npx tsc --noEmit`: only the pre-existing error in the other agent's
  uncommitted `tests/capture-service-pronunciation-aliases.test.ts`.

No `ios/` change, so no TestFlight; the D57 build plays the new clips.
