# Local Voice

Fully **local** speech I/O for Agent Garrison — no cloud, no API key. A drop-in
alternative to `deepgram-voice`: it provides the same `kind:voice` capability,
so any channel that consumes voice (the web channel, the Jarvis HUD) works
against it unchanged. `voice` is a singleton, so you station **one** voice
Fitting per composition.

## How it works

```
  channel ──HTTP──▶  local-voice (Node, :7090)  ──HTTP──▶  voice-server (Python)
   /stt /tts          own-port wrapper + status file        Kokoro TTS + faster-whisper STT
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
| `POST` | `/stt` | raw audio bytes (`audio/webm`/`audio/wav`) | `{ transcript, confidence }` (confidence is `null`) |
| `POST` | `/tts` | `{ "text": "...", "format": "wav" }` | `audio/wav` bytes, streamed sentence-by-sentence |

`enginesReady` is `false` while the Python models warm up on first boot
(whisper JITs, ~10s); `/stt` and `/tts` return `503` until ready. The WS
`/stream` incremental-STT endpoint is **not** implemented in v1 — use batch
`/stt` with push-to-talk.

## Setup

`scripts/setup.sh` runs on every `up` (idempotent): creates a Python venv under
`voice-server/.venv`, installs the deps, and fetches the Kokoro model files
(`kokoro-v1.0.onnx` ~325MB + `voices-v1.0.bin` ~28MB) if missing.

- Needs **Python 3.10+** with `curl`/`wget` on PATH. Override the interpreter
  with `LOCAL_VOICE_PYTHON`.
- **Apple Silicon / no CUDA**: uses the CPU `onnxruntime` build (slower than a
  GPU, but fully local). See `voice-server/requirements.txt`.

## Config (env / `config_schema`)

`port`, `bind_host`, `kokoro_voice` (`KOKORO_VOICE`), `kokoro_speed`
(`KOKORO_SPEED`), `whisper_model` (`WHISPER_MODEL`), `wake_word` (`WAKE_WORD`),
`python_bin` (`LOCAL_VOICE_PYTHON`). Wake word is **off** by default in v1
(push-to-talk; without headphones the mic would hear the host's own TTS).

## Provenance

The `voice-server/` (`server.py`, `wakeword.py`) is reused from the Fable
`jarvis-hud` reference project. Only one line of `server.py` was changed —
making the listen port configurable via `VOICE_PY_PORT` so the Node wrapper can
place it on a free internal port. Engines: [Kokoro](https://github.com/thewh1teagle/kokoro-onnx)
(TTS), [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (STT),
[openWakeWord](https://github.com/dscripka/openWakeWord) (optional wake word).
