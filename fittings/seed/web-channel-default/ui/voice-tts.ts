// Streaming read-aloud playback (S6b, D20). Talks to the voice relay's
// /api/voice/tts-stream WebSocket (Deepgram Aura-2), which streams linear16 PCM
// back as it's synthesized so playback starts before the whole reply is spoken.
//
// Client → relay:  {speak,text} {flush} {clear} {close}
// Relay  → client:  {ready,sampleRate} · <binary linear16 PCM> · {flushed} {cleared} {error}
//
// Barge-in: clear()/stop() halt every scheduled buffer AND send {clear} so the
// relay drops pending upstream audio — the reply is cut instantly when the user
// speaks over it.

export interface TtsCallbacks {
  onReady?(sampleRate: number): void;
  /** First audio frame arrived — the latency mark for the 2s budget. */
  onFirstAudio?(): void;
  /** Playback of the whole reply finished naturally. */
  onDone?(): void;
  onError?(error: string): void;
}

export interface TtsOptions {
  /** Override the TTS WS URL (default derived from window.location). */
  streamUrl?: string;
  /** Aura native rate; must match ?sample_rate on the WS (default 24000). */
  sampleRate?: number;
  /** A pre-resumed AudioContext (unlocked in a user gesture) for mobile autoplay.
   *  When omitted a fresh one is created. */
  audioContext?: AudioContext;
}

export interface TtsHandle {
  /** Halt playback + tell the relay to drop pending audio (barge-in / abort). */
  stop(): void;
  readonly closed: boolean;
}

function defaultTtsUrl(sampleRate: number): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/voice/tts-stream?sample_rate=${sampleRate}`;
}

/** Synthesize + play `text`. Sends the whole reply up front (it's already
 *  settled) and lets Aura stream audio back for low first-audio latency. */
export function startTts(text: string, cb: TtsCallbacks, opts: TtsOptions = {}): TtsHandle {
  const sampleRate = opts.sampleRate ?? 24000;
  const streamUrl = opts.streamUrl ?? defaultTtsUrl(sampleRate);
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;

  const ownCtx = !opts.audioContext;
  const ctx: AudioContext = opts.audioContext ?? new AC();
  try { void ctx.resume(); } catch {}

  let closed = false;
  let firstAudio = false;
  let flushed = false;
  // Gapless scheduling clock: the time the next buffer should start.
  let nextStartTime = 0;
  const sources = new Set<AudioBufferSourceNode>();
  let lastSource: AudioBufferSourceNode | null = null;

  const ws = new WebSocket(streamUrl);
  ws.binaryType = "arraybuffer";

  const finish = () => {
    if (closed) return;
    cb.onDone?.();
    teardown();
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    for (const s of sources) { try { s.onended = null; s.stop(); } catch {} }
    sources.clear();
    try { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "clear" })); ws.send(JSON.stringify({ type: "close" })); } } catch {}
    try { ws.close(); } catch {}
    if (ownCtx) { try { void ctx.close(); } catch {} }
  };

  const schedulePcm = (buf: ArrayBuffer) => {
    const pcm = new Int16Array(buf);
    if (pcm.length === 0) return;
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
    let audioBuf: AudioBuffer;
    try {
      audioBuf = ctx.createBuffer(1, f32.length, sampleRate);
    } catch {
      return; // context closed mid-flight
    }
    audioBuf.getChannelData(0).set(f32);
    const source = ctx.createBufferSource();
    source.buffer = audioBuf;
    source.connect(ctx.destination);
    const now = ctx.currentTime;
    if (nextStartTime < now) nextStartTime = now;
    source.start(nextStartTime);
    nextStartTime += audioBuf.duration;
    sources.add(source);
    lastSource = source;
    source.onended = () => {
      sources.delete(source);
      // When synthesis is done AND this was the last scheduled buffer, we're done.
      if (flushed && source === lastSource) finish();
    };
  };

  ws.onopen = () => {
    // Whole reply up front, then flush to force synthesis, then close the input
    // side (audio keeps streaming back until {flushed}).
    try {
      ws.send(JSON.stringify({ type: "speak", text }));
      ws.send(JSON.stringify({ type: "flush" }));
    } catch {}
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      if (!firstAudio) { firstAudio = true; cb.onFirstAudio?.(); }
      schedulePcm(ev.data);
      return;
    }
    if (typeof ev.data !== "string") return;
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    switch (m.type) {
      case "ready":
        cb.onReady?.(typeof m.sampleRate === "number" ? m.sampleRate : sampleRate);
        break;
      case "flushed":
        flushed = true;
        // No audio ever arrived (empty reply / error) → done immediately.
        if (sources.size === 0) finish();
        break;
      case "error":
        cb.onError?.(typeof m.error === "string" ? m.error : "tts error");
        finish();
        break;
      default:
        break;
    }
  };
  ws.onerror = () => { cb.onError?.("tts connection error"); };
  ws.onclose = () => { if (!closed && !flushed) finish(); };

  return {
    stop() { teardown(); },
    get closed() { return closed; },
  };
}
