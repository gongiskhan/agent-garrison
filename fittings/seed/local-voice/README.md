# Local Voice

Fully **local, multilingual** speech I/O for Agent Garrison — no cloud, no API
key. A drop-in alternative to `deepgram-voice`: it provides the same
`kind:voice` capability, so any channel that consumes voice (the web channel,
the Jarvis HUD) works against it unchanged. `voice` is a singleton, so you
station **one** voice Fitting per composition.

**Multilingual.** `/stt` auto-detects the spoken language (PT, FR, EN, ES, IT, …)
and returns it; `/tts` speaks the reply back in the language of the *response
text* — so "spoke PT, asked for the answer in EN" is voiced in EN. The language
travels with the transcription and the voice is chosen locally from the text,
so there is **no extra round-trip and no added latency** (the brief's anti-delay
rule).

**Two TTS engines, picked per language.** Portuguese uses **Piper** with the
`pt_PT-tugão` voice — native **European** Portuguese (Kokoro v1.0 only has
Brazilian pt voices) and faster (RTF ~0.12). Every other language uses **Kokoro**.
The router is `piper_voices` (lang → Piper model) with a Kokoro fallback; add a
Piper voice for any language to switch it over. FR has only a female voice in
Kokoro, so the voice changes with the language — an accepted consequence.

## How it works

```
  channel ──HTTP──▶  local-voice (Node, :7090)  ──HTTP──▶  voice-server (Python)
   /stt /tts          own-port wrapper + status file        faster-whisper STT
                                                            + Kokoro/Piper TTS
```

- **`scripts/server.mjs`** is a thin Node own-port wrapper. It owns the public
  port (default `7090`) and the status file
  (`~/.garrison/ui-fittings/local-voice.json`), and supervises the Python
  voice-server on an internal localhost port. On `down` the Garrison runner
  kills this Node process, which in turn kills the Python child.
- **`voice-server/`** is the speech engine (Kokoro TTS + faster-whisper STT).
  See *Provenance* below.

### Endpoints (Garrison voice contract)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ok, port, pid, host, enginesReady }` |
| `POST` | `/stt` | raw audio bytes (`audio/webm`/`audio/wav`) | `{ transcript, confidence, detected_language }` (confidence is `null`; `detected_language` is an ISO-639-1 code) |
| `POST` | `/tts` | `{ "text": "...", "format": "wav" }` | `audio/wav` bytes, streamed sentence-by-sentence, in the text's own language |

`enginesReady` is `false` while the Python models warm up on first boot
(whisper JITs, ~10s); `/stt` and `/tts` return `503` until ready. The WS
`/stream` incremental-STT endpoint is **not** implemented in v1 — use batch
`/stt` with push-to-talk.

## Setup

`scripts/setup.sh` runs on every `up` (idempotent): creates a Python venv under
`voice-server/.venv`, installs the deps, and fetches the model files if missing —
Kokoro (`kokoro-v1.0.onnx` ~325MB + `voices-v1.0.bin` ~28MB) and the Piper
European-Portuguese voice (`piper-voices/pt_PT-tugão-medium.onnx` ~63MB).

- Needs **Python 3.10+** with `curl`/`wget` on PATH. Override the interpreter
  with `LOCAL_VOICE_PYTHON`.
- **Apple Silicon / no CUDA**: uses the CPU `onnxruntime` build (slower than a
  GPU, but fully local). See `voice-server/requirements.txt`.
- **Optional — `espeak-ng`** (`brew install espeak-ng`): Kokoro synthesizes
  PT/FR/ES/IT without it via its bundled grapheme-to-phoneme, but installing
  `espeak-ng` improves non-English pronunciation. Not required.

### Measured latency (Phase 0, this host — Apple Silicon CPU int8)

STT (multilingual `small`) ~1.7s for a ~4s clip; language auto-detected with
p≥0.98 for EN/PT/FR. Kokoro TTS runs at RTF ~0.4–0.5 and streams
sentence-by-sentence, so time-to-first-audio is a fraction of a second. The
whisper model loads once (~6s) and is warmed at boot, so the first real request
doesn't pay it. No cloud round-trip — comparable to or better than the prior
Deepgram path. See `scripts/spike/voice-multilingual.mjs`.

## Config (env / `config_schema`)

`port`, `bind_host`, `kokoro_voice` (`KOKORO_VOICE`), `kokoro_speed`
(`KOKORO_SPEED`), `whisper_model` (`WHISPER_MODEL`), `lang_voices`
(`LANG_VOICES`), `wake_word` (`WAKE_WORD`), `python_bin` (`LOCAL_VOICE_PYTHON`).

- `whisper_model` defaults to `small` (**multilingual**, auto-detects the spoken
  language). The `*.en` checkpoints (`small.en`…) are English-only — use them
  only for an English-only deployment.
- `lang_voices` is an optional JSON map `ISO-639-1 → { voice, klang }` overriding
  the per-language Kokoro voice. Defaults: `en`=`bm_george`/`en-gb`,
  `pt`=`pm_alex`/`pt-br`, `fr`=`ff_siwis`/`fr-fr`, `es`=`em_alex`/`es`,
  `it`=`im_nicola`/`it`. The response-text language is detected locally with
  `lingua`; unknown/uncertain text falls back to `TTS_DEFAULT_LANG` (default `en`).
- Wake word is **off** by default in v1 (push-to-talk; without headphones the
  mic would hear the host's own TTS).
- `WHISPER_LANG` (ISO-639-1, empty = auto-detect) hard-pins the STT language; for
  a single-language deployment (e.g. `pt`) this stops short utterances flipping to
  the wrong language. `WHISPER_PROMPT` seeds whisper's `initial_prompt` with domain
  vocabulary so jargon and Portuguese-conjugated English verbs ("comita", "deploya")
  transcribe correctly (faster-whisper keeps the last ~224 tokens — put the highest
  value terms at the end).
- `STT_NORMALIZE_GAIN` (`off` by default) peak-normalizes the input before STT to
  help a quiet/soft speaker. It's a no-op-at-best on clean audio, so only enable it
  (`on`) for a real low-SNR microphone, and A/B it with the actual speaker.

## Provenance

The `voice-server/` (`server.py`, `wakeword.py`) is reused from the Fable
`jarvis-hud` reference project. Garrison changes to `server.py`: (1) the listen
port is configurable via `VOICE_PY_PORT` so the Node wrapper can place it on a
free internal port; (2) **multilingual** — STT drops the hardcoded `language="en"`
and the English-only `small.en` model so it auto-detects and reports the spoken
language, and TTS picks the voice from the response text's language (`lingua`)
instead of always speaking British English; (3) **Piper** is added as a second
TTS engine so Portuguese gets a native European (pt_PT) voice Kokoro lacks.
Engines: [Piper](https://github.com/OHF-Voice/piper1-gpl) (pt_PT TTS),
[Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
(TTS), [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (STT),
[openWakeWord](https://github.com/dscripka/openWakeWord) (optional wake word).
