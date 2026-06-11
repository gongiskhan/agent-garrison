# deepgram-voice

Voice Fitting (channels role, own-port). A stand-alone server (default port
**7085**) that proxies
[Deepgram](https://deepgram.com) speech-to-text and text-to-speech so the API
key stays on the host and never reaches the browser.

It provides the `voice:deepgram` capability. Channel Fittings (e.g.
`web-channel-default`) consume it for push-to-talk recording, live streaming STT
with silence endpointing (hands-free), and read-aloud replies.

## Capabilities

- **provides** `voice:deepgram`
- **consumes** `vault (one)` — the runner injects `DEEPGRAM_API_KEY` from the
  vault into this Fitting's environment because it declares `consumes: vault`
  (see `src/lib/own-port-lifecycle.ts` `vaultEnvForEntry`).

## Endpoints

Discover the live URL at `~/.garrison/ui-fittings/deepgram-voice.json`.

| Method | Path      | In                                              | Out                          |
|--------|-----------|-------------------------------------------------|------------------------------|
| GET    | `/health` | —                                               | `{ ok, port, pid, host, keyConfigured }` |
| GET    | `/`       | —                                               | status HTML                  |
| POST   | `/stt`    | raw audio bytes (`Content-Type` = recording mime, e.g. `audio/webm`) | `{ transcript, confidence }` |
| POST   | `/tts`    | `{ "text": "...", "format": "mp3" \| "wav" }` (default `mp3`) | audio bytes (`audio/mpeg` or `audio/wav`) |
| WS     | `/stream?sample_rate=<n>&utterance_end_ms=<ms>` | linear16 mono PCM frames | JSON events: `ready`, `speech_started`, `transcript`, `utterance_end` (Deepgram live + silence endpointing) |

WS query params: `sample_rate` is the PCM rate in Hz (8000–48000, default 16000);
`utterance_end_ms` is the silence window before `utterance_end` fires (server
default 5000 ms; pass 1000–20000 to override).

When `DEEPGRAM_API_KEY` is absent, `/stt` and `/tts` return HTTP 503; `/health`
still reports `keyConfigured: false`.

## Vault key

Store the Deepgram key in the Garrison vault under `DEEPGRAM_API_KEY`. Models are
configurable (`stt_model` default `nova-2`, `tts_model` default `aura-asteria-en`).

## Verify

```
node apm_modules/_local/deepgram-voice/scripts/probe.mjs --probe   # prints "ok"
```
