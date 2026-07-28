// PCM capture worklet (S6b, D20) — the modern replacement for the retired
// ScriptProcessorNode-based capture path.
//
// Runs OFF the main thread. Each render quantum it:
//   1. linear-interpolates the input (the AudioContext's native rate — 48000 on
//      phones, whatever headless Chromium picks) down to `targetRate` (16 kHz,
//      a known-good Deepgram linear16 rate), and
//   2. transfers the resulting Int16 PCM buffer + an RMS level to the main thread,
// which forwards the PCM over the WS to the voice relay. Resampling here (not on
// the main thread) keeps the WS payload small and the UI thread free.
//
// `sampleRate` is a global in the AudioWorkletGlobalScope = the context's rate.
// Served as a static asset; loaded via AudioContext.audioWorklet.addModule().

class PcmDownsampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    // Ratio of source frames per output frame. > 1 when downsampling.
    this.ratio = sampleRate / this.targetRate;
    // Fractional read position carried across render quanta so the resample is
    // continuous (no clicks at buffer boundaries).
    this.rsPos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const chan = input && input[0];
    if (!chan || chan.length === 0) return true;

    // RMS → a 0..1 level for the UI meter (matches legacy scaling).
    let sum = 0;
    for (let i = 0; i < chan.length; i++) sum += chan[i] * chan[i];
    const level = Math.min(1, Math.sqrt(sum / chan.length) * 4);

    const out = new Int16Array(Math.ceil(chan.length / this.ratio) + 2);
    let oi = 0;
    let pos = this.rsPos;
    while (pos < chan.length) {
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, chan.length - 1);
      const frac = pos - i0;
      const s = chan[i0] * (1 - frac) + chan[i1] * frac;
      const clamped = s < 0 ? Math.max(-1, s) : Math.min(1, s);
      out[oi++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      pos += this.ratio;
    }
    this.rsPos = pos - chan.length;

    if (oi > 0) {
      const buf = out.slice(0, oi).buffer;
      this.port.postMessage({ type: "pcm", pcm: buf, level }, [buf]);
    }
    return true;
  }
}

registerProcessor("pcm-downsample", PcmDownsampleProcessor);
