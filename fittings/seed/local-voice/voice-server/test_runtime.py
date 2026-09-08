"""No model downloads or microphone access. Runs with the standard library."""
import ast
import asyncio
import io
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time
import unittest
from types import SimpleNamespace

from runtime_support import MAX_TEXT_CHARS, model_dir, piper_paths, speech_text, watch_parent


class RuntimeRules(unittest.TestCase):
    def test_blank_piper_uses_external_default_but_empty_object_disables(self):
        self.assertEqual(piper_paths('', '/external/models'), {'pt': '/external/models/piper-voices/pt_PT-tugao-medium.onnx'})
        self.assertEqual(piper_paths('{}', '/external/models'), {})
        self.assertEqual(piper_paths('{"en":"/custom/model.onnx"}'), {'en': '/custom/model.onnx'})
        with self.assertRaises(ValueError):
            piper_paths('[]')

    def test_cache_is_external_and_override_is_shared(self):
        self.assertTrue(model_dir({}).endswith('/.cache/garrison-local-voice/models'))
        self.assertEqual(model_dir({'LOCAL_VOICE_MODEL_DIR': '/tmp/voice-models'}), '/tmp/voice-models')

    def test_text_never_silently_truncates(self):
        text = 'hello ' * 150
        self.assertEqual(speech_text(text), text.strip())
        with self.assertRaises(OverflowError):
            speech_text('a' * (MAX_TEXT_CHARS + 1))
        with self.assertRaises(ValueError):
            speech_text(None)

    def test_parent_death_before_first_poll_reaps_and_exits(self):
        events = []
        watch_parent(42, reap=lambda: events.append('reap'), getppid=lambda: 1,
                     sleep=lambda _: self.fail('must check first'), exit_fn=lambda _: events.append('exit'))
        self.assertEqual(events, ['reap', 'exit'])

    def test_watchdog_tracks_original_parent_even_when_adopted(self):
        parents = iter([42, 42, 1])
        events = []
        watch_parent(42, reap=lambda: events.append('reap'), getppid=lambda: next(parents),
                     sleep=lambda _: events.append('wait'), exit_fn=lambda _: events.append('exit'))
        self.assertEqual(events, ['wait', 'wait', 'reap', 'exit'])


class Reply:
    def __init__(self, content=None, status_code=200, **kwargs):
        self.content, self.status_code, self.headers = content, status_code, kwargs.get('headers', {})


def engine_functions():
    # Exercise the actual request functions with synthetic engines, without
    # importing model-loading module globals. Transport is tested over real HTTP.
    source = ast.parse(Path(__file__).with_name('server.py').read_text())
    names = {'_transcribe_audio', 'stt', 'speak', 'speak_post', 'wav_header'}
    nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    for node in nodes:
        node.decorator_list = []
    calls = []
    class Samples:
        def __init__(self, silent=False): self.silent = silent
        def __mul__(self, _): return self
        def astype(self, _): return self
        def tobytes(self): return b'\0\0' * 100 if self.silent else b'\x01\x01' * 100
    class Model:
        silent = False
        fail = False
        def create(self, text, **_):
            calls.append(text)
            if self.fail: raise ValueError('synthetic failure')
            return Samples(self.silent), 24000
    async def worker(fn, *args): return fn(*args)
    env = dict(Response=Reply, Request=object, Optional=lambda _: None, speech_text=speech_text,
               MAX_AUDIO_BYTES=1024, MAX_AUDIO_SECONDS=120, MAX_TEXT_CHARS=900, json=json, re=__import__('re'),
               threading=threading, time=time, io=io, struct=struct, run_in_threadpool=worker,
               stt_busy=threading.Lock(), tts_busy=threading.Lock(), LANG_VOICES={'en': {'voice': 'fixture', 'klang': 'en-gb'}},
               piper_voices={}, DEFAULT_TTS_LANG='en', detect_text_lang=lambda _: 'en', normalize_speech=lambda text, _: text,
               normalize_gain=lambda pcm: pcm, segments_of=lambda text: [(text, 0)], SAMPLE_RATE=24000, SPEED=1,
               kokoro=Model(), np=SimpleNamespace(clip=lambda x, *_: x, int16='int16'),
               decode_bounded=lambda _: [1] * 100, USE_WHISPER_CPP=False, whisper_lock=threading.Lock(),
               WHISPER_BEAM=1, STT_VAD_FILTER=False, WHISPER_PROMPT='', WHISPER_LANG='en', STT_ENGINE='fixture', score_eot=lambda _: 1)
    # Annotation evaluation must not import FastAPI or typing machinery.
    for node in ast.walk(ast.Module(body=nodes, type_ignores=[])):
        if isinstance(node, ast.arg): node.annotation = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): node.returns = None
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<voice-request-functions>', 'exec'), env)
    env['calls'] = calls
    return env


class EngineRequestRules(unittest.TestCase):
    def setUp(self): self.env = engine_functions()

    def test_all_accepted_text_reaches_engine_and_wav_lengths_match(self):
        text = 'a' * 900
        result = self.env['speak'](text)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.env['calls'], [text])
        self.assertEqual(struct.unpack_from('<I', result.content, 4)[0] + 8, len(result.content))
        self.assertEqual(struct.unpack_from('<I', result.content, 40)[0] + 44, len(result.content))
        self.assertFalse(self.env['tts_busy'].locked())

    def test_text_above_limit_is_rejected_before_engine(self):
        self.assertEqual(self.env['speak']('a' * 901).status_code, 413)
        self.assertEqual(self.env['calls'], [])

    def test_silent_and_failed_synthesis_are_not_success(self):
        self.env['kokoro'].silent = True
        self.assertEqual(self.env['speak']('Hello').status_code, 502)
        self.env['kokoro'].fail = True
        self.assertEqual(self.env['speak']('Hello').status_code, 502)
        self.assertFalse(self.env['tts_busy'].locked())

    def test_busy_synthesis_returns_backpressure(self):
        self.env['tts_busy'].acquire()
        self.assertEqual(self.env['speak']('Hello').status_code, 429)
        self.assertEqual(self.env['calls'], [])

    def test_malformed_and_overlong_audio_release_worker_gate(self):
        def fail(_): raise ValueError()
        self.env['decode_bounded'] = fail
        self.assertEqual(self.env['_transcribe_audio'](b'fixture').status_code, 400)
        self.assertFalse(self.env['stt_busy'].locked())
        def long(_): raise OverflowError('audio too long')
        self.env['decode_bounded'] = long
        self.assertEqual(self.env['_transcribe_audio'](b'fixture').status_code, 413)
        self.assertFalse(self.env['stt_busy'].locked())

    def test_stt_bounds_stream_before_decoder(self):
        class Request:
            async def stream(self):
                yield b'a' * 1024
                yield b'a'
        self.assertEqual(asyncio.run(self.env['stt'](Request())).status_code, 413)

    def test_post_speech_validates_json_and_language(self):
        class Request:
            def __init__(self, body): self.body = body
            async def stream(self): yield self.body
        for body in [b'[]', b'bad', b'{"text":"Hi","lang":12}']:
            self.assertEqual(asyncio.run(self.env['speak_post'](Request(body))).status_code, 400)
        self.assertEqual(asyncio.run(self.env['speak_post'](Request(b'{"text":"Hello"}'))).status_code, 200)


if __name__ == '__main__':
    unittest.main()
