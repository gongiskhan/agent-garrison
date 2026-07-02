"""
Jarvis local voice — Kokoro-82M TTS + faster-whisper STT behind FastAPI
on :3108.

The standalone voice process the handoff reserved (Next API routes stay
stateless; this holds the warm models). lib/tts.ts and lib/stt.ts
auto-detect it via /health and fall back to ElevenLabs when it's not
running.

GET  /health         -> {"ok": true, "voice": "...", "stt": {...}}
GET  /speak?text=... -> audio/wav, streamed sentence-by-sentence so the
                        browser starts playback after the FIRST sentence
                        is generated, not the whole reply.
POST /stt            -> raw audio body (webm/opus/wav) -> {"text": "..."}
                        faster-whisper on CUDA (RTX 5090, ~100ms warm),
                        CPU int8 if CUDA init fails.

Run: .venv\\Scripts\\python.exe server.py   (or start-voice-server.vbs)
"""

import asyncio
import atexit
import glob
import io
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
from typing import Optional

# ctranslate2 (faster-whisper) needs cuDNN/cuBLAS DLLs from the pip
# nvidia-* wheels on the DLL search path BEFORE import. Windows-only API —
# Mac/Linux skip this entirely (CPU or CoreML there).
if hasattr(os, "add_dll_directory"):
    for _d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
        os.add_dll_directory(_d)
        os.environ["PATH"] = _d + os.pathsep + os.environ["PATH"]

import httpx
import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from kokoro_onnx import Kokoro

from eot import score_eot
from wakeword import WakeListener, WAKE_MODEL

HERE = os.path.dirname(os.path.abspath(__file__))
# Garrison adaptation: the Node own-port wrapper (scripts/server.mjs) picks a
# free internal port and passes it via VOICE_PY_PORT; defaults to the Fable
# canonical 3108 when run standalone. Only line changed in this Fable file.
PORT = int(os.environ.get("VOICE_PY_PORT", "3108"))
VOICE = os.environ.get("KOKORO_VOICE", "bm_george")  # calm British male (en fallback)
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
SAMPLE_RATE = 24000  # kokoro output rate
# Multilingual by default: the plain `small` checkpoint auto-detects the spoken
# language (PT/FR/EN/…). `small.en` is English-only — set WHISPER_MODEL back to
# it only if you never speak anything but English.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
# Optional initial_prompt to bias vocabulary (e.g. domain acronyms). EMPTY by
# default: an English prompt skews whisper's language auto-detection toward
# English, which would defeat the multilingual goal. Set WHISPER_PROMPT only on
# an English-pinned deployment.
WHISPER_PROMPT = os.environ.get("WHISPER_PROMPT", "").strip()
# Optional hard language pin (ISO-639-1, e.g. "pt"). EMPTY = auto-detect. On
# short utterances whisper's auto-detect can flip to a wrong language (PT heard
# as EN), which then makes the model reply in that language; pinning fixes both
# the transcript and the reply language for a known single-language speaker.
WHISPER_LANG = os.environ.get("WHISPER_LANG", "").strip()
# Decoding beam width. 1 = greedy (fastest, lower accuracy). Greedy badly
# mistranscribes European Portuguese even on clean audio ("que horas são em
# Lisboa" -> "então é só uma luz boa"); beam search recovers it. 5 is the
# accuracy/latency sweet spot on CPU. Tune down only if decode latency hurts.
WHISPER_BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
# STT engine. "faster-whisper" (CTranslate2, CPU int8 on this Mac — slow) or
# "whisper-cpp" (whisper.cpp via a supervised whisper-server on the Apple GPU
# through Metal — ~3-5x faster, same large-v3 weights so same accuracy). When
# whisper-cpp is selected we spawn whisper-server as a child, decode the inbound
# audio to 16k PCM here, and POST it to that server's /inference; the
# faster-whisper model is then not loaded at all. Defined here (before the model
# load) because the load path branches on it.
STT_ENGINE = os.environ.get("STT_ENGINE", "faster-whisper").strip().lower()
USE_WHISPER_CPP = STT_ENGINE in ("whisper-cpp", "whispercpp", "cpp")
WHISPER_CPP_BIN = os.environ.get("WHISPER_CPP_BIN", "whisper-server")
# expanduser wraps the whole lookup so a `~` in the env value (e.g. from a
# composition config `whisper_cpp_model: ~/.cache/...`) is expanded too — not
# only the default. A literal `~` reaches here otherwise and the model isn't found.
WHISPER_CPP_MODEL = os.path.expanduser(os.environ.get(
    "WHISPER_CPP_MODEL",
    "~/.cache/whisper-cpp/ggml-large-v3.bin",
))
# Silero VAD model for whisper.cpp. When present, whisper-server runs VAD to strip
# non-speech before decoding — kills trailing-silence hallucinations (a stray
# "Obrigado." at the end) at ~no latency cost (it skips silence). Empty/missing =
# VAD off. speech-pad keeps word onsets from being clipped.
WHISPER_CPP_VAD_MODEL = os.path.expanduser(os.environ.get(
    "WHISPER_CPP_VAD_MODEL",
    "~/.cache/whisper-cpp/ggml-silero-vad.bin",
))
_whisper_cpp_proc = None
_whisper_cpp_port = None
_whisper_cpp_log = None  # open file handle for the whisper-server child's log

# --- multilingual TTS voice routing ---------------------------------------
# The spoken voice is chosen from the language of the RESPONSE TEXT (detected
# locally with lingua, ~ms) — not from what was heard — so the voice matches
# what Claude actually wrote ("heard PT, asked for the answer in EN" → EN voice).
# Map: ISO-639-1 → { voice: Kokoro voice id, klang: Kokoro lang code }.
# All five pairs below are verified to synthesize on this host. FR ships only a
# female voice (ff_siwis) in Kokoro v1.0 — the voice changing with the language
# is an accepted consequence (see the brief). Override the whole map via the
# LANG_VOICES env var (JSON), e.g. {"pt":{"voice":"pf_dora","klang":"pt-br"}}.
DEFAULT_LANG_VOICES = {
    "en": {"voice": VOICE, "klang": "en-gb"},
    "pt": {"voice": "pm_alex", "klang": "pt-br"},
    "fr": {"voice": "ff_siwis", "klang": "fr-fr"},
    "es": {"voice": "em_alex", "klang": "es"},
    "it": {"voice": "im_nicola", "klang": "it"},
}
try:
    _override = json.loads(os.environ.get("LANG_VOICES", "") or "{}")
    LANG_VOICES = {**DEFAULT_LANG_VOICES, **_override}
except Exception as e:  # malformed env JSON must not take voice down
    print(f"bad LANG_VOICES json ({e}); using defaults")
    LANG_VOICES = dict(DEFAULT_LANG_VOICES)
# Voice used when text-language detection is unsure (short replies) or returns a
# language we have no voice for.
DEFAULT_TTS_LANG = os.environ.get("TTS_DEFAULT_LANG", "en")
if DEFAULT_TTS_LANG not in LANG_VOICES:
    DEFAULT_TTS_LANG = next(iter(LANG_VOICES))
# Optional hard voice pin (ISO-639-1). EMPTY = detect per-reply. lingua confuses
# close languages on short strings (PT scored as IT → Italian voice reading
# Portuguese); a single-language speaker pins this and skips detection entirely.
TTS_FORCE_LANG = os.environ.get("TTS_FORCE_LANG", "").strip().lower()
if TTS_FORCE_LANG and TTS_FORCE_LANG not in LANG_VOICES:
    TTS_FORCE_LANG = ""

# lingua text language ID, constrained to the languages we can actually voice
# (a small candidate set is both faster and more accurate on short strings).
# Built lazily so import cost is paid on the first /speak, not at module load.
_ISO_TO_LINGUA = {
    "en": "ENGLISH", "pt": "PORTUGUESE", "fr": "FRENCH",
    "es": "SPANISH", "it": "ITALIAN", "de": "GERMAN", "nl": "DUTCH",
}
_lang_detector = None


def detect_text_lang(text: str) -> str:
    """ISO-639-1 of `text`, restricted to the LANG_VOICES candidates. Falls back
    to DEFAULT_TTS_LANG when lingua is unsure or unavailable."""
    global _lang_detector
    if TTS_FORCE_LANG:
        return TTS_FORCE_LANG
    if _lang_detector is False:
        return DEFAULT_TTS_LANG
    if _lang_detector is None:
        try:
            from lingua import Language, LanguageDetectorBuilder
            cands = [
                getattr(Language, _ISO_TO_LINGUA[k])
                for k in LANG_VOICES
                if k in _ISO_TO_LINGUA and hasattr(Language, _ISO_TO_LINGUA[k])
            ]
            if len(cands) < 2:  # builder needs ≥2 languages
                _lang_detector = False
                return DEFAULT_TTS_LANG
            _lang_detector = LanguageDetectorBuilder.from_languages(*cands).build()
        except Exception as e:
            print(f"lingua unavailable ({e}); TTS will use {DEFAULT_TTS_LANG}")
            _lang_detector = False
            return DEFAULT_TTS_LANG
    try:
        lang = _lang_detector.detect_language_of(text)
        if lang is not None:
            code = lang.iso_code_639_1.name.lower()
            if code in LANG_VOICES:
                return code
    except Exception:
        pass
    return DEFAULT_TTS_LANG


# --- Piper TTS (native voices Kokoro lacks, e.g. European Portuguese) -------
# Kokoro v1.0 only ships Brazilian pt voices; for a pt_PT (European) speaker that
# sounds non-native. Piper has a pt_PT voice AND is faster (RTF ~0.12 vs ~0.45),
# so for any language with a Piper voice, /tts uses Piper instead of Kokoro.
# Map ISO-639-1 → Piper .onnx path; override via PIPER_VOICES (JSON).
_PIPER_DIR = os.path.join(HERE, "piper-voices")
DEFAULT_PIPER_VOICES = {
    "pt": os.path.join(_PIPER_DIR, "pt_PT-tugao-medium.onnx"),
}
try:
    _pv_override = json.loads(os.environ.get("PIPER_VOICES", "") or "{}")
    PIPER_VOICE_PATHS = {**DEFAULT_PIPER_VOICES, **_pv_override}
except Exception as e:
    print(f"bad PIPER_VOICES json ({e}); using defaults")
    PIPER_VOICE_PATHS = dict(DEFAULT_PIPER_VOICES)

piper_voices = {}  # iso-639-1 -> loaded PiperVoice


def load_piper():
    """Load every Piper voice whose model file is present. A missing model or a
    missing piper-tts package is non-fatal — that language just stays on Kokoro."""
    try:
        from piper import PiperVoice
    except Exception as e:
        print(f"piper-tts unavailable ({e}); all languages stay on Kokoro")
        return
    for code, path in PIPER_VOICE_PATHS.items():
        if path and os.path.exists(path):
            try:
                piper_voices[code] = PiperVoice.load(path)
                print(f"piper voice loaded: {code} <- {os.path.basename(path)}")
            except Exception as e:
                print(f"piper load failed for {code} ({e}); staying on Kokoro for {code}")


app = FastAPI()

def load_kokoro():
    """CUDA via onnxruntime-gpu (~250ms/sentence vs ~1050ms CPU). kokoro-onnx
    picks the provider from ONNX_PROVIDER at init; if CUDA can't actually
    create (missing DLLs etc) onnxruntime silently falls back to CPU inside
    the session, so trust the session's own report, not the env var."""
    model = os.path.join(HERE, "kokoro-v1.0.onnx")
    voices = os.path.join(HERE, "voices-v1.0.bin")
    if os.environ.get("KOKORO_DEVICE", "auto") != "cpu":
        try:
            os.environ["ONNX_PROVIDER"] = "CUDAExecutionProvider"
            k = Kokoro(model, voices)
            if "CUDAExecutionProvider" in k.sess.get_providers():
                return k, "cuda"
        except Exception as e:
            print(f"kokoro cuda failed ({e}); falling back to cpu")
        os.environ.pop("ONNX_PROVIDER", None)
    # NB: CoreML (Apple Silicon) was measured and is NOT faster for this model —
    # the Kokoro graph splits into ~100 CoreML↔CPU partitions and the transfer
    # overhead cancels the gain (slightly slower than pure CPU). Stay on CPU.
    return Kokoro(model, voices), "cpu"

kokoro, KOKORO_DEVICE = load_kokoro()

def load_whisper():
    """CUDA float16 (5090 = ~100ms warm) with CPU int8 fallback so a
    broken CUDA stack degrades to slow-but-working, never to dead."""
    if os.environ.get("WHISPER_DEVICE", "auto") != "cpu":
        try:
            m = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
            return m, "cuda"
        except Exception as e:
            print(f"whisper cuda failed ({e}); falling back to cpu int8")
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8"), "cpu"

def start_whisper_cpp():
    """Spawn whisper-server (whisper.cpp, Metal GPU) as a supervised child and
    return (proc, port). The model stays warm in the child; /stt proxies to it.
    Raises if the binary or model is missing so startup fails loudly rather than
    silently degrading."""
    global _whisper_cpp_proc, _whisper_cpp_port, _whisper_cpp_log
    if not os.path.exists(WHISPER_CPP_MODEL):
        raise RuntimeError(f"whisper-cpp model not found: {WHISPER_CPP_MODEL}")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    _whisper_cpp_port = s.getsockname()[1]
    s.close()
    args = [
        WHISPER_CPP_BIN, "-m", WHISPER_CPP_MODEL,
        "--host", "127.0.0.1", "--port", str(_whisper_cpp_port),
        "-bs", str(WHISPER_BEAM), "-l", (WHISPER_LANG or "auto"),
        "--suppress-nst",  # drop non-speech tokens ([music], blanks) — free
    ]
    if WHISPER_CPP_VAD_MODEL and os.path.exists(WHISPER_CPP_VAD_MODEL):
        args += [
            "--vad", "--vad-model", WHISPER_CPP_VAD_MODEL,
            "--vad-speech-pad-ms", "200",  # protect word onsets from over-trim
        ]
        print(f"whisper.cpp VAD on ({os.path.basename(WHISPER_CPP_VAD_MODEL)})")
    # Capture the child's output to a DEDICATED log file (GARRISON_HOME-aware,
    # the ~/.garrison/logs convention) rather than DEVNULL — otherwise a child
    # that dies during startup or fails to warm gives zero diagnostics. It goes
    # to its own file, not the parent's stdout, because whisper.cpp logs on every
    # inference and would flood the fitting log. Truncated per start so it always
    # reflects the latest attempt; the child keeps writing through its own fd dup.
    _garrison_home = os.environ.get("GARRISON_HOME", "").strip() or os.path.expanduser("~/.garrison")
    log_path = os.path.join(_garrison_home, "logs", "whisper-server.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    _whisper_cpp_log = open(log_path, "w")
    _whisper_cpp_proc = subprocess.Popen(
        args, stdout=_whisper_cpp_log, stderr=subprocess.STDOUT
    )
    atexit.register(lambda: _whisper_cpp_proc and _whisper_cpp_proc.terminate())
    # Wait until the HTTP port answers (model load + Metal init).
    base = f"http://127.0.0.1:{_whisper_cpp_port}"
    for _ in range(120):
        if _whisper_cpp_proc.poll() is not None:
            raise RuntimeError(f"whisper-server exited during startup (see {log_path})")
        try:
            httpx.get(base + "/", timeout=1.0)
            print(f"whisper.cpp server warm on {base} (model={WHISPER_CPP_MODEL}, log={log_path})")
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"whisper-server did not become ready in time (see {log_path})")


def transcribe_cpp(audio_f32):
    """float32 mono 16k -> text via the warm whisper-server (Metal)."""
    buf = io.BytesIO()
    sf.write(buf, audio_f32, 16000, format="WAV")
    buf.seek(0)
    data = {"response_format": "json", "temperature": "0"}
    if WHISPER_LANG:
        data["language"] = WHISPER_LANG
    # Vocabulary bias (proper nouns / domain terms the model otherwise mangles,
    # e.g. "Agent Garrison"). Keep WHISPER_PROMPT a COMMA-SEPARATED TERM LIST, not
    # example sentences — full sentences get regurgitated verbatim on unclear
    # audio (learned the hard way with faster-whisper).
    if WHISPER_PROMPT:
        data["prompt"] = WHISPER_PROMPT
    r = httpx.post(
        f"http://127.0.0.1:{_whisper_cpp_port}/inference",
        files={"file": ("audio.wav", buf, "audio/wav")},
        data=data,
        timeout=120,
    )
    r.raise_for_status()
    return (r.json().get("text") or "").strip()


# Load faster-whisper only when it is the active engine — whisper-cpp keeps its
# weights in the whisper-server child, so loading CTranslate2 too would just
# waste RAM and startup time.
if USE_WHISPER_CPP:
    whisper, WHISPER_DEVICE = None, "metal(whisper.cpp)"
else:
    whisper, WHISPER_DEVICE = load_whisper()
load_piper()

# one whisper model, two callers (/stt route + wake-word thread) — serialize
whisper_lock = threading.Lock()


# Optional gain boost for a quiet/soft speaker: peak-normalize to ~0.95 before
# whisper, capped so near-silence/noise isn't blown up, skipping already-loud
# clips. OFF by default: on clean audio it's a no-op at best (whisper's log-mel
# is amplitude-robust) and can shave a word, so it only earns its keep on a real
# low-SNR microphone. Enable + A/B with the actual speaker via STT_NORMALIZE_GAIN=on.
STT_NORMALIZE_GAIN = os.environ.get("STT_NORMALIZE_GAIN", "off").lower() in ("on", "1", "true")
STT_GAIN_CAP = float(os.environ.get("STT_GAIN_CAP", "8.0"))  # ~+18 dB ceiling
# Run whisper's built-in Silero VAD to strip leading/trailing silence and room
# noise from real push-to-talk clips (button-down..button-up always brackets the
# speech with quiet). Real mics hallucinate words out of that non-speech; the VAD
# filter removes it. ON by default now — turn off with STT_VAD_FILTER=off if it
# clips very short utterances.
STT_VAD_FILTER = os.environ.get("STT_VAD_FILTER", "on").lower() in ("on", "1", "true")


def normalize_gain(audio):
    if not STT_NORMALIZE_GAIN or audio is None or audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak < 1e-4:  # silence: leave it (don't amplify noise)
        return audio
    gain = min(0.95 / peak, STT_GAIN_CAP)
    if gain <= 1.0:  # already loud enough
        return audio
    return (audio * gain).astype(np.float32)


def transcribe_pcm(audio_f32):
    """float32 mono 16k -> text. Shared by the wake-word capture path. Language
    is auto-detected (no `language=` hint) so non-English speech transcribes."""
    audio_f32 = normalize_gain(audio_f32)
    if USE_WHISPER_CPP:
        return transcribe_cpp(audio_f32)
    with whisper_lock:
        segments, _info = whisper.transcribe(
            audio_f32, beam_size=WHISPER_BEAM, vad_filter=STT_VAD_FILTER,
            initial_prompt=WHISPER_PROMPT or None,
            language=WHISPER_LANG or None,
        )
        # segments is a lazy generator — consume INSIDE the lock or the
        # actual decode runs unguarded
        return " ".join(s.text.strip() for s in segments).strip()


# --- P4: wake word + HUD event stream -------------------------------------
# The HUD connects to ws://:3108/events. The wake thread emits through
# emit_event() which hops onto the uvicorn event loop thread-safely.

WAKE_ENABLED = os.environ.get("WAKE_WORD", "on").lower() not in ("off", "0", "false")
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))

ws_clients: set = set()
main_loop = None


def emit_event(payload: dict):
    if main_loop is None:
        return
    msg = json.dumps(payload)

    async def _send():
        for ws in list(ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                ws_clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), main_loop)


wake = WakeListener(emit_event, threshold=WAKE_THRESHOLD) if WAKE_ENABLED else None


@app.websocket("/events")
async def events(ws: WebSocket):
    await ws.accept()
    # hello tells the HUD whether hands-free is actually armed — the client
    # can't read /health cross-origin, and "wake word armed" must not lie
    await ws.send_text(json.dumps({"type": "hello", "wake": bool(wake and wake.ok)}))
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings — content ignored
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


@app.on_event("startup")
async def _startup():
    global main_loop
    main_loop = asyncio.get_running_loop()
    if USE_WHISPER_CPP:
        start_whisper_cpp()
    if wake is not None:
        wake.start()


def wav_header(sample_rate: int) -> bytes:
    """Streaming WAV header with unknown length (0x7FFFFFFF) — browsers
    play it progressively and stop at end-of-stream."""
    data_size = 0x7FFFFFFF - 36
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
        b"data", data_size,
    )


# --- prosody-aware segmentation -------------------------------------------
# The reply is spoken as a sequence of (segment, trailing-pause) pairs so the
# cadence tracks the punctuation instead of running everything together. A
# stronger boundary → a longer silence: a comma barely ticks, a full stop
# breathes, a paragraph/topic change gets a real beat. Every duration is env-
# tunable (seconds) so the rhythm can be dialed in per voice without code.
def _pause_s(env: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(env, default)))
    except (TypeError, ValueError):
        return default

PAUSE_COMMA = _pause_s("PAUSE_COMMA", 0.12)          # ,
PAUSE_CLAUSE = _pause_s("PAUSE_CLAUSE", 0.22)        # ; :  — –
PAUSE_SENTENCE = _pause_s("PAUSE_SENTENCE", 0.32)    # .
PAUSE_QUESTION = _pause_s("PAUSE_QUESTION", 0.38)    # ! ?
PAUSE_ELLIPSIS = _pause_s("PAUSE_ELLIPSIS", 0.48)    # … / ...
PAUSE_PARA = _pause_s("PAUSE_PARA", 0.60)            # line break / paragraph / topic
# A soft boundary (comma etc.) only becomes its OWN spoken segment once the
# clause before it reaches this many characters. Short clauses ("Sim,",
# "Claro,") stay glued to the next so the voice never chops into staccato
# fragments — the engine's own comma intonation carries those. Longer clauses
# get a real, audible pause. Tune MIN_CLAUSE down for more pauses, up for fewer.
MIN_CLAUSE = int(_pause_s("MIN_CLAUSE", 26.0))

# A boundary is a run of sentence-terminal punctuation (+ trailing quote/bracket),
# OR a clause mark, OR a comma, OR a dash, OR a run of newlines. The text BEFORE
# each boundary (with the punctuation kept, so the engine still intones it) is a
# candidate segment.
_BOUNDARY = re.compile(r"([.!?…]+[)\]\"'”’»]*|[;:]|,|—|–|\n+)")
_SOFT = {",", ";", ":", "—", "–"}


def _gap_for(p: str) -> float:
    """Trailing-silence length (s) for the boundary punctuation `p`."""
    if "\n" in p:
        return PAUSE_PARA
    if "…" in p or p.count(".") >= 3:
        return PAUSE_ELLIPSIS
    if "!" in p or "?" in p:
        return PAUSE_QUESTION
    if "." in p:
        return PAUSE_SENTENCE
    if any(c in p for c in ";:—–"):
        return PAUSE_CLAUSE
    if "," in p:
        return PAUSE_COMMA
    return PAUSE_SENTENCE


# --- spoken-form normalization --------------------------------------------
# Expand abbreviations that TTS otherwise reads letter-by-letter. The big one is
# clock times written "14h" / "14h30": Kokoro/Piper spell the bare "h" as the
# letter name ("catorze agá") instead of saying "horas". Rewrite them to words in
# the RESPONSE language before synthesis. Kept deliberately narrow (the digit+h
# clock form) so ordinary text is never touched.
_TIME_WORDS = {  # lang -> (singular, plural, connector between hours and minutes)
    "pt": ("hora", "horas", "e"),
    "es": ("hora", "horas", "y"),
    "it": ("ora", "ore", "e"),
    "fr": ("heure", "heures", ""),
    "en": ("hour", "hours", "and"),
}
# \b(\d{1,2})[hH](\d{2})?\b — "14h" and "14h30", but NOT "14horas" (the trailing
# \b fails when letters follow the h) nor "100h" (no word-boundary inside digits).
_TIME_H = re.compile(r"\b(\d{1,2})[hH](\d{2})?\b")


def normalize_speech(text: str, lang: str) -> str:
    """Expand clock-time abbreviations ("14h30" → "14 horas e 30") in `lang`."""
    hour_sg, hour_pl, andw = _TIME_WORDS.get(lang, _TIME_WORDS["pt"])

    def _rep(m):
        h = int(m.group(1))
        out = f"{h} {hour_sg if h == 1 else hour_pl}"
        if m.group(2) is not None:
            mins = int(m.group(2))  # int() drops the leading zero: "05" → 5, "00" → 0
            if mins:
                out += f" {andw} {mins}" if andw else f" {mins}"
        return out

    return _TIME_H.sub(_rep, text)


def segments_of(text: str):
    """Split `text` into (synth_text, trailing_gap_seconds). Hard boundaries
    (. ! ? … newline) always break; soft ones (comma/clause/dash) break only
    once the pending clause is long enough (MIN_CLAUSE) so speech isn't choppy.
    Punctuation stays attached to each segment so the engine's own intonation is
    preserved — the inserted silence is added ON TOP of that natural cadence."""
    out, buf, last = [], "", 0
    for m in _BOUNDARY.finditer(text):
        p = m.group(1)
        buf += text[last:m.end()]
        last = m.end()
        if p in _SOFT and len(buf.strip()) < MIN_CLAUSE:
            continue  # too short to stand alone — let the comma ride inline
        seg = buf.strip()
        if seg:
            out.append((seg, _gap_for(p)))
        elif out:
            # boundary carrying no new text (e.g. a paragraph break right after a
            # full stop): upgrade the previous segment's pause to the stronger of
            # the two, so a topic change breathes as a topic change, not a full stop
            g = _gap_for(p)
            if g > out[-1][1]:
                out[-1] = (out[-1][0], g)
        buf = ""
    tail = (buf + text[last:]).strip()
    if tail:
        out.append((tail, PAUSE_SENTENCE))
    return out or [(text.strip(), 0.0)]


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "kokoro",
        "voice": VOICE,
        "device": KOKORO_DEVICE,
        "languages": sorted(set(LANG_VOICES) | set(piper_voices)),
        "lang_voices": {
            **{k: f"kokoro:{v['voice']}" for k, v in LANG_VOICES.items()},
            **{k: f"piper:{k}" for k in piper_voices},  # piper overrides per language
        },
        "piper_languages": sorted(piper_voices.keys()),
        "pauses": {  # seconds of silence inserted after each boundary (env-tunable)
            "comma": PAUSE_COMMA, "clause": PAUSE_CLAUSE, "sentence": PAUSE_SENTENCE,
            "question": PAUSE_QUESTION, "ellipsis": PAUSE_ELLIPSIS, "paragraph": PAUSE_PARA,
            "min_clause": MIN_CLAUSE,
        },
        "stt": {
            "ok": True,
            "engine": STT_ENGINE,
            "model": os.path.basename(WHISPER_CPP_MODEL) if USE_WHISPER_CPP else WHISPER_MODEL,
            "device": WHISPER_DEVICE,
            # `small.en` (or any *.en) is English-only; everything else auto-detects.
            "multilingual": USE_WHISPER_CPP or not WHISPER_MODEL.endswith(".en"),
        },
        "wake": {
            "enabled": WAKE_ENABLED,
            "ok": bool(wake and wake.ok),
            "model": WAKE_MODEL,
            "threshold": WAKE_THRESHOLD,
            "error": wake.error if wake else None,
        },
    }


@app.post("/stt")
async def stt(req: Request):
    audio = await req.body()
    if len(audio) < 1000:
        return Response(status_code=400, content="clip too short")
    t0 = time.time()
    # Debug capture for A/B tuning: dump the raw inbound audio so the SAME real
    # utterance can be replayed through other engines. Gated on STT_DUMP_DIR.
    _dump = os.environ.get("STT_DUMP_DIR", "").strip()
    if _dump:
        try:
            os.makedirs(_dump, exist_ok=True)
            with open(os.path.join(_dump, f"clip_{int(t0 * 1000)}.bin"), "wb") as _f:
                _f.write(audio)
        except Exception:
            pass
    if USE_WHISPER_CPP:
        # whisper.cpp needs PCM/WAV, so always decode here (PyAV handles
        # webm/opus). Boost a quiet speaker, hand to the warm Metal server. Its
        # /inference (json) doesn't report the language, so derive it from the
        # text for the bilingual reply hint.
        try:
            pcm = normalize_gain(decode_audio(io.BytesIO(audio), sampling_rate=16000))
        except Exception:
            return Response(status_code=400, content="could not decode audio")
        text = transcribe_cpp(pcm)
        lang = detect_text_lang(text) if text else DEFAULT_TTS_LANG
        prob = 1.0
    else:
        # Default path hands raw bytes to whisper (PyAV decodes webm/opus/wav
        # internally). Only when gain normalization is enabled do we decode to a
        # float32 array first so we can boost a quiet speaker; on any decode
        # hiccup we fall back to the raw bytes. WHISPER_LANG pins the language;
        # whisper still reports it on `info`, so the spoken language travels with
        # the transcript.
        if STT_NORMALIZE_GAIN:
            try:
                source = normalize_gain(decode_audio(io.BytesIO(audio), sampling_rate=16000))
            except Exception:
                source = io.BytesIO(audio)
        else:
            source = io.BytesIO(audio)
        with whisper_lock:
            segments, info = whisper.transcribe(
                source, beam_size=WHISPER_BEAM, vad_filter=STT_VAD_FILTER,
                initial_prompt=WHISPER_PROMPT or None,
                language=WHISPER_LANG or None,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        lang = info.language
        prob = float(info.language_probability)
    ms = int((time.time() - t0) * 1000)
    # Observability for real-mic tuning: log every transcript with the detected
    # language + confidence so a bad utterance can be diagnosed from the log.
    print(
        f"[stt] {ms}ms engine={STT_ENGINE} lang={lang}({prob:.2f}) "
        f"bytes={len(audio)} vad={STT_VAD_FILTER} gain={STT_NORMALIZE_GAIN} -> {text!r}",
        flush=True,
    )
    return {
        "text": text,
        "ms": ms,
        "language": lang,
        "language_probability": round(prob, 3),
        # End-of-turn probability of the transcript (see eot.py) — the HUD's
        # smart endpointing sizes its grace window from this.
        "eot_prob": round(score_eot(text), 2),
    }


@app.get("/turn")
def turn(text: str = ""):
    """End-of-turn probability for a (partial) transcript — the semantic half
    of smart endpointing, exposed standalone for tuning/tests. The live STT
    path gets the same score inline on /stt (eot_prob), so consumers normally
    never call this."""
    return {"text": text, "eot_prob": round(score_eot(text), 2)}


@app.get("/speak")
def speak(text: str = "", lang: Optional[str] = None):
    text = text.strip()[:900]
    if not text:
        return Response(status_code=400, content="empty text")

    # Pick the voice from the response text's language (local, ~ms). A caller
    # may override by passing ?lang=pt to force a specific voice.
    known = set(LANG_VOICES) | set(piper_voices)
    code = lang.lower() if (lang and lang.lower() in known) else detect_text_lang(text)

    # Expand clock times ("14h" → "14 horas") so they aren't read letter-by-letter.
    text = normalize_speech(text, code)

    # Piper wins for any language it has a voice for (native accent + faster);
    # otherwise fall back to Kokoro. The sample rate differs per engine, so it's
    # fixed for this whole response (one call = one language = one engine).
    pvoice = piper_voices.get(code)
    if pvoice is not None:
        out_sr = pvoice.config.sample_rate
        engine, voice_label = "piper", code
    else:
        vmap = LANG_VOICES.get(code, LANG_VOICES[DEFAULT_TTS_LANG])
        voice, klang = vmap["voice"], vmap["klang"]
        out_sr = SAMPLE_RATE
        engine, voice_label = "kokoro", voice

    def gen():
        yield wav_header(out_sr)
        for seg, gap in segments_of(text):
            if pvoice is not None:
                for audio in pvoice.synthesize(seg):
                    yield audio.audio_int16_bytes
            else:
                samples, sr = kokoro.create(seg, voice=voice, speed=SPEED, lang=klang)
                pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
                yield pcm.tobytes()
            # variable breath sized to the boundary strength (comma < sentence <
            # paragraph) so topic changes and clauses read distinctly, not corrido
            if gap > 0:
                yield b"\x00" * (int(out_sr * gap) * 2)

    # Surface the chosen engine/voice/language for logging on the consumer side.
    return StreamingResponse(gen(), media_type="audio/wav",
                             headers={"Cache-Control": "no-store",
                                      "X-Voice-Lang": code, "X-Voice": f"{engine}:{voice_label}"})


if __name__ == "__main__":
    # warm both models so the first real request doesn't pay init cost —
    # whisper's first CUDA run JITs kernels (~9s); feed it kokoro's warmup
    # audio so the whole pipeline is hot
    samples, _ = kokoro.create("Systems online.", voice=VOICE, speed=SPEED, lang="en-gb")
    warm = io.BytesIO()
    import soundfile as sf
    sf.write(warm, samples, SAMPLE_RATE, format="WAV")
    warm.seek(0)
    if not USE_WHISPER_CPP:
        list(whisper.transcribe(warm, beam_size=1)[0])  # warm the auto-detect path
    detect_text_lang("warmup")  # build the lingua detector before first /speak
    for _pv in piper_voices.values():  # warm each Piper voice's onnx graph
        try:
            list(_pv.synthesize("Olá."))
        except Exception:
            pass
    print(f"kokoro({KOKORO_DEVICE}) + whisper({WHISPER_MODEL}/{WHISPER_DEVICE}) "
          f"warm — serving :{PORT} langs={sorted(LANG_VOICES)} default={DEFAULT_TTS_LANG}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
