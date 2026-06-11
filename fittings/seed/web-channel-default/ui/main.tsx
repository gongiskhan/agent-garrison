import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

// Mirror of src/lib/message-body.ts:29-30 (cannot import from Garrison core).
const GARRISON_URI = /\bgarrison:\/\/([A-Za-z0-9_-]+)(?:\/([^\s)<>"']+))?/g;

marked.setOptions({ breaks: true, gfm: true });

// Milliseconds of silence before a hands-free/streaming utterance is auto-sent.
// A normal mid-sentence pause is ~1–2s, so 5s avoids premature sends. Override
// for testing/tuning with ?silence_ms=<n> (clamped to Deepgram's [1000,20000]).
const SILENCE_MS = (() => {
  try {
    const n = Number(new URLSearchParams(window.location.search).get("silence_ms"));
    if (Number.isFinite(n) && n >= 1000 && n <= 20000) return Math.round(n);
  } catch {}
  return 5000;
})();

// Streaming is primary in any capable browser, which makes the batch
// MediaRecorder fallback unreachable on demand. ?voice=batch forces it so the
// fallback stays drivable (scripts/spike/voice-e2e.mjs) and debuggable.
const FORCE_BATCH = (() => {
  try {
    return new URLSearchParams(window.location.search).get("voice") === "batch";
  } catch {}
  return false;
})();

// A tiny valid silent WAV. Played once inside a user gesture (a toggle/mic/send
// tap) to UNLOCK mobile audio playback, so read-aloud can auto-play replies
// later without the user first tapping a speaker button (mobile autoplay policy).
const SILENT_WAV = (() => {
  const sr = 8000, n = 400;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, n * 2, true);
  let bin = ""; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
})();

type Role = "user" | "assistant" | "error";

interface Message {
  id: string;
  role: Role;
  content: string;
  sessionId?: string | null;
  streaming?: boolean;
}

interface MonitorInfo {
  available: boolean;
  url?: string;
}

interface VoiceInfo {
  available: boolean;
  url?: string;
}

// Secure context is required for getUserMedia (mic capture). localhost counts
// as secure; a LAN IP over plain http does not. We use this to disable the mic
// button with an explanatory title rather than throwing on click.
function micCaptureAllowed(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined"
  );
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function preprocessMarkdown(raw: string): string {
  return raw.replace(GARRISON_URI, (_match, fittingId, rest) => {
    const tail = rest ? `/${rest}` : "";
    const display = `garrison://${fittingId}${tail}`;
    return `[${display}](garrison://${fittingId}${tail})`;
  });
}

function renderMarkdown(content: string): string {
  const pre = preprocessMarkdown(content);
  return marked.parse(pre) as string;
}

function MessageBubble({
  message,
  onSpeak
}: {
  message: Message;
  onSpeak?: (text: string) => void;
}) {
  const html = useMemo(() => renderMarkdown(message.content || ""), [message.content]);
  const onClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    const target = ev.target as HTMLElement;
    if (target.tagName !== "A") return;
    const href = target.getAttribute("href") || "";
    if (href.startsWith("garrison://")) {
      ev.preventDefault();
      const match = href.match(/^garrison:\/\/([^/]+)(?:\/(.*))?$/);
      if (!match) return;
      const fittingId = match[1];
      const rest = match[2] ? `/${match[2]}` : "";
      // Open the parent shell route. Web-channel is typically a different
      // origin from the Garrison Next.js shell (port 7083 vs 7777), so we
      // can't navigate same-origin — show the URL in a new tab for the user
      // to resolve manually.
      window.open(`/fitting/${fittingId}${rest}`, "_blank", "noopener,noreferrer");
    }
  }, []);
  const canSpeak = message.role === "assistant" && !message.streaming && Boolean(message.content.trim()) && Boolean(onSpeak);
  return (
    <div className={`bubble ${message.role}${message.streaming ? " streaming" : ""}`} onClick={onClick}>
      {message.role === "error"
        ? <div className="meta">error</div>
        : null}
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {canSpeak ? (
        <button
          type="button"
          className="speak-button"
          title="Read this reply aloud"
          aria-label="Read this reply aloud"
          data-testid="speak-button"
          onClick={(ev) => { ev.stopPropagation(); onSpeak?.(message.content); }}
        >
          <SpeakerIcon />
        </button>
      ) : null}
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function parseSseEvent(raw: string): { event: string; data: any } | null {
  let event = "message";
  let dataText = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment / keepalive
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataText += (dataText ? "\n" : "") + line.slice(5).trim();
  }
  if (!dataText) return { event, data: null };
  try { return { event, data: JSON.parse(dataText) }; }
  catch { return { event, data: dataText }; }
}

function extractTextFromAssistantEvent(wrapped: any): string {
  const ev = wrapped?.event;
  if (!ev || ev.type !== "assistant") return "";
  const msg = ev.message || {};
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  let text = "";
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [composing, setComposing] = useState("");
  const [sending, setSending] = useState(false);
  const [monitor, setMonitor] = useState<MonitorInfo>({ available: false });
  const [voice, setVoice] = useState<VoiceInfo>({ available: false });
  const [recording, setRecording] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [autoSend, setAutoSend] = useState(true);
  const [handsFree, setHandsFree] = useState(false);
  const [connected, setConnected] = useState(false);
  // Voice state machine: idle → arming(countdown) → listening → speaking → …
  const [voiceState, setVoiceStateRaw] = useState<"idle" | "arming" | "listening" | "speaking">("idle");
  const [armCountdown, setArmCountdown] = useState(0);
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioPrimedRef = useRef(false);
  const audioUrlRef = useRef<string | null>(null);
  // Refs mirror state for use inside async callbacks/timers/ws handlers.
  const readAloudRef = useRef(false);
  const autoSendRef = useRef(true);
  const handsFreeRef = useRef(false);
  const voiceStateRef = useRef<"idle" | "arming" | "listening" | "speaking">("idle");
  const sendRef = useRef<(m?: string) => void>(() => {});
  const streamRef = useRef<{ ws: WebSocket; ctx: AudioContext; proc: ScriptProcessorNode; src: MediaStreamAudioSourceNode; stream: MediaStream; sink: GainNode } | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalTranscriptRef = useRef("");
  const streamReadyRef = useRef(false);
  useEffect(() => { readAloudRef.current = readAloud; }, [readAloud]);
  useEffect(() => { autoSendRef.current = autoSend; }, [autoSend]);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  const setVoiceState = useCallback((s: "idle" | "arming" | "listening" | "speaking") => {
    voiceStateRef.current = s;
    setVoiceStateRaw(s);
  }, []);
  const streamingSupported = !FORCE_BATCH && voice.available && micCaptureAllowed() &&
    typeof (window.AudioContext || (window as any).webkitAudioContext) === "function";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const lastAssistantBySessionRef = useRef<Map<string, string>>(new Map());
  const sendBubbleIdsRef = useRef<Set<string>>(new Set());
  // While a send is in flight, /api/chat owns the assistant bubble. Suppress
  // /api/stream's own bubble creation so we don't double-render the same
  // ring-buffer content (gateway publishes once; both /chat/stream chunks and
  // /channels/:id/stream events relay the same text).
  const sendingRef = useRef(false);
  // session_ids whose events have already been displayed via /api/chat in
  // this tab. /api/stream skips events with these session_ids so a refresh
  // doesn't append again on top of an already-shown reply.
  const consumedSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/monitor")
      .then((r) => r.json())
      .then((info) => setMonitor(info))
      .catch(() => setMonitor({ available: false }));
    fetch("/api/voice")
      .then((r) => r.json())
      .then((info) => setVoice(info))
      .catch(() => setVoice({ available: false }));
  }, []);

  // One reused <audio> element. Reusing a single element (vs new Audio() per
  // reply) is what lets a one-time gesture unlock keep working for later
  // programmatic auto-play on mobile.
  const getAudio = useCallback(() => {
    if (!audioRef.current) audioRef.current = new Audio();
    return audioRef.current;
  }, []);

  // Unlock mobile audio: play a silent clip inside a user gesture. After this,
  // read-aloud can auto-play replies without a manual speaker tap.
  const primeAudio = useCallback(() => {
    if (audioPrimedRef.current) return;
    const a = getAudio();
    try {
      a.src = SILENT_WAV;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(() => { audioPrimedRef.current = true; try { a.pause(); a.currentTime = 0; } catch {} })
         .catch(() => {});
      } else {
        audioPrimedRef.current = true;
      }
    } catch {}
  }, [getAudio]);

  // Tear down the live capture graph + WS. Safe to call from any state.
  const stopStreaming = useCallback(() => {
    const s = streamRef.current;
    streamRef.current = null;
    streamReadyRef.current = false;
    if (s) {
      try { s.proc.disconnect(); } catch {}
      try { s.src.disconnect(); } catch {}
      try { s.sink.disconnect(); } catch {}
      try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { s.ctx.close(); } catch {}
      try { if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      try { s.ws.close(); } catch {}
    }
    setInterim("");
    setLevel(0);
  }, []);

  // End-of-utterance (Deepgram silence endpointing). Loop-safety guard: empty /
  // sub-word transcripts are dropped silently so the mic opening into ambient
  // noise or speaker bleed never auto-sends and triggers a self-talk loop.
  const finalizeUtterance = useCallback((transcript: string) => {
    stopStreaming();
    const clean = (transcript || "").trim();
    setVoiceState("idle");
    if (!clean || clean.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length < 2) {
      return; // nothing meaningful heard
    }
    if (autoSendRef.current) {
      sendRef.current(clean);
    } else {
      setComposing((prev) => (prev ? prev + " " : "") + clean);
      textareaRef.current?.focus();
    }
  }, [stopStreaming, setVoiceState]);

  // Open the mic and stream linear16 PCM to the voice Fitting over a WS. The
  // AudioContext's native sample rate is sent to the server (iOS Safari ignores
  // a requested 16000), so no resampling and no rate guesswork.
  const startStreaming = useCallback(async () => {
    if (streamRef.current) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch {
      setVoiceState("idle");
      return;
    }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    try { await ctx.resume(); } catch {}
    // Capture at the device's native rate (don't fight iOS, which ignores a
    // requested 16000) and resample to 16 kHz in JS — a known-good Deepgram
    // rate. Native rates vary wildly (48000 on phones, 192000 under headless
    // Chromium); forwarding them raw is unreliable, so we always send 16000.
    const TARGET = 16000;
    const srcRate = ctx.sampleRate;
    const ratio = srcRate / TARGET;
    let rsPos = 0; // fractional read position, carried across buffers
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/voice/stream?sample_rate=${TARGET}&utterance_end_ms=${SILENCE_MS}`);
    ws.binaryType = "arraybuffer";
    finalTranscriptRef.current = "";
    streamReadyRef.current = false;

    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    // Route through a muted sink so onaudioprocess fires without echoing the
    // mic to the speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);

    let levelTick = 0;
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN || !streamReadyRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      // Linear-interpolate resample input@srcRate → 16 kHz Int16 PCM.
      const out = new Int16Array(Math.ceil(input.length / ratio) + 2);
      let oi = 0;
      let pos = rsPos;
      while (pos < input.length) {
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        const s = input[i0] * (1 - frac) + input[i1] * frac;
        const v = Math.max(-1, Math.min(1, s));
        out[oi++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        pos += ratio;
      }
      rsPos = pos - input.length; // carry remainder into the next buffer
      if (oi > 0) { try { ws.send(out.slice(0, oi).buffer); } catch {} }
      if (++levelTick % 3 === 0) setLevel(Math.min(1, Math.sqrt(sum / input.length) * 4));
    };

    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!m) return;
      if (m.type === "ready") { streamReadyRef.current = true; }
      else if (m.type === "transcript") { if (m.text) setInterim(m.text); }
      else if (m.type === "utterance_end") { finalizeUtterance(m.transcript || ""); }
      else if (m.type === "error") { stopStreaming(); setVoiceState("idle"); }
    };
    ws.onerror = () => { stopStreaming(); setVoiceState("idle"); };
    ws.onclose = () => { if (voiceStateRef.current === "listening") { /* server/proxy dropped */ } };

    streamRef.current = { ws, ctx, proc, src, stream, sink };
    setVoiceState("listening");
  }, [finalizeUtterance, stopStreaming, setVoiceState]);

  // Arm: wait a couple of seconds after the agent's voice finishes, with a
  // visible, cancellable countdown, then open the mic.
  const cancelArm = useCallback(() => {
    if (armTimerRef.current) { clearInterval(armTimerRef.current); armTimerRef.current = null; }
    setArmCountdown(0);
    setVoiceState("idle");
  }, [setVoiceState]);

  const arm = useCallback(() => {
    if (armTimerRef.current) clearInterval(armTimerRef.current);
    setVoiceState("arming");
    let n = 2;
    setArmCountdown(n);
    armTimerRef.current = setInterval(() => {
      n -= 1;
      setArmCountdown(n);
      if (n <= 0) {
        if (armTimerRef.current) clearInterval(armTimerRef.current);
        armTimerRef.current = null;
        void startStreaming();
      }
    }, 1000);
  }, [startStreaming, setVoiceState]);

  // Text-to-speech: ask the voice Fitting (via the same-origin proxy) to speak
  // `text`, then play it. When auto=true (read-aloud of a reply) and hands-free
  // is on, re-arm the mic once playback ends — never while it is still playing.
  const speak = useCallback(async (text: string, opts?: { auto?: boolean }) => {
    const clean = (text || "").trim();
    if (!clean) return;
    const onDone = () => {
      if (opts?.auto && handsFreeRef.current) arm();
      else if (voiceStateRef.current === "speaking") setVoiceState("idle");
    };
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean })
      });
      if (!res.ok) { onDone(); return; }
      const blob = await res.blob();
      if (!blob.size) { onDone(); return; }
      const objectUrl = URL.createObjectURL(blob);
      if (audioUrlRef.current) { try { URL.revokeObjectURL(audioUrlRef.current); } catch {} }
      audioUrlRef.current = objectUrl;
      // Reuse the (gesture-unlocked) element so auto-play works on mobile
      // without the user first tapping a speaker.
      const audio = getAudio();
      try { audio.pause(); } catch {}
      audio.muted = false;
      audio.src = objectUrl;
      if (opts?.auto) setVoiceState("speaking");
      audio.onended = () => { onDone(); };
      audio.onerror = () => { onDone(); };
      audio.play().catch(() => { onDone(); });
    } catch {
      onDone();
    }
  }, [arm, setVoiceState, getAudio]);

  // History + live event stream.
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));
    es.addEventListener("event", (raw: MessageEvent) => {
      // Active send: /api/chat is the source of truth for the current turn;
      // ring-buffer events would duplicate it.
      if (sendingRef.current) return;
      let wrapped: any;
      try { wrapped = JSON.parse(raw.data); } catch { return; }
      const text = extractTextFromAssistantEvent(wrapped);
      if (!text) return;
      const sessionId = wrapped?.session_id ?? null;
      // Skip events from sessions we've already consumed via /api/chat in
      // this tab. (Other tabs that didn't send would still see them on
      // their own /api/stream; that's correct cross-tab behavior.)
      if (sessionId && consumedSessionsRef.current.has(sessionId)) return;
      const bubbleId = lastAssistantBySessionRef.current.get(sessionId ?? "_") ?? null;
      setMessages((prev) => {
        if (bubbleId) {
          const idx = prev.findIndex((m) => m.id === bubbleId);
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { ...next[idx], content: next[idx].content + text };
            return next;
          }
        }
        const id = genId("a");
        if (sessionId) lastAssistantBySessionRef.current.set(sessionId, id);
        lastAssistantBySessionRef.current.set("_", id);
        return [...prev, { id, role: "assistant", content: text, sessionId, streaming: false }];
      });
    });
    return () => es.close();
  }, []);

  // Auto-scroll on new content.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-resize textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [composing]);

  const send = useCallback(async (explicitMessage?: string) => {
    const message = (typeof explicitMessage === "string" ? explicitMessage : composing).trim();
    if (!message || sending) return;
    setSending(true);
    sendingRef.current = true;
    setMessages((prev) => [...prev, { id: genId("u"), role: "user", content: message }]);
    setComposing("");
    // Reset the bubble fallback so /api/stream doesn't keep appending into
    // the previous turn's bubble. Per-session ids still group multi-session
    // traffic correctly.
    lastAssistantBySessionRef.current.delete("_");
    const bubbleId = genId("a");
    // Mark this bubble as "owned by /api/chat".
    sendBubbleIdsRef.current.add(bubbleId);
    setMessages((prev) => [...prev, { id: bubbleId, role: "assistant", content: "", streaming: true }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message })
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "";
        setMessages((prev) => prev.map((m) => m.id === bubbleId
          ? { ...m, role: "error", content: `gateway ${res.status}: ${text}`, streaming: false }
          : m));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Track the reply text locally — setMessages updaters run deferred, so we
      // can't read the final content back out of them synchronously (e.g. to
      // hand to read-aloud on `done`).
      let assembled = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines. Parse all complete events.
        let sepIdx;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sepIdx);
          buf = buf.slice(sepIdx + 2);
          const ev = parseSseEvent(rawEvent);
          if (!ev) continue;
          if (ev.event === "chunk" && typeof ev.data?.text === "string") {
            const text = ev.data.text;
            assembled += text;
            setMessages((prev) => prev.map((m) => m.id === bubbleId
              ? { ...m, content: m.content + text }
              : m));
          } else if (ev.event === "error") {
            setMessages((prev) => prev.map((m) => m.id === bubbleId
              ? { ...m, role: "error", content: m.content || (ev.data?.error ?? "unknown error"), streaming: false }
              : m));
          } else if (ev.event === "done") {
            // If no chunks arrived (e.g. legacy gateway returns only a final
            // reply in `done`), fall back to it so the bubble has content.
            const finalReply = typeof ev.data?.reply === "string" ? ev.data.reply : "";
            const sid = typeof ev.data?.session_id === "string" ? ev.data.session_id : "";
            if (sid) consumedSessionsRef.current.add(sid);
            const finalContent = assembled || finalReply;
            setMessages((prev) => prev.map((m) =>
              m.id === bubbleId ? { ...m, content: m.content || finalReply, streaming: false } : m
            ));
            // "Read aloud" toggle: speak the completed reply (never per-chunk).
            // auto:true lets hands-free re-arm the mic after playback ends.
            if (readAloudRef.current && finalContent.trim()) {
              void speak(finalContent, { auto: true });
            }
          }
        }
      }
    } catch (err: any) {
      setMessages((prev) => prev.map((m) => m.id === bubbleId
        ? { ...m, role: "error", content: `network: ${err?.message || String(err)}`, streaming: false }
        : m));
    } finally {
      setMessages((prev) => prev.map((m) => m.id === bubbleId ? { ...m, streaming: false } : m));
      setSending(false);
      sendingRef.current = false;
    }
  }, [composing, sending, speak]);

  // Let streaming helpers call the latest send() without a dependency cycle.
  useEffect(() => { sendRef.current = send; }, [send]);

  // Clean up the capture graph + timers on unmount.
  useEffect(() => () => {
    if (armTimerRef.current) clearInterval(armTimerRef.current);
    stopStreaming();
    try { audioRef.current?.pause(); } catch {}
    if (audioUrlRef.current) { try { URL.revokeObjectURL(audioUrlRef.current); } catch {} }
  }, [stopStreaming]);

  // The mic control, interpreted against the voice state machine. Streaming is
  // primary; the batch MediaRecorder path is the fallback when streaming isn't
  // supported. Tapping the mic is always an interrupt/abort — it never sends;
  // auto-send happens only on Deepgram silence endpointing.
  const micAction = useCallback(() => {
    primeAudio(); // unlock mobile audio on this gesture (for later read-aloud)
    if (!streamingSupported) { void toggleRecording(); return; }
    switch (voiceStateRef.current) {
      case "idle": void startStreaming(); break;
      case "arming": cancelArm(); break;
      case "listening": stopStreaming(); setVoiceState("idle"); break;
      case "speaking":
        try { audioRef.current?.pause(); } catch {}
        setVoiceState("idle");
        break;
    }
  // NB: toggleRecording is intentionally omitted from deps — it's declared
  // below (TDZ) and only referenced when invoked, well after render.
  }, [streamingSupported, startStreaming, cancelArm, stopStreaming, setVoiceState, primeAudio]);

  // Push-to-talk fallback (batch). Click once to start recording from the mic,
  // click again to stop; on stop we POST the captured audio to /api/voice/stt
  // and auto-send the transcript. Used only when streaming isn't supported.
  const toggleRecording = useCallback(async () => {
    // Gate on the ref, not `recording` state: micAction memoizes over this
    // callback (see its NB), so a state read here would be stale-false on the
    // stop tap and start a second recorder instead of stopping the first.
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
      return;
    }
    if (!micCaptureAllowed()) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // permission denied / no device
    }
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      setRecording(false);
      stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      const type = mr.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (!blob.size) return;
      try {
        const res = await fetch("/api/voice/stt", {
          method: "POST",
          headers: { "Content-Type": type },
          body: blob
        });
        if (!res.ok) return;
        const data = await res.json();
        const transcript = typeof data?.transcript === "string" ? data.transcript.trim() : "";
        if (transcript) {
          setComposing(transcript);
          void send(transcript);
        }
      } catch {
        // STT best-effort.
      }
    };
    mr.start();
    setRecording(true);
  }, [send]);

  const onKeyDown = useCallback((ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key !== "Enter") return;
    // Mobile virtual keyboard: Enter inserts newline (no shift on touch).
    // Hardware keyboard (where shift is reliably present): Enter sends, Shift+Enter newlines.
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    if (isCoarse) return;
    if (ev.shiftKey) return;
    ev.preventDefault();
    primeAudio();
    send();
  }, [send, primeAudio]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          Garrison
          <small>{connected ? "connected" : "disconnected"} · channel: web</small>
        </div>
        <div className="app-actions">
          {voice.available ? (
            <button
              type="button"
              className={`voice-toggle${readAloud ? " on" : ""}`}
              role="switch"
              aria-checked={readAloud}
              data-testid="read-aloud-toggle"
              title={readAloud ? "Read replies aloud: on" : "Read replies aloud: off"}
              onClick={() => { primeAudio(); setReadAloud((v) => !v); }}
            >
              <SpeakerIcon />
              <span>Read aloud</span>
            </button>
          ) : null}
          {streamingSupported ? (
            <button
              type="button"
              className={`voice-toggle${autoSend ? " on" : ""}`}
              role="switch"
              aria-checked={autoSend}
              data-testid="auto-send-toggle"
              title="Auto-send when you stop talking (silence detection)"
              onClick={() => setAutoSend((v) => !v)}
            >
              <span>Auto-send</span>
            </button>
          ) : null}
          {streamingSupported ? (
            <button
              type="button"
              className={`voice-toggle${handsFree ? " on" : ""}`}
              role="switch"
              aria-checked={handsFree}
              data-testid="hands-free-toggle"
              title="Hands-free: listen again automatically after each spoken reply"
              onClick={() => { primeAudio(); setHandsFree((v) => {
                const next = !v;
                // Hands-free needs an agent voice to listen after, so enabling it
                // turns read-aloud on too.
                if (next) setReadAloud(true);
                return next;
              }); }}
            >
              <span>Hands-free</span>
            </button>
          ) : null}
          {monitor.available && monitor.url
            ? <a href={monitor.url} target="_blank" rel="noopener noreferrer">Monitor</a>
            : null}
        </div>
      </header>
      <div className="history-banner">
        Recent replies only — user turns from before this session aren't replayed.
      </div>
      <div className="messages" ref={messagesRef}>
        {messages.length === 0
          ? <div className="empty-state">No messages yet. Say hi.</div>
          : messages.map((m) => (
              <MessageBubble key={m.id} message={m} onSpeak={voice.available ? speak : undefined} />
            ))}
      </div>
      {voiceState !== "idle" ? (
        <div className={`voice-status voice-status-${voiceState}`} data-testid="voice-status" data-state={voiceState}>
          {voiceState === "arming" ? (
            <span className="vs-line">
              <span className="vs-dot arming" /> Listening in {armCountdown}s… <span className="vs-hint">tap mic to cancel</span>
            </span>
          ) : voiceState === "listening" ? (
            <span className="vs-line">
              <span className="vs-dot listening" />
              <span className="vs-level"><i style={{ transform: `scaleX(${0.15 + level * 0.85})` }} /></span>
              <span className="vs-text">{interim ? interim : "Listening… speak now"}</span>
              <span className="vs-hint">tap mic to stop</span>
            </span>
          ) : (
            <span className="vs-line"><span className="vs-dot speaking" /> Speaking…</span>
          )}
        </div>
      ) : null}
      <div className="composer">
        {voice.available ? (
          <button
            type="button"
            className={`mic-button state-${voiceState}${recording ? " recording" : ""}`}
            title={!micCaptureAllowed()
              ? "Mic needs a secure context (https or localhost)"
              : recording ? "Stop recording"
              : voiceState === "listening" ? "Stop listening"
              : voiceState === "arming" ? "Cancel"
              : voiceState === "speaking" ? "Stop"
              : "Talk"}
            aria-label="Voice"
            aria-pressed={voiceState === "listening" || recording}
            data-testid="mic-button"
            disabled={!micCaptureAllowed() || (sending && voiceState === "idle")}
            onClick={micAction}
          >
            <MicIcon />
          </button>
        ) : null}
        <textarea
          ref={textareaRef}
          value={composing}
          onChange={(e) => setComposing(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={voiceState === "listening" ? "Listening…" : "Message Gary…"}
          rows={1}
          autoFocus
        />
        <button className="send-button" onClick={() => { primeAudio(); send(); }} disabled={sending || !composing.trim()}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
