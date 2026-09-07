"""Bounded decoding before an uploaded clip reaches a speech model."""
import io
import itertools
import time

import av
import numpy as np

from runtime_support import MAX_AUDIO_SECONDS


def decode_bounded(audio, sampling_rate=16000):
    resampler = av.audio.resampler.AudioResampler(format='s16', layout='mono', rate=sampling_rate)
    chunks, total, started = [], 0, time.monotonic()
    with av.open(io.BytesIO(audio), mode='r', metadata_errors='ignore') as container:
        for frame in itertools.chain(container.decode(audio=0), [None]):
            if time.monotonic() - started > 15:
                raise OverflowError('audio decoding timed out')
            if frame is not None:
                frame.pts = None
            for converted in resampler.resample(frame):
                total += converted.samples
                if total > MAX_AUDIO_SECONDS * sampling_rate:
                    raise OverflowError('audio exceeds 120 seconds')
                chunks.append(converted.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError('empty audio')
    return np.concatenate(chunks).astype(np.float32) / 32768.0
