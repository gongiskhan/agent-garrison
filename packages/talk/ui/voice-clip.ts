// REST voice clips: microphone capture segmented into utterances and posted to
// `POST /api/voice/stt`, replies synthesized through `POST /api/voice/tts`.
//
// This replaces the AudioWorklet + WebSocket relay pair (voice-capture.ts /
// voice-tts.ts) so the SAME code runs under both hosts of @garrison/talk: the
// legacy own-port fitting and the Next shell, which serves plain request/response
// routes and no WebSocket upgrades. The callback and handle shapes are unchanged
// on purpose - voice-conversation.tsx and the voice-machine reducer see the same
// events (speech onset, final, utterance end, level) whichever transport is
// underneath.
//
// Capture: getUserMedia → AnalyserNode (level meter + a small energy VAD) →
// MediaRecorder. In conversation mode the recorder is cut at each silence gap and
// the segment is transcribed; segments in which no speech was detected are
// discarded unsent. In push-to-talk mode the recorder runs until finish() and the
// whole clip is transcribed once.
//
// TTS: the settled reply is split at sentence boundaries into chunks under the
// provider's request limit, each fetched as mp3 and decoded into the caller's
// (gesture-unlocked) AudioContext; the next chunk is fetched while the current
// one plays. stop() halts playback and aborts pending fetches (barge-in).

import { chunkSpeech, DEFAULT_CHUNK_CHARS } from "@garrison/claude-chat/voice";

export interface CaptureCallbacks {
  /** Microphone open and the recorder running. */
  onReady?(): void;
  /** Speech energy detected after silence (barge-in trigger while a reply plays). */
  onSpeechStarted?(): void;
  /** Not produced by the REST path (there is no partial transcript); kept for API parity. */
  onInterim?(text: string): void;
  /** Transcript of a finished segment. */
  onFinal?(text: string): void;
  /** End of an utterance: the segment was transcribed (possibly empty). */
  onUtteranceEnd?(transcript?: string): void;
  /** Input level 0..1, ~20 times a second. */
  onLevel?(level: number): void;
  onError?(error: string): void;
  onClose?(): void;
}

export interface CaptureOptions {
  /** Transcription endpoint (default `/api/voice/stt`). */
  sttUrl?: string;
  /**
   * Language hint for the transcriber (`en`, `pt`, `multi`), sent as
   * `?language=` on every clip. A function is consulted per clip, so a choice
   * made mid-dictation applies to the next segment. Unset leaves the
   * server's default (the wake lane's pin) in charge.
   */
  language?: string | (() => string | null | undefined);
  /** `conversation` cuts segments at silence; `ptt` records until finish(). */
  mode?: "conversation" | "ptt";
  /** Silence after speech that closes a segment (conversation mode). */
  silenceMs?: number;
  /** Consecutive above-threshold ticks before speech onset is reported. */
  onsetTicks?: number;
  /** A segment with no speech is restarted after this long to bound its size. */
  idleRestartMs?: number;
  /** A segment with speech is cut here even without a silence gap. */
  maxUtteranceMs?: number;
  /** Override the energy threshold (0..1); default adapts to the noise floor. */
  speechThreshold?: number;
}

export interface CaptureHandle {
  /** Close the mic and drop whatever is recording (no transcription). */
  stop(): void;
  /** Push-to-talk release: stop recording and transcribe the clip. Capture
   *  stays open until stop(); the machine closes it after UTTERANCE_END. */
  finish(): void;
  readonly closed: boolean;
}

const LEVEL_INTERVAL_MS = 50;
const DEFAULT_SILENCE_MS = 1100;
const DEFAULT_ONSET_TICKS = 3;
const DEFAULT_IDLE_RESTART_MS = 10_000;
const DEFAULT_MAX_UTTERANCE_MS = 60_000;
const MIN_SPEECH_THRESHOLD = 0.02;

// getUserMedia and MediaRecorder both need a SECURE CONTEXT (https or localhost).
export function isCaptureSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return Boolean(
    window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof (window as any).MediaRecorder === "function" &&
      typeof ((window as any).AudioContext || (window as any).webkitAudioContext) === "function",
  );
}

export function captureUnsupportedReason(): string {
  if (typeof window === "undefined") return "Voice needs a browser";
  if (!window.isSecureContext) return "Microphone needs a secure context (https or localhost)";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser has no microphone access";
  if (typeof (window as any).MediaRecorder !== "function") return "This browser cannot record audio (MediaRecorder missing)";
  if (typeof ((window as any).AudioContext || (window as any).webkitAudioContext) !== "function") return "This browser has no Web Audio";
  return "";
}

/** The recorder container this browser can produce that the STT side accepts. */
export function pickRecorderMimeType(): string {
  const MR = (typeof window !== "undefined" ? (window as any).MediaRecorder : undefined) as
    | { isTypeSupported?(t: string): boolean }
    | undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  return candidates.find((t) => MR.isTypeSupported!(t)) ?? "";
}

/** RMS of an 8-bit time-domain buffer, normalised to 0..1. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3);
}

/** Pure segmentation gate shared by capture and its tests: decides, per level
 *  tick, whether speech starts, continues, or the segment should be cut. */
export class SegmentGate {
  private floor = 0.01;
  private above = 0;
  private speaking = false;
  private lastSpeechAt = 0;
  private startedAt: number;
  private speechSeen = false;
  constructor(
    private readonly opts: Required<Pick<CaptureOptions, "silenceMs" | "onsetTicks" | "idleRestartMs" | "maxUtteranceMs">> & {
      speechThreshold?: number;
    },
    now: number,
  ) {
    this.startedAt = now;
  }

  get threshold(): number {
    if (typeof this.opts.speechThreshold === "number") return this.opts.speechThreshold;
    return Math.max(MIN_SPEECH_THRESHOLD, this.floor * 2.5 + 0.01);
  }

  get hasSpeech(): boolean {
    return this.speechSeen;
  }

  /** Begin a new segment at `now`. */
  restart(now: number): void {
    this.startedAt = now;
    this.speechSeen = false;
    this.speaking = false;
    this.above = 0;
  }

  /** Feed one level sample; returns what the capture loop must do. */
  tick(level: number, now: number): "none" | "onset" | "cut" | "discard" {
    const loud = level > this.threshold;
    if (!loud) {
      // Track the ambient floor only in quiet ticks (slow follower).
      this.floor = this.floor * 0.95 + level * 0.05;
    }
    let result: "none" | "onset" | "cut" | "discard" = "none";
    if (loud) {
      this.above += 1;
      if (this.above >= this.opts.onsetTicks) {
        this.lastSpeechAt = now;
        if (!this.speaking) {
          this.speaking = true;
          if (!this.speechSeen) {
            this.speechSeen = true;
            result = "onset";
          }
        }
      }
    } else {
      this.above = 0;
      if (this.speaking && now - this.lastSpeechAt >= this.opts.silenceMs) {
        this.speaking = false;
        return "cut";
      }
    }
    if (this.speechSeen && now - this.startedAt >= this.opts.maxUtteranceMs) return "cut";
    if (!this.speechSeen && now - this.startedAt >= this.opts.idleRestartMs) return "discard";
    return result;
  }
}

/** `sttUrl` with the language hint appended, or unchanged without one. */
export function sttUrlFor(sttUrl: string, language: CaptureOptions["language"]): string {
  const lang = (typeof language === "function" ? language() : language)?.trim();
  if (!lang) return sttUrl;
  const sep = sttUrl.includes("?") ? "&" : "?";
  return `${sttUrl}${sep}language=${encodeURIComponent(lang)}`;
}

async function transcribeBlob(sttUrl: string, blob: Blob, signal: AbortSignal): Promise<string> {
  const r = await fetch(sttUrl, {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
    signal,
  });
  if (!r.ok) {
    let detail = "";
    try {
      const j = await r.json();
      detail = j?.error ? `: ${j.error}` : "";
    } catch {}
    throw new Error(`transcription failed (${r.status})${detail}`);
  }
  const j = (await r.json()) as { transcript?: string };
  return typeof j?.transcript === "string" ? j.transcript.trim() : "";
}

/** Open the microphone and start segmenting. Resolves once the recorder runs. */
export async function startCapture(cb: CaptureCallbacks, opts: CaptureOptions = {}): Promise<CaptureHandle> {
  if (!isCaptureSupported()) throw new Error(captureUnsupportedReason() || "voice capture unsupported");
  const sttUrl = opts.sttUrl ?? "/api/voice/stt";
  const mode = opts.mode ?? "conversation";
  const gateOpts = {
    silenceMs: opts.silenceMs ?? DEFAULT_SILENCE_MS,
    onsetTicks: opts.onsetTicks ?? DEFAULT_ONSET_TICKS,
    idleRestartMs: opts.idleRestartMs ?? DEFAULT_IDLE_RESTART_MS,
    maxUtteranceMs: opts.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS,
    speechThreshold: opts.speechThreshold,
  };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  const audioCtx: AudioContext = new AC();
  try { void audioCtx.resume(); } catch {}
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  const mimeType = pickRecorderMimeType();
  const abort = new AbortController();
  let closed = false;
  let recorder: MediaRecorder | null = null;
  const chunksOf = new WeakMap<MediaRecorder, Blob[]>();
  let finishing = false;
  const gate = new SegmentGate(gateOpts, Date.now());

  const fail = (msg: string) => {
    if (closed) return;
    try { cb.onError?.(msg); } catch {}
  };

  const transcribe = (blob: Blob) => {
    if (!blob.size) {
      try { cb.onUtteranceEnd?.(""); } catch {}
      return;
    }
    transcribeBlob(sttUrlFor(sttUrl, opts.language), blob, abort.signal)
      .then((text) => {
        if (closed && !finishing) return;
        if (text) { try { cb.onFinal?.(text); } catch {} }
        try { cb.onUtteranceEnd?.(text); } catch {}
      })
      .catch((e) => {
        if (abort.signal.aborted) return;
        fail(e?.message || "transcription failed");
      });
  };

  /** Stop the running recorder; `keep` decides whether its clip is transcribed. */
  const cutSegment = (keep: boolean): void => {
    const rec = recorder;
    recorder = null;
    if (!rec) return;
    // The recorder's own chunk list: the final dataavailable that precedes
    // `stop` still lands in it, never in the next segment's.
    const collected = chunksOf.get(rec) ?? [];
    rec.onstop = () => {
      const blob = new Blob(collected, { type: rec.mimeType || mimeType || "audio/webm" });
      if (keep) transcribe(blob);
    };
    try {
      if (rec.state !== "inactive") rec.stop();
      else rec.onstop?.(new Event("stop"));
    } catch (e: any) {
      fail(e?.message || "recorder stop failed");
    }
  };

  const startSegment = (): void => {
    if (closed) return;
    try {
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const segChunks: Blob[] = [];
      chunksOf.set(rec, segChunks);
      rec.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size) segChunks.push(ev.data); };
      rec.onerror = () => fail("recorder error");
      rec.start(250);
      recorder = rec;
      gate.restart(Date.now());
    } catch (e: any) {
      fail(e?.message || "recorder start failed");
    }
  };

  const levelTimer = window.setInterval(() => {
    if (closed) return;
    analyser.getByteTimeDomainData(samples);
    const level = rmsLevel(samples);
    try { cb.onLevel?.(level); } catch {}
    if (finishing || !recorder) return;
    const verdict = gate.tick(level, Date.now());
    if (verdict === "onset") {
      try { cb.onSpeechStarted?.(); } catch {}
    } else if (mode === "conversation" && verdict === "cut") {
      cutSegment(true);
      startSegment();
    } else if (mode === "conversation" && verdict === "discard") {
      cutSegment(false);
      startSegment();
    }
  }, LEVEL_INTERVAL_MS);

  const teardown = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(levelTimer);
    abort.abort();
    try { recorder?.stop(); } catch {}
    recorder = null;
    try { source.disconnect(); } catch {}
    try { void audioCtx.close(); } catch {}
    for (const t of stream.getTracks()) { try { t.stop(); } catch {} }
    try { cb.onClose?.(); } catch {}
  };

  startSegment();
  try { cb.onReady?.(); } catch {}

  return {
    stop: teardown,
    finish: () => {
      if (closed || finishing) return;
      finishing = true;
      // Release the mic right away; the pending transcription is what keeps
      // the handle alive until the machine closes it.
      cutSegment(true);
      window.clearInterval(levelTimer);
      for (const t of stream.getTracks()) { try { t.stop(); } catch {} }
    },
    get closed() {
      return closed;
    },
  };
}

// ────────────────────────────── TTS ──────────────────────────────

export interface TtsCallbacks {
  onReady?(sampleRate: number): void;
  /** First audio started playing - the latency mark for the 2s budget. */
  onFirstAudio?(): void;
  /** Playback of the whole reply finished naturally. */
  onDone?(): void;
  onError?(error: string): void;
}

export interface TtsOptions {
  /** Synthesis endpoint (default `/api/voice/tts`). */
  ttsUrl?: string;
  /** A pre-resumed AudioContext (unlocked in a user gesture) for mobile autoplay.
   *  When omitted a fresh one is created. */
  audioContext?: AudioContext;
  /** Maximum characters per synthesis request (provider limit). */
  chunkChars?: number;
}

export interface TtsHandle {
  /** Halt playback and abort pending synthesis (barge-in / abort). */
  stop(): void;
  readonly closed: boolean;
}

// The splitter and its 600-character default live in @garrison/claude-chat/voice
// so both read-aloud paths (this one and ClaudeChat's) cut replies the same way
// against the same cap; re-exported here for the callers and tests that already
// import them from this module.
export { chunkSpeech, DEFAULT_CHUNK_CHARS };

/** Synthesize and play `text`. Chunks are fetched one ahead of playback. */
export function startTts(text: string, cb: TtsCallbacks, opts: TtsOptions = {}): TtsHandle {
  const ttsUrl = opts.ttsUrl ?? "/api/voice/tts";
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  const ownCtx = !opts.audioContext;
  const ctx: AudioContext | null = opts.audioContext ?? (typeof AC === "function" ? new AC() : null);
  if (ctx) { try { void ctx.resume(); } catch {} }

  const abort = new AbortController();
  let closed = false;
  let firstAudio = false;
  let current: AudioBufferSourceNode | HTMLAudioElement | null = null;
  let objectUrl: string | null = null;

  const chunks = chunkSpeech(text, opts.chunkChars);
  if (!chunks.length) {
    queueMicrotask(() => { if (!closed) cb.onDone?.(); });
    return { stop: () => { closed = true; }, get closed() { return closed; } };
  }

  const fetchChunk = async (chunk: string): Promise<ArrayBuffer> => {
    const r = await fetch(ttsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: chunk, format: "mp3" }),
      signal: abort.signal,
    });
    if (!r.ok) {
      let detail = "";
      try { const j = await r.json(); detail = j?.error ? `: ${j.error}` : ""; } catch {}
      throw new Error(`speech synthesis failed (${r.status})${detail}`);
    }
    return r.arrayBuffer();
  };

  const markFirstAudio = () => {
    if (firstAudio || closed) return;
    firstAudio = true;
    try { cb.onFirstAudio?.(); } catch {}
  };

  const playBuffer = (bytes: ArrayBuffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      if (ctx) {
        ctx.decodeAudioData(bytes.slice(0)).then(
          (decoded) => {
            if (closed) return resolve();
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            src.connect(ctx.destination);
            src.onended = () => { if (current === src) current = null; resolve(); };
            current = src;
            try { src.start(); markFirstAudio(); } catch (e) { reject(e); }
          },
          () => {
            // Some WebKit builds refuse to decode mp3 through Web Audio; fall
            // back to a media element for this chunk.
            playViaElement(bytes).then(resolve, reject);
          },
        );
      } else {
        playViaElement(bytes).then(resolve, reject);
      }
    });

  const playViaElement = (bytes: ArrayBuffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
      objectUrl = url;
      const el = new Audio(url);
      current = el;
      el.onplaying = () => markFirstAudio();
      el.onended = () => { URL.revokeObjectURL(url); if (objectUrl === url) objectUrl = null; if (current === el) current = null; resolve(); };
      el.onerror = () => { URL.revokeObjectURL(url); reject(new Error("audio playback failed")); };
      el.play().catch(reject);
    });

  (async () => {
    try {
      let next: Promise<ArrayBuffer> = fetchChunk(chunks[0]);
      try { cb.onReady?.(ctx?.sampleRate ?? 0); } catch {}
      for (let i = 0; i < chunks.length; i++) {
        const bytes = await next;
        if (closed) return;
        if (i + 1 < chunks.length) {
          next = fetchChunk(chunks[i + 1]);
          // A failed prefetch surfaces when awaited on the next loop turn.
          next.catch(() => {});
        }
        await playBuffer(bytes);
        if (closed) return;
      }
      if (!closed) {
        closed = true;
        if (ownCtx && ctx) { try { void ctx.close(); } catch {} }
        try { cb.onDone?.(); } catch {}
      }
    } catch (e: any) {
      if (closed || abort.signal.aborted) return;
      closed = true;
      if (ownCtx && ctx) { try { void ctx.close(); } catch {} }
      try { cb.onError?.(e?.message || "speech synthesis failed"); } catch {}
    }
  })();

  return {
    stop: () => {
      if (closed) return;
      closed = true;
      abort.abort();
      const c = current;
      current = null;
      if (c) {
        try {
          if ("pause" in c) { (c as HTMLAudioElement).pause(); (c as HTMLAudioElement).src = ""; }
          else { (c as AudioBufferSourceNode).onended = null; (c as AudioBufferSourceNode).stop(); }
        } catch {}
      }
      if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch {} objectUrl = null; }
      if (ownCtx && ctx) { try { void ctx.close(); } catch {} }
    },
    get closed() {
      return closed;
    },
  };
}
