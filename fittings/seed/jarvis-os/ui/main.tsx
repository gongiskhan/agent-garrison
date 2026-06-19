// Jarvis Agentic OS — voice-first HUD.
//
// Visual layer (DitherCore + ReportOverlay) is reused from the Fable jarvis-hud
// reference. The voice + transport logic is the Garrison-native path proven by
// web-channel/legacy-voice: hold-to-talk → /api/voice/stt → /api/chat (gateway
// → Orchestrator) → reply read aloud via /api/voice/tts. The central core
// pulses to the live audio through a real AnalyserNode RMS fed into getLevel.

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import DitherCore, { type CoreMode } from "./cores/DitherCore";
import ReportOverlay from "./ReportOverlay";

// ── helpers ────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// getUserMedia/MediaRecorder need a secure context. localhost counts; a LAN IP
// over plain http does not (use the Fitting's tls_cert/tls_key there).
function micCaptureAllowed(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined"
  );
}

function parseSseEvent(raw: string): { event: string; data: any } | null {
  let event = "message";
  let dataText = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataText += (dataText ? "\n" : "") + line.slice(5).trim();
  }
  if (!dataText) return { event, data: null };
  try { return { event, data: JSON.parse(dataText) }; }
  catch { return { event, data: dataText }; }
}

// Strip the orchestrator's load-bearing control tokens from text shown to the
// user / read aloud. `[orchestrator-active]` (and `[gateway-route:…]`) are a
// liveness/route contract for the gateway + integration-check.mjs — they must
// stay in the model's reply but must never be spoken or displayed.
function stripMarkers(s: string): string {
  return (s || "")
    .replace(/\[orchestrator-active\]/gi, "")
    .replace(/\[gateway-route:[^\]]*\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Turn = { id: string; role: "user" | "assistant" | "error"; content: string };
type Callout = { id: string; label: string; content: string };

// ── component ────────────────────────────────────────────────────────────────

function App() {
  const [mode, setModeRaw] = useState<CoreMode>("idle");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [interim, setInterim] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);

  const modeRef = useRef<CoreMode>("idle");
  const setMode = useCallback((m: CoreMode) => { modeRef.current = m; setModeRaw(m); }, []);

  // Audio analysis uses TWO separate analysers. Critical: the mic analyser is
  // NEVER connected to ctx.destination — routing the mic to the speakers would
  // feed it back and the STT would hear the user's own echo. Only the TTS
  // analyser sits in the playback path (→ destination). getLevel reads whichever
  // matches the current mode.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  // Uint8Array<ArrayBuffer> (not ArrayBufferLike) so getByteFrequencyData accepts it.
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const ttsSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sendingRef = useRef(false);
  // Sentence-level TTS queue: speak each sentence as soon as it is generated
  // (don't wait for the whole reply), playing them back-to-back. This overlaps
  // synth with generation so the first words come out ~as soon as the model
  // finishes the first sentence.
  const speakQueueRef = useRef<string[]>([]);
  const speakingRef = useRef(false);

  const getCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current!;
  }, []);

  // Lazily create an analyser into the given ref (shared 128-bin data buffer).
  const ensureAnalyser = useCallback((ref: { current: AnalyserNode | null }) => {
    if (!ref.current) {
      const an = getCtx().createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.7;
      ref.current = an;
      if (!analyserDataRef.current) analyserDataRef.current = new Uint8Array(new ArrayBuffer(an.frequencyBinCount));
    }
    return ref.current;
  }, [getCtx]);

  // Real audio envelope 0..1; reads the analyser matching the current mode.
  const getLevel = useCallback(() => {
    const data = analyserDataRef.current;
    const m = modeRef.current;
    const an = m === "listening" ? micAnalyserRef.current : m === "speaking" ? ttsAnalyserRef.current : null;
    if (!an || !data) return null;
    an.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = data[i] / 255; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / data.length) * 1.8);
  }, []);

  // discover the voice Fitting (local-voice / deepgram-voice) via the proxy
  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((info) => setVoiceAvailable(Boolean(info?.available)))
      .catch(() => setVoiceAvailable(false));
  }, []);

  const pushCallout = useCallback((label: string, content: string) => {
    const id = genId("c");
    setCallouts((prev) => [...prev.slice(-2), { id, label, content }]);
    setTimeout(() => setCallouts((prev) => prev.filter((c) => c.id !== id)), 9000);
  }, []);

  // TTS: ask the voice Fitting (same-origin proxy) to speak, route it through
  // the analyser so the core pulses, and return to idle when playback ends.
  // Play the next queued sentence. Each sentence streams progressively from the
  // GET TTS endpoint (one growing WAV → browser starts after the first audio
  // bytes). When the queue drains, return to idle.
  const playNextInQueue = useCallback(() => {
    const next = speakQueueRef.current.shift();
    if (next === undefined) {
      speakingRef.current = false;
      if (modeRef.current === "speaking") setMode("idle");
      return;
    }
    speakingRef.current = true;
    if (!audioElRef.current) audioElRef.current = new Audio();
    const audio = audioElRef.current;
    // createMediaElementSource can only run once per element; reuse it.
    try {
      if (!ttsSourceRef.current) {
        const src = getCtx().createMediaElementSource(audio);
        const an = ensureAnalyser(ttsAnalyserRef);
        src.connect(an);
        an.connect(getCtx().destination); // only the TTS path reaches the speakers
        ttsSourceRef.current = src;
      }
      void getCtx().resume();
    } catch {}
    setMode("speaking");
    audio.src = "/api/voice/tts?text=" + encodeURIComponent(next);
    audio.onended = () => playNextInQueue();
    audio.onerror = () => playNextInQueue();
    audio.play().catch(() => playNextInQueue());
  }, [setMode, getCtx, ensureAnalyser]);

  // Enqueue a sentence and start playback if idle.
  const enqueueSpeech = useCallback((text: string) => {
    const clean = stripMarkers(text || "");
    if (!clean || !voiceAvailable) return;
    speakQueueRef.current.push(clean);
    if (!speakingRef.current) playNextInQueue();
  }, [voiceAvailable, playNextInQueue]);

  // Stop any in-flight speech and clear the queue (new turn interrupts the old).
  const stopSpeech = useCallback(() => {
    speakQueueRef.current = [];
    speakingRef.current = false;
    const audio = audioElRef.current;
    if (audio) { try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {} }
  }, []);

  // Send a turn to the Operative through the gateway, stream the reply, then
  // read it aloud. Mirrors web-channel's /api/chat SSE handling.
  const send = useCallback(async (message: string) => {
    const msg = (message || "").trim();
    if (!msg || sendingRef.current) return;
    sendingRef.current = true;
    stopSpeech(); // a new turn interrupts any in-flight speech
    setTurns((prev) => [...prev.slice(-6), { id: genId("u"), role: "user", content: msg }]);
    setInterim("");
    setMode("working");
    const bubbleId = genId("a");
    setTurns((prev) => [...prev, { id: bubbleId, role: "assistant", content: "" }]);
    let assembled = "";
    let spokenUpTo = 0; // index in `assembled` already handed to the TTS queue
    // Hand every COMPLETE sentence in `assembled` (past spokenUpTo) to the TTS
    // queue. On `final`, flush whatever remains. Speaking the first sentence the
    // moment it lands — rather than at end-of-reply — removes the bulk of the
    // text→speech delay.
    const flushSentences = (final: boolean) => {
      const pending = assembled.slice(spokenUpTo);
      if (final) {
        const rest = pending.trim();
        if (rest) { enqueueSpeech(rest); spokenUpTo = assembled.length; }
        return;
      }
      const re = /[.!?…](?:["'")\]]+)?(?:\s|$)/g;
      let lastEnd = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pending)) !== null) lastEnd = m.index + m[0].length;
      if (lastEnd > 0) {
        const chunk = pending.slice(0, lastEnd).trim();
        if (chunk) { enqueueSpeech(chunk); spokenUpTo += lastEnd; }
      }
    };
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: msg })
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "";
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `gateway ${res.status}: ${text}` } : t));
        setMode("error");
        setTimeout(() => { if (modeRef.current === "error") setMode("idle"); }, 2500);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = parseSseEvent(rawEvent);
          if (!ev) continue;
          if (ev.event === "chunk" && typeof ev.data?.text === "string") {
            assembled += ev.data.text;
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, content: t.content + ev.data.text } : t));
            flushSentences(false); // speak each sentence as soon as it completes
          } else if (ev.event === "error") {
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, role: "error", content: t.content || (ev.data?.error ?? "error") } : t));
          } else if (ev.event === "done") {
            const finalReply = typeof ev.data?.reply === "string" ? ev.data.reply : "";
            if (!assembled && finalReply) assembled = finalReply;
            const finalContent = stripMarkers(assembled);
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, content: stripMarkers(t.content || finalReply) } : t));
            if (finalContent) {
              pushCallout("reply", finalContent);
              flushSentences(true); // speak any trailing partial sentence
              if (!speakingRef.current) setMode("idle");
            } else {
              setMode("idle");
            }
          }
        }
      }
    } catch (err: any) {
      setTurns((prev) => prev.map((t) => t.id === bubbleId
        ? { ...t, role: "error", content: `network: ${err?.message || String(err)}` } : t));
      setMode("idle");
    } finally {
      sendingRef.current = false;
    }
  }, [setMode, enqueueSpeech, stopSpeech, pushCallout]);

  // ── push-to-talk (hold Space / hold the core) — batch STT ────────────────

  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
  }, []);

  const startListening = useCallback(async () => {
    if (modeRef.current === "listening" || sendingRef.current) return;
    if (!voiceAvailable || !micCaptureAllowed()) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch {
      return;
    }
    micStreamRef.current = stream;
    // analyser over the mic so the core pulses while you speak
    try {
      await getCtx().resume();
      const src = getCtx().createMediaStreamSource(stream);
      // Mic → mic analyser ONLY. Never connect this to ctx.destination, or the
      // mic would play back through the speakers and echo into the STT.
      src.connect(ensureAnalyser(micAnalyserRef));
      micSourceRef.current = src;
    } catch {}
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      mediaRecorderRef.current = null;
      try { micSourceRef.current?.disconnect(); } catch {}
      micSourceRef.current = null;
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      micStreamRef.current = null;
      const type = mr.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (!blob.size) { setMode("idle"); return; }
      setMode("working");
      try {
        const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": type }, body: blob });
        if (!res.ok) { setMode("idle"); return; }
        const data = await res.json();
        const transcript = typeof data?.transcript === "string" ? data.transcript.trim() : "";
        // loop-safety: drop empty / sub-word transcripts (mic into ambient noise)
        if (transcript && transcript.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2) {
          void send(transcript);
        } else {
          setMode("idle");
        }
      } catch {
        setMode("idle");
      }
    };
    mr.start();
    setMode("listening");
  }, [voiceAvailable, setMode, getCtx, ensureAnalyser, send]);

  // Hold Space to talk (ignore auto-repeat and when typing in a field).
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      if (report) return;
      e.preventDefault();
      if (modeRef.current === "speaking") { try { audioElRef.current?.pause(); } catch {} setMode("idle"); return; }
      if (modeRef.current === "idle") void startListening();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      if (modeRef.current === "listening") stopListening();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setReport(null); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("keydown", onEsc);
    };
  }, [startListening, stopListening, setMode, report]);

  // Pointer push-to-talk on the core: press to listen, release to send.
  const onCorePointerDown = useCallback(() => {
    if (modeRef.current === "speaking") { try { audioElRef.current?.pause(); } catch {} setMode("idle"); return; }
    if (modeRef.current === "idle") void startListening();
  }, [startListening, setMode]);
  const onCorePointerUp = useCallback(() => {
    if (modeRef.current === "listening") stopListening();
  }, [stopListening]);

  useEffect(() => () => {
    try { mediaRecorderRef.current?.stop(); } catch {}
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    try { audioElRef.current?.pause(); } catch {}
    if (audioUrlRef.current) { try { URL.revokeObjectURL(audioUrlRef.current); } catch {} }
    try { audioCtxRef.current?.close(); } catch {}
  }, []);

  const statusLabel = !voiceAvailable
    ? "No voice Fitting — station local-voice"
    : mode === "listening" ? (interim || "Listening…")
    : mode === "working" ? "Thinking…"
    : mode === "speaking" ? "Speaking…"
    : mode === "error" ? "Error"
    : micCaptureAllowed() ? "Hold Space (or the core) to talk" : "Mic needs https or localhost";

  return (
    <div className={`jarvis-root state-${mode}`}>
      <div
        className="jarvis-core"
        onPointerDown={onCorePointerDown}
        onPointerUp={onCorePointerUp}
        onPointerLeave={onCorePointerUp}
        role="button"
        aria-label="Push to talk"
      >
        <DitherCore mode={mode} getLevel={getLevel} />
      </div>

      <div className="jarvis-status" data-state={mode}>
        <span className={`jarvis-dot ${mode}`} />
        <span className="jarvis-status-text">{statusLabel}</span>
      </div>

      <div className="jarvis-callouts">
        {callouts.map((c) => (
          <button key={c.id} className="jarvis-callout" onClick={() => setReport({ path: c.label, content: c.content })}>
            <span className="jarvis-callout-dot" />
            <span className="jarvis-callout-label">{c.label}</span>
            <span className="jarvis-callout-text">{c.content.slice(0, 120)}</span>
          </button>
        ))}
      </div>

      <div className="jarvis-transcript">
        {turns.slice(-4).map((t) => (
          <div key={t.id} className={`jarvis-turn ${t.role}`}>
            <span className="jarvis-turn-role">{t.role === "user" ? "you" : t.role === "error" ? "!" : "jarvis"}</span>
            <span className="jarvis-turn-text">{t.content || (t.role === "assistant" ? "…" : "")}</span>
          </div>
        ))}
      </div>

      {report ? <ReportOverlay report={report} onClose={() => setReport(null)} /> : null}
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
