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

echo "[local-voice:setup] done — venv + deps + Kokoro models ready"
