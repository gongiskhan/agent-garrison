#!/usr/bin/env bash
# Local Voice setup hook — runs from the installed Fitting dir on every `up`,
# before verify. Side-effecting prep only (CLAUDE.md setup-vs-verify):
#   1. create a Python venv under voice-server/.venv
#   2. install the voice-server deps (Kokoro TTS + faster-whisper STT)
#   3. fetch the Kokoro model + voices into voice-server/ if missing
# Idempotent: each step is skipped when already satisfied. Fails loud (non-zero
# exit aborts `up`) so a half-built voice stack never looks healthy.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VS="$HERE/../voice-server"
VENV="$VS/.venv"
PY="${LOCAL_VOICE_PYTHON:-python3}"

KOKORO_ONNX="$VS/kokoro-v1.0.onnx"
KOKORO_VOICES="$VS/voices-v1.0.bin"
REL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

echo "[local-voice:setup] using interpreter: $PY"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[local-voice:setup] ERROR: '$PY' not found. Install Python 3.10+ (or set LOCAL_VOICE_PYTHON)." >&2
  exit 1
fi

# 1. venv
if [ ! -x "$VENV/bin/python" ]; then
  echo "[local-voice:setup] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

# 2. deps (CPU build — see requirements.txt; Apple Silicon / no CUDA)
echo "[local-voice:setup] installing Python deps (this can take a few minutes)"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r "$VS/requirements.txt"

# 3. Kokoro model files (~325MB + ~28MB) — only fetch when missing
fetch() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then
    echo "[local-voice:setup] present: $(basename "$out")"
    return 0
  fi
  echo "[local-voice:setup] downloading $(basename "$out") ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$out.partial" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out.partial" "$url"
  else
    echo "[local-voice:setup] ERROR: need curl or wget to fetch models." >&2
    exit 1
  fi
  mv "$out.partial" "$out"
}
fetch "$REL/kokoro-v1.0.onnx" "$KOKORO_ONNX"
fetch "$REL/voices-v1.0.bin"  "$KOKORO_VOICES"

# 4. Piper voices (native accents Kokoro lacks). pt_PT = European Portuguese
#    (~63MB .onnx + small .json), fetched from rhasspy/piper-voices on HF.
PIPER_DIR="$VS/piper-voices"
mkdir -p "$PIPER_DIR"
PIPER_PT_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_PT/tug%C3%A3o/medium"
fetch "$PIPER_PT_BASE/pt_PT-tug%C3%A3o-medium.onnx"      "$PIPER_DIR/pt_PT-tugao-medium.onnx"
fetch "$PIPER_PT_BASE/pt_PT-tug%C3%A3o-medium.onnx.json" "$PIPER_DIR/pt_PT-tugao-medium.onnx.json"

# 5. whisper.cpp (Metal GPU STT) — only when selected as the STT engine. Runs
#    large-v3 on the Apple GPU via a supervised whisper-server, ~3x faster than
#    faster-whisper's CPU path. Needs the `whisper-server` binary + the ggml
#    model. Skipped entirely when STT_ENGINE is the default faster-whisper.
STT_ENGINE_LC="$(printf '%s' "${STT_ENGINE:-faster-whisper}" | tr '[:upper:]' '[:lower:]')"
if [ "$STT_ENGINE_LC" = "whisper-cpp" ] || [ "$STT_ENGINE_LC" = "whispercpp" ] || [ "$STT_ENGINE_LC" = "cpp" ]; then
  echo "[local-voice:setup] STT engine = whisper-cpp — ensuring whisper-server + model"
  if ! command -v whisper-server >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      echo "[local-voice:setup] installing whisper-cpp via brew (Metal-enabled)"
      brew install whisper-cpp
    else
      echo "[local-voice:setup] ERROR: whisper-server not found and no brew to install it." >&2
      echo "[local-voice:setup]   Install whisper.cpp (with Metal) or set stt_engine back to faster-whisper." >&2
      exit 1
    fi
  fi
  WCPP_MODEL="${WHISPER_CPP_MODEL:-$HOME/.cache/whisper-cpp/ggml-large-v3.bin}"
  mkdir -p "$(dirname "$WCPP_MODEL")"
  fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin" "$WCPP_MODEL"
  # Silero VAD model (~885KB) — strips non-speech so whisper doesn't hallucinate
  # a trailing word into end-of-clip silence. Note the repo: ggml-org/whisper-vad
  # (the whisper.cpp repo path 404s for this file).
  WCPP_VAD="${WHISPER_CPP_VAD_MODEL:-$HOME/.cache/whisper-cpp/ggml-silero-vad.bin}"
  fetch "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" "$WCPP_VAD"
  echo "[local-voice:setup] whisper-cpp ready ($(whisper-server --help >/dev/null 2>&1 && echo binary-ok))"
fi

echo "[local-voice:setup] done — venv + deps + Kokoro + Piper(pt_PT) models ready"
