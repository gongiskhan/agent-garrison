"""Small, dependency-free runtime rules, also used by setup and tests."""
import json
import os
import threading
import time

MAX_TEXT_CHARS = 900
MAX_AUDIO_BYTES = 25 * 1024 * 1024
MAX_AUDIO_SECONDS = 120


def model_dir(env=None):
    env = os.environ if env is None else env
    return os.path.abspath(os.path.expanduser(env.get('LOCAL_VOICE_MODEL_DIR') or '~/.cache/garrison-local-voice/models'))


def piper_paths(raw=None, cache=None):
    """Unset/blank uses the default; an explicit {} disables all Piper voices."""
    cache = cache or model_dir()
    if raw is None or not raw.strip():
        return {'pt': os.path.join(cache, 'piper-voices', 'pt_PT-tugao-medium.onnx')}
    value = json.loads(raw)
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        raise ValueError('PIPER_VOICES must be a JSON object mapping language to model path')
    return {key: os.path.abspath(os.path.expanduser(value)) if value else '' for key, value in value.items()}


def speech_text(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('text is required')
    text = text.strip()
    if len(text) > MAX_TEXT_CHARS:
        raise OverflowError(f'text exceeds {MAX_TEXT_CHARS} characters')
    return text


def watch_parent(expected_pid, reap=lambda: None, interval=0.5, getppid=os.getppid, sleep=time.sleep, exit_fn=os._exit):
    # Check before sleeping, and use the PID supplied by Node. If Node died
    # during interpreter startup, the adopted PID must never become baseline.
    while True:
        if getppid() != expected_pid:
            try:
                reap()
            finally:
                exit_fn(0)
            return
        sleep(interval)


def arm_parent_watchdog(reap=lambda: None):
    raw = os.environ.get('VOICE_PARENT_PID')
    expected = int(raw) if raw else os.getppid()
    if expected < 1:
        raise ValueError('invalid VOICE_PARENT_PID')
    worker = threading.Thread(target=watch_parent, args=(expected, reap), daemon=True, name='parent-watchdog')
    worker.start()
    return worker
