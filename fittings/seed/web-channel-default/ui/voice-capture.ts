// AudioWorklet mic-capture path (S6b, D20). Shared by conversation mode AND
// push-to-talk — the difference is only how the host reacts to utterance_end
// vs a button release, never how audio is captured.
//
// Pipeline: getUserMedia → AudioContext → AudioWorkletNode(pcm-downsample) →
// 16 kHz linear16 PCM frames → WS /api/voice/stream. The relay/voice-server
// events come back over the same WS and are dispatched to the callbacks:
//   ready | speech_started | transcript{isFinal} | utterance_end | error
//
// Replaces the retired ScriptProcessorNode-based capture path.

export interface CaptureCallbacks {
  onReady?(sampleRate: number): void;
  onSpeechStarted?(): void;
  /** Interim (not-yet-final) transcript text. */
  onInterim?(text: string): void;
  /** A finalized transcript segment. */
  onFinal?(text: string): void;
  /** Silence endpoint — the accumulated final transcript for the utterance. */
  onUtteranceEnd?(transcript: string): void;
  /** 0..1 input level for the meter. */
  onLevel?(level: number): void;
  onError?(error: string): void;
  onClose?(): void;
}

export interface CaptureOptions {
  /** URL the worklet module is served from (default "/pcm-worklet.js"). */
  workletUrl?: string;
  /** Override the STT WS URL (default derived from window.location). */
  streamUrl?: string;
  /** Downsample target rate; must match the ?sample_rate on the WS (default 16000). */
  targetRate?: number;
  /** Deepgram utterance_end_ms — silence before auto-send (default 5000). */
  silenceMs?: number;
}

export interface CaptureHandle {
  stop(): void;
  readonly closed: boolean;
}

// getUserMedia + AudioWorklet both require a SECURE CONTEXT (https or localhost).
// Over a plain-http LAN/Tailscale origin they're unavailable — we gate the mic
// button on this and show a clear message instead of throwing on click.
export function isCaptureSupported(): boolean {
  if (typeof window === "undefined") return false;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  return Boolean(
    window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof AC === "function" &&
      typeof (window as any).AudioWorkletNode !== "undefined"
  );
}

export function captureUnsupportedReason(): string {
  if (typeof window === "undefined") return "no browser environment";
  if (!window.isSecureContext) return "Microphone needs a secure context (https or localhost)";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser has no microphone access";
  if (typeof (window as any).AudioWorkletNode === "undefined") return "This browser has no AudioWorklet support";
  return "Microphone unavailable";
}

function defaultStreamUrl(targetRate: number, silenceMs: number): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/voice/stream?sample_rate=${targetRate}&utterance_end_ms=${silenceMs}`;
}

/** Open the mic and stream PCM to the voice relay. Rejects if the mic can't be
 *  opened; resolves with a handle whose stop() tears the whole graph down. */
export async function startCapture(cb: CaptureCallbacks, opts: CaptureOptions = {}): Promise<CaptureHandle> {
  const targetRate = opts.targetRate ?? 16000;
  const silenceMs = opts.silenceMs ?? 5000;
  const workletUrl = opts.workletUrl ?? "/pcm-worklet.js";
  const streamUrl = opts.streamUrl ?? defaultStreamUrl(targetRate, silenceMs);

  let closed = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let src: MediaStreamAudioSourceNode | null = null;
  let ready = false;

  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { node?.port.close(); } catch {}
    try { node?.disconnect(); } catch {}
    try { src?.disconnect(); } catch {}
    try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx?.close(); } catch {}
  };

  const handle: CaptureHandle = {
    stop() {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      try { ws.close(); } catch {}
      cleanup();
    },
    get closed() { return closed; },
  };

  // Open the WS first so it's connecting while the mic permission resolves.
  const ws = new WebSocket(streamUrl);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return; // STT stream is JSON only
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    switch (m.type) {
      case "ready":
        ready = true;
        cb.onReady?.(typeof m.sampleRate === "number" ? m.sampleRate : targetRate);
        break;
      case "speech_started":
        cb.onSpeechStarted?.();
        break;
      case "transcript":
        if (typeof m.text === "string" && m.text) {
          if (m.isFinal) cb.onFinal?.(m.text);
          else cb.onInterim?.(m.text);
        }
        break;
      case "utterance_end":
        cb.onUtteranceEnd?.(typeof m.transcript === "string" ? m.transcript : "");
        break;
      case "error":
        cb.onError?.(typeof m.error === "string" ? m.error : "voice error");
        break;
      default:
        break;
    }
  };
  ws.onerror = () => { cb.onError?.("voice stream connection error"); };
  ws.onclose = () => { if (!closed) cb.onClose?.(); };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    handle.stop();
    throw err instanceof Error ? err : new Error("microphone permission denied");
  }
  if (closed) { stream.getTracks().forEach((t) => t.stop()); return handle; }

  const audioCtx: AudioContext = new AC();
  ctx = audioCtx;
  try { await audioCtx.resume(); } catch {}
  try {
    await audioCtx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    handle.stop();
    throw err instanceof Error ? err : new Error("failed to load audio worklet");
  }
  if (closed) return handle;

  src = audioCtx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(audioCtx, "pcm-downsample", { processorOptions: { targetRate } });
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (!d || d.type !== "pcm") return;
    if (typeof d.level === "number") cb.onLevel?.(d.level);
    // Gate on both the socket AND the server's ready signal (Deepgram must have
    // its upstream open before we push frames).
    if (ready && ws.readyState === WebSocket.OPEN) {
      try { ws.send(d.pcm); } catch {}
    }
  };
  // The worklet writes no output; routing it to the destination only keeps the
  // graph pulled (destination receives silence — no mic echo).
  src.connect(node);
  node.connect(audioCtx.destination);

  return handle;
}
