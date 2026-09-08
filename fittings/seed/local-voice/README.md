# Local Voice

Fully **local, multilingual** speech I/O for Agent Garrison — no cloud, no API
key. It provides the REST `kind:voice` capability as a local alternative to
`capture-service`. Consumers discover the selected provider and its advertised
capabilities. It does not implement capture-service's phone, pendant, screen
capture or incremental STT features. Station one voice Fitting per composition.

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
  channel ──HTTP──▶  local-voice (Node, :8100)  ──HTTP──▶  voice-server (Python)
   /stt /tts          own-port wrapper + status file        faster-whisper STT
                                                            + Kokoro/Piper TTS
```

- **`scripts/server.mjs`** is a thin Node own-port wrapper. It owns the public
  port (default `8100`) and the status file
  (`~/.garrison/ui-fittings/local-voice.json`), and supervises the Python
  voice-server on an internal localhost port. On `down` the Garrison runner
  kills this Node process, which in turn kills the Python child.
- **`voice-server/`** is the speech engine (Kokoro TTS + faster-whisper STT).
  See *Provenance* below.

### Endpoints (Garrison voice contract)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ok, enginesReady, voice, wake }` |
| `POST` | `/stt` | raw audio bytes (`audio/webm`/`audio/wav`) | `{ transcript, confidence, detected_language }` (confidence is `null`; `detected_language` is an ISO-639-1 code) |
| `POST` | `/tts` | `{ "text": "...", "lang": "en" }` | Complete `audio/wav`; optional language pin, otherwise detected from text |

`enginesReady` is `false` while the Python models warm up on first boot
(whisper JITs, ~10s); `/stt` and `/tts` return `503` until ready. The WS
`/stream` incremental-STT endpoint is **not** implemented in v1 — use batch
`/stt` with push-to-talk.

## Setup

`scripts/setup.sh` runs on every `up` (idempotent): creates a Python venv under
`~/.cache/garrison-local-voice/venv` (`LOCAL_VOICE_VENV` override), installs the deps, and fetches missing model files into `~/.cache/garrison-local-voice/models` (`LOCAL_VOICE_MODEL_DIR` override). No venv or model assets are written inside the installed package. Models include
Kokoro (`kokoro-v1.0.onnx` ~325MB + `voices-v1.0.bin` ~28MB) and the Piper
European-Portuguese voice (`piper-voices/pt_PT-tugao-medium.onnx` ~63MB). An explicit `piper_voices: "{}"` disables Piper and its download; blank means the default voice. Custom paths require both the ONNX file and its `.onnx.json` configuration. Whisper downloads its selected checkpoint into the same cache under `whisper/` during first warmup.

- Needs **Python 3.10+** with `curl`/`wget` on PATH. Override the interpreter
  with `LOCAL_VOICE_PYTHON`.
- **Apple Silicon / no CUDA**: uses the CPU `onnxruntime` build (slower than a
  GPU, but fully local). See `voice-server/requirements.txt`.
- **Optional — `espeak-ng`** (`brew install espeak-ng`): Kokoro synthesizes
  PT/FR/ES/IT without it via its bundled grapheme-to-phoneme, but installing
  `espeak-ng` improves non-English pronunciation. Not required.

### Converting a Hugging Face fine-tune to ggml

`setup.sh` only fetches **stock** whisper.cpp checkpoints (`ggml-large-v3.bin`,
`ggml-small.en.bin`, …), because those are the only ones published upstream. Point
`whisper_cpp_model` at anything else — as the `jarvis` composition does with the
European-Portuguese `ggml-WhisperLv3-FT-EP-f16.bin` — and setup fails loud rather
than fetching stock weights under the fine-tune's name. Build it once:

```bash
# 1. The fine-tune (safetensors, ~6.2GB F32). Do this on a box with ≳16GB RAM —
#    the conversion loads the whole model, which an 8GB Mac will swap through.
git clone https://huggingface.co/inesc-id/WhisperLv3-FT-EP-CPP

# 2. INESC ships only config.json + safetensors, but the converter also reads the
#    tokenizer. Take it from the base model — the fine-tune doesn't change it
#    (both are large-v3: d_model 1280, vocab_size 51866).
cd WhisperLv3-FT-EP-CPP
for f in vocab.json added_tokens.json merges.txt; do
  curl -fsSLO "https://huggingface.co/openai/whisper-large-v3/resolve/main/$f"
done
cd ..

# 3. Convert. Needs torch + transformers, and openai/whisper for its mel filters.
git clone https://github.com/openai/whisper
git clone https://github.com/ggml-org/whisper.cpp
python whisper.cpp/models/convert-h5-to-ggml.py ./WhisperLv3-FT-EP-CPP ./whisper ./out

# 4. Install under the name the composition expects.
mv out/ggml-model.bin ~/.cache/whisper-cpp/ggml-WhisperLv3-FT-EP-f16.bin
```

Keep a copy off the host. This file is **not reproducible from this repo alone**,
and re-deriving it costs a multi-GB download plus the conversion.

### Limits and lifecycle

`/health.voice` advertises `stt`, `tts`, `restEnabled`, `maxTextChars: 900`,
`ttsFormat: "wav"`, `stream: false`, and `wakeEvents`. Availability remains false
until the Python models finish warmup. Wake events require a configured,
working wake listener; no host microphone is opened by default.

STT accepts at most 25 MiB and 120 seconds of decoded audio. TTS rejects text
above 900 Unicode characters with `413`; it never silently truncates. Consumers
split long replies at sentence or word boundaries using `maxTextChars`.
Synthesis returns a bounded complete WAV with valid lengths and checks for
non-silent samples before success. Busy workers return `429`. Both HTTP engine
requests have a 120-second deadline and bounded responses. The wrapper cancels
its upstream connection when the browser disconnects. Native inference already
running finishes under its worker gate, preventing a new request from piling
another job onto that engine.

Browser HTTP and WebSocket origins must match the incoming Host, including
port. Native loopback callers need no token; off-box callers require the
optional `LOCAL_VOICE_AUTH_TOKEN`. The status record belongs to the publishing
PID/startup id. Shutdown waits for the Python child (TERM then KILL if needed)
before removing its record. Python watches the supplied Node PID before heavy
imports and reaps its own whisper.cpp child if the parent disappears.

The microphone-free acceptance fixture uses Kokoro with `tiny.en`, Piper and
wake disabled. It checks non-silent WAV samples, exact synthetic transcription,
901-character rejection and malformed-audio rejection. This is file-based
speech evidence, not a microphone or multilingual accuracy claim.

## Config (env / `config_schema`)

Garrison projects composition config into the spawn env as
`GARRISON_LOCALVOICE_<KEY>` (fitting id without separators, key upper-cased) —
`port` → `GARRISON_LOCALVOICE_PORT`, `whisper_model` →
`GARRISON_LOCALVOICE_WHISPER_MODEL`, and so on for every `config_schema` key.
Bare names (`WHISPER_MODEL`, `KOKORO_VOICE`, …) are the PYTHON voice-server's
own env contract; the Node wrapper translates config into them when it spawns
the child. Host env keeps its own names: `LOCAL_VOICE_PYTHON` (setup
interpreter), `LOCAL_VOICE_VENV`, `LOCAL_VOICE_MODEL_DIR`, `LOCAL_VOICE_AUTH_TOKEN`, `GARRISON_HOME`.

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
TTS engine so Portuguese gets a native European (pt_PT) voice Kokoro lacks; (4) bounded REST processing, external caches and early process supervision.
Engines: [Piper](https://github.com/OHF-Voice/piper1-gpl) (pt_PT TTS),
[Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
(TTS), [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (STT),
[openWakeWord](https://github.com/dscripka/openWakeWord) (optional wake word).
