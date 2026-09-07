"""
Wake-word listener — openWakeWord "hey jarvis" on the default mic. EMIT-ONLY.

Chosen over Porcupine (the original P4 plan) because Porcupine requires a
Picovoice account + access key; openWakeWord ships a pretrained hey-jarvis
ONNX model and rides the onnxruntime already in this venv. Fully local,
zero keys. Models land in site-packages/openwakeword/resources/models via
scripts/setup.sh (gated on WAKE_WORD=on).

Design: on detection this emits {"type":"wake"} over the /events WebSocket —
and NOTHING else. The old capture-and-STT path is gone: the HUD owns the
microphone conversation (browser VAD + smart endpointing + barge-in), so a
second server-side endpointer would race it and double-transcribe. Standby is
therefore genuinely cheap: one 1.3MB ONNX model on 80ms frames, no whisper.

The HUD listens on /events (proxied by the Node wrapper): "wake" while the
session is off arms hands-free listening; while a session is on it is ignored,
and since standby never plays TTS, Jarvis cannot wake itself.

Runs as a daemon thread inside server.py:
  mic (16k mono int16, 80ms frames) -> openwakeword predict
  score >= threshold (default 0.5) -> emit {"type":"wake","score":...}
  -> cooldown so one utterance fires once.
"""

import threading
import time

SR = 16000
FRAME = 1280  # 80ms @ 16k — the frame size openwakeword expects per predict()
WAKE_MODEL = "hey_jarvis_v0.1"
COOLDOWN_S = 3.0  # one "hey jarvis" = one wake event, even if scores linger


class WakeListener:
    def __init__(self, emit, threshold=0.5):
        """emit(dict) must be thread-safe (see server.py emit_event)."""
        self.emit = emit
        self.threshold = threshold
        self.ok = False
        self.error = None
        self._thread = threading.Thread(target=self._run, daemon=True, name="wake-listener")

    def start(self):
        self._thread.start()

    def _run(self):
        try:
            import sounddevice as sd
            from openwakeword.model import Model

            model = Model(wakeword_models=[WAKE_MODEL], inference_framework="onnx")
        except Exception as e:  # missing mic/deps/models — report via /health, never crash the server
            self.error = f"{type(e).__name__}: {e}"
            print(f"wake word disabled: {self.error}")
            return

        try:
            with sd.InputStream(
                samplerate=SR, channels=1, dtype="int16", blocksize=FRAME
            ) as stream:
                self.ok = True
                print(f"wake word armed — '{WAKE_MODEL}' threshold={self.threshold}")
                last_fire = 0.0
                while True:
                    frame, _overflowed = stream.read(FRAME)
                    score = float(model.predict(frame[:, 0])[WAKE_MODEL])
                    if score >= self.threshold and time.time() - last_fire > COOLDOWN_S:
                        self.emit({"type": "wake", "score": round(score, 3)})
                        model.reset()
                        last_fire = time.time()
        except Exception as e:
            self.ok = False
            self.error = f"{type(e).__name__}: {e}"
            print(f"wake listener died: {self.error}")
