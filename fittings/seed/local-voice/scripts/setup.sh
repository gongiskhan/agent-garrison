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
# venv lives OUTSIDE the package tree: apm install deep-copies the fitting and
# hard-fails on any symlink escaping the package root (the venv python is such a
# symlink). Default to a stable per-user cache; override with LOCAL_VOICE_VENV.
VENV="${LOCAL_VOICE_VENV:-$HOME/.cache/garrison-local-voice/venv}"
PY="${LOCAL_VOICE_PYTHON:-python3}"

KOKORO_ONNX="$VS/kokoro-v1.0.onnx"
KOKORO_VOICES="$VS/voices-v1.0.bin"
REL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

echo "[local-voice:setup] using interpreter: $PY"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[local-voice:setup] ERROR: '$PY' not found. Install Python 3.10+ (or set LOCAL_VOICE_PYTHON)." >&2
  exit 1
fi
# Check the version here, not just that the binary exists. On 3.9 (still the
# macOS system python3) the deps below have no valid resolution and pip dies 40
# lines later with a bare "ResolutionImpossible" naming kokoro-onnx — which says
# nothing about the real cause.
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  PY_VER="$("$PY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo "unknown")"
  echo "[local-voice:setup] ERROR: '$PY' is Python $PY_VER; the voice-server deps need 3.10+." >&2
  echo "[local-voice:setup]   Point LOCAL_VOICE_PYTHON at a newer interpreter, e.g." >&2
  echo "[local-voice:setup]     LOCAL_VOICE_PYTHON=\"\$(uv python find 3.12)\"" >&2
  exit 1
fi

# 1. venv
if [ ! -x "$VENV/bin/python" ]; then
  echo "[local-voice:setup] creating venv at $VENV"
  mkdir -p "$(dirname "$VENV")"
  "$PY" -m venv "$VENV"
fi
VPY="$VENV/bin/python"

# 2. deps (CPU build — see requirements.txt; Apple Silicon / no CUDA)
echo "[local-voice:setup] installing Python deps (this can take a few minutes)"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet -r "$VS/requirements.txt"

# Expand a leading "~/" in a config-supplied path. Composition config reaches us
# as a variable value, and the shell does NOT expand ~ there — so "~/.cache/x"
# stays literal and every -f test against it fails. Only the leading ~/ form is
# handled; that is the only shape apm.yml uses.
expand_tilde() {
  case "$1" in
    "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    "~")   printf '%s' "$HOME" ;;
    *)     printf '%s' "$1" ;;
  esac
}

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
#    model. Skipped entirely when the engine is the default faster-whisper.
#
# Composition config reaches a SETUP hook as LOCAL_VOICE_<KEY> (setupConfigEnv in
# src/lib/runner.ts prefixes with the fitting id) — NOT as the bare name, and not
# as the GARRISON_LOCALVOICE_<KEY> form the running server gets from
# ownPortConfigEnv. Reading the bare name here meant `stt_engine: whisper-cpp`
# and `wake_word: on` never reached setup at all: no ggml model was ever fetched
# and openWakeWord was never installed. The bare name is kept as a fallback only
# so a hand-run `bash scripts/setup.sh` still works.
STT_ENGINE_LC="$(printf '%s' "${LOCAL_VOICE_STT_ENGINE:-${STT_ENGINE:-faster-whisper}}" | tr '[:upper:]' '[:lower:]')"
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
  WCPP_MODEL="$(expand_tilde "${LOCAL_VOICE_WHISPER_CPP_MODEL:-${WHISPER_CPP_MODEL:-$HOME/.cache/whisper-cpp/ggml-large-v3.bin}}")"
  mkdir -p "$(dirname "$WCPP_MODEL")"
  # Derive the URL from the configured filename. Only stock ggerganov checkpoints
  # exist upstream; a fine-tune (ggml-WhisperLv3-FT-EP-f16.bin) has no ggml build
  # to fetch, and pulling large-v3 into its name would silently swap the weights —
  # no error, just 50.8% WER where the fine-tune measures 25.6%. Fail loud instead.
  WCPP_NAME="$(basename "$WCPP_MODEL")"
  case "$WCPP_NAME" in
    ggml-tiny*.bin|ggml-base*.bin|ggml-small*.bin|ggml-medium*.bin|ggml-large-v[123]*.bin)
      fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WCPP_NAME" "$WCPP_MODEL"
      ;;
    *)
      if [ ! -f "$WCPP_MODEL" ]; then
        echo "[local-voice:setup] ERROR: '$WCPP_NAME' is not a stock whisper.cpp checkpoint," >&2
        echo "[local-voice:setup]   and there is nothing upstream to fetch it from. Convert it" >&2
        echo "[local-voice:setup]   and place it at: $WCPP_MODEL" >&2
        echo "[local-voice:setup]   See README.md → 'Converting a Hugging Face fine-tune to ggml'." >&2
        exit 1
      fi
      echo "[local-voice:setup] present: $WCPP_NAME (local fine-tune — nothing to fetch)"
      ;;
  esac
  # Silero VAD model (~885KB) — strips non-speech so whisper doesn't hallucinate
  # a trailing word into end-of-clip silence. Note the repo: ggml-org/whisper-vad
  # (the whisper.cpp repo path 404s for this file).
  WCPP_VAD="$(expand_tilde "${WHISPER_CPP_VAD_MODEL:-$HOME/.cache/whisper-cpp/ggml-silero-vad.bin}")"
  fetch "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" "$WCPP_VAD"
  echo "[local-voice:setup] whisper-cpp ready ($(whisper-server --help >/dev/null 2>&1 && echo binary-ok))"
fi

# 6. Wake word "hey jarvis" (openWakeWord, fully local) — only when enabled.
#    --no-deps: openwakeword's pinned deps drag in tflite; we run the ONNX path
#    on the onnxruntime already in the venv, and add just what it imports.
#    Models (~7MB: melspec + embedding + hey_jarvis, ONNX) land in
#    site-packages/openwakeword/resources/models; skipped once present.
WAKE_LC="$(printf '%s' "${LOCAL_VOICE_WAKE_WORD:-${WAKE_WORD:-off}}" | tr '[:upper:]' '[:lower:]')"
if [ "$WAKE_LC" = "on" ] || [ "$WAKE_LC" = "1" ] || [ "$WAKE_LC" = "true" ]; then
  echo "[local-voice:setup] wake word on — ensuring openWakeWord + hey_jarvis model"
  "$VPY" -m pip install --quiet --no-deps openwakeword
  "$VPY" -m pip install --quiet sounddevice scipy scikit-learn tqdm requests
  "$VPY" - <<'PYEOF'
import os
import openwakeword
from openwakeword import utils

base = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
if os.path.exists(os.path.join(base, "hey_jarvis_v0.1.onnx")):
    print("[local-voice:setup] wake model present")
else:
    utils.download_models(["hey_jarvis_v0.1"])
    print("[local-voice:setup] wake model downloaded")
PYEOF
fi

echo "[local-voice:setup] done — venv + deps + Kokoro + Piper(pt_PT) models ready"
