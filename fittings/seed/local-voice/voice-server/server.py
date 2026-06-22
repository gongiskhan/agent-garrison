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
import glob
import io
import json
import os
import re
import struct
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

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from kokoro_onnx import Kokoro

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
    with whisper_lock:
        segments, _info = whisper.transcribe(
            audio_f32, beam_size=1, vad_filter=False,
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


wake = WakeListener(transcribe_pcm, emit_event, threshold=WAKE_THRESHOLD) if WAKE_ENABLED else None


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


SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def chunks_of(text: str):
    """First sentence ships alone so playback starts ASAP; the rest glue
    into >=60-char chunks so tiny fragments don't chop the prosody."""
    parts = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()]
    if not parts:
        return [text]
    out, cur = [parts[0]], ""
    for p in parts[1:]:
        cur = f"{cur} {p}".strip()
        if len(cur) >= 60:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


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
        "stt": {
            "ok": True,
            "model": WHISPER_MODEL,
            "device": WHISPER_DEVICE,
            # `small.en` (or any *.en) is English-only; everything else auto-detects.
            "multilingual": not WHISPER_MODEL.endswith(".en"),
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
    # Default path hands raw bytes to whisper (PyAV decodes webm/opus/wav
    # internally) — byte-identical to before. Only when gain normalization is
    # enabled do we decode to a float32 array first so we can boost a quiet
    # speaker; on any decode hiccup we fall back to the raw bytes.
    if STT_NORMALIZE_GAIN:
        try:
            source = normalize_gain(decode_audio(io.BytesIO(audio), sampling_rate=16000))
        except Exception:
            source = io.BytesIO(audio)
    else:
        source = io.BytesIO(audio)
    # WHISPER_LANG pins the language; whisper still reports it on `info`, so the
    # spoken language travels with the transcript.
    with whisper_lock:
        segments, info = whisper.transcribe(
            source, beam_size=1, vad_filter=False,
            initial_prompt=WHISPER_PROMPT or None,
            language=WHISPER_LANG or None,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {
        "text": text,
        "ms": int((time.time() - t0) * 1000),
        "language": info.language,
        "language_probability": round(float(info.language_probability), 3),
    }


@app.get("/speak")
def speak(text: str = "", lang: Optional[str] = None):
    text = text.strip()[:900]
    if not text:
        return Response(status_code=400, content="empty text")

    # Pick the voice from the response text's language (local, ~ms). A caller
    # may override by passing ?lang=pt to force a specific voice.
    known = set(LANG_VOICES) | set(piper_voices)
    code = lang.lower() if (lang and lang.lower() in known) else detect_text_lang(text)

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
        for chunk in chunks_of(text):
            if pvoice is not None:
                for audio in pvoice.synthesize(chunk):
                    yield audio.audio_int16_bytes
            else:
                samples, sr = kokoro.create(chunk, voice=voice, speed=SPEED, lang=klang)
                pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
                yield pcm.tobytes()
            # short breath between sentences
            yield b"\x00" * int(out_sr * 0.12) * 2

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
