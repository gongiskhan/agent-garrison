// Jarvis Agentic OS — voice-first HUD.
//
// Visual layer (DitherCore + ReportOverlay) is reused from the Fable jarvis-hud
// reference. The voice + transport logic is the Garrison-native path:
// hands-free voice session → Silero VAD (local, in-browser, @ricky0123/vad-web)
// detects end-of-speech → /api/voice/stt → /api/chat (gateway → Orchestrator) →
// reply read aloud via /api/voice/tts. Press once (Space or tap the core) to
// arm the session; then just talk — each pause auto-sends and Jarvis replies,
// and the session re-arms itself between turns until you press again to stop.
// The central core pulses to the live audio through a real AnalyserNode RMS.

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import { marked } from "marked";
import DitherCore, { type CoreMode } from "./cores/DitherCore";
import ReportOverlay from "./ReportOverlay";

marked.setOptions({ gfm: true, breaks: true });
// Render an assistant reply's markdown to HTML for the transcript. Content is the
// local operative's own output (single-user, localhost), so we render directly.
function renderMarkdown(s: string): string {
  try { return marked.parse(s || "", { async: false }) as string; } catch { return s; }
}

// ── helpers ────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Encode a mono Float32 PCM buffer (the speech segment Silero VAD hands back at
// 16 kHz) as a 16-bit WAV blob. faster-whisper (PyAV) on the /stt endpoint
// decodes WAV directly, so we ship the VAD's exact segment with no re-recording.
function float32ToWavBlob(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);  // PCM fmt chunk size
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sr * blockAlign)
  view.setUint16(32, 2, true);   // block align
  view.setUint16(34, 16, true);  // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
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

// Clean text shown to the user. Removes the orchestrator's load-bearing control
// tokens ([orchestrator-active], [gateway-route:…], [delegated] — they must stay
// in the model's reply but never be displayed/spoken) and the tool-call / TUI
// echoes the PTY screen-scrape leaks into a Soul's reply (e.g.
// `Web Search("…") ⎿ Did 1 search in 5s`). URLs are kept here (visible on screen).
function stripMarkers(s: string): string {
  return (s || "")
    .replace(/\[orchestrator-active\]/gi, "")
    .replace(/\[gateway-route:[^\]]*\]/gi, "")
    .replace(/\[delegated\]/gi, "")
    // tool-call invocations + result framing leaked from the Claude Code TUI
    .replace(/\b(?:Web\s*Search|WebFetch|Bash|Read|Write|Edit|Grep|Glob|Task)\s*\([^)]*\)/gi, "")
    .replace(/\bDid \d+ search(?:es)? in \d+(?:\.\d+)?\s*s\b/gi, "")
    .replace(/[⎿└├│─╰╭╮╯┌┐┘┴┬┤┼▌▐]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Speakable form: strip everything that reads terribly aloud — markdown
// formatting, fenced code / file-trees, emojis, citation lists, URLs — leaving
// just the prose. The on-screen text (stripMarkers) keeps the full markdown.
// Long answers are capped to a sentence boundary with a spoken pointer to the
// screen, so structured replies (a file tree, a code dump) become a short spoken
// summary instead of Jarvis reading every "#", "/" and "*".
const SPEAK_CAP = 700;
function toSpeakable(s: string): string {
  let t = stripMarkers(s)
    .replace(/```[\s\S]*?```/g, " ")                      // fenced code / file trees → drop
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/\n*\s*Sources?\s*:[\s\S]*$/i, "")           // trailing citations block
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")            // md image/link → label
    .replace(/`([^`]+)`/g, "$1")                          // inline code → text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")                   // heading hashes
    .replace(/^\s*>\s?/gm, "")                            // blockquotes
    .replace(/^\s*[-*+•]\s+/gm, "")                       // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "")                        // numbered list markers
    .replace(/(\*\*|__|\*|_|~~)/g, "")                    // bold/italic/strike
    .replace(/\|/g, " ")                                  // table pipes
    // emojis & dingbats & arrows & box-drawing
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")                    // bare urls
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (t.length > SPEAK_CAP) {
    const cut = t.slice(0, SPEAK_CAP);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
    t = (stop > 200 ? cut.slice(0, stop + 1) : cut).trim() + " … o resto está no ecrã.";
  }
  return t;
}

// Extra silence (ms) held AFTER a spoken sentence before the next one starts,
// on TOP of the per-sentence pause the voice server already appends. A blank
// line (paragraph / topic change) gets the longer beat; a single line break a
// shorter one. Tune to taste.
const PARA_GAP_MS = 320;
const LINE_GAP_MS = 150;

// Pull COMPLETE sentences from `text` starting at index `from` — a sentence ends
// at . ! ? … (optionally a closing quote/bracket) plus whitespace, so a still-
// growing final sentence stays buffered until its terminator streams in (or the
// turn's `done` flush). Lets TTS speak sentence-by-sentence as the model streams,
// instead of waiting for the whole reply. Each sentence carries the extra pause
// (gapMs) implied by the whitespace that ended it — a blank line after the
// sentence means a topic change, so it breathes longer. Returns the sentences +
// advanced cursor.
function takeSentences(text: string, from: number): { sentences: { text: string; gapMs: number }[]; cursor: number } {
  const re = /[.!?…]+[)\]"'”’»]?(\s+)/g;
  re.lastIndex = Math.max(0, from);
  const sentences: { text: string; gapMs: number }[] = [];
  let cursor = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const piece = text.slice(cursor, end).trim();
    const sep = m[1] || "";
    const newlines = (sep.match(/\n/g) || []).length;
    const gapMs = newlines >= 2 ? PARA_GAP_MS : newlines === 1 ? LINE_GAP_MS : 0;
    if (piece) sentences.push({ text: piece, gapMs });
    cursor = end;
  }
  return { sentences, cursor };
}

type Turn = { id: string; role: "user" | "assistant" | "error"; content: string };
type Callout = { id: string; label: string; content: string };
type Activity = { id: string; tool: string; detail: string };

// Friendly verb for a tool name in the "now" feed; falls back to a normalised
// form of the raw name (MCP tools arrive as `mcp__<server>__<tool>`).
const TOOL_VERB: Record<string, string> = {
  WebSearch: "search web", WebFetch: "fetch page", Bash: "shell",
  Read: "read", Write: "write", Edit: "edit", NotebookEdit: "edit notebook",
  Grep: "search code", Glob: "find files", Task: "delegate", ToolSearch: "find tool",
  talk_to: "delegate", list_active_sessions: "check sessions",
};
function toolVerb(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, "").replace(/^mcp__/, "");
  return (
    TOOL_VERB[name] ||
    TOOL_VERB[bare] ||
    bare.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").toLowerCase().trim()
  );
}

// ── component ────────────────────────────────────────────────────────────────

function App() {
  const [mode, setModeRaw] = useState<CoreMode>("idle");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [sessionOn, setSessionOnRaw] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  // Live "what Jarvis is doing" — tool calls of the current turn, newest last.
  const [activity, setActivity] = useState<Activity[]>([]);

  // Scrollable transcript: keep the newest turn in view, but only auto-scroll
  // when the user is already near the bottom — so scrolling up to read history
  // is not yanked back down by an incoming turn.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const modeRef = useRef<CoreMode>("idle");
  const setMode = useCallback((m: CoreMode) => { modeRef.current = m; setModeRaw(m); }, []);
  // Whether the hands-free voice session is armed (mirrored to a ref so the
  // VAD callbacks and key handlers read the live value without stale closures).
  const sessionOnRef = useRef(false);
  const setSessionOn = useCallback((v: boolean) => { sessionOnRef.current = v; setSessionOnRaw(v); }, []);

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
  // Silero VAD instance + whether it is currently feeding frames to the model.
  // We pause it during a turn (think + speak) so it never captures Jarvis's own
  // TTS, and resume it when we return to idle.
  const vadRef = useRef<MicVAD | null>(null);
  const vadRunningRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sendingRef = useRef(false);
  // Sentence-level TTS queue: speak each sentence as soon as it is generated
  // (don't wait for the whole reply), playing them back-to-back. This overlaps
  // synth with generation so the first words come out ~as soon as the model
  // finishes the first sentence.
  // Each item carries an optional extra silence (ms) to hold AFTER it before the
  // next plays — a topic/paragraph change gets a longer beat than a plain
  // sentence, so a multi-part answer doesn't run together.
  const speakQueueRef = useRef<{ text: string; gapMs: number }[]>([]);
  const speakingRef = useRef(false);
  // Delegated Soul replies arrive asynchronously on the channel stream. The
  // stream is subscribed live (?live=1, no ring replay), so the only guard needed
  // is to not speak anything before the user has actually engaged.
  const hasInteractedRef = useRef(false);

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

  // ── VAD pause/resume + turn end ──────────────────────────────────────────
  // Stop feeding mic frames to the VAD without releasing the mic (pauseStream is
  // a no-op below, so the stream + analyser stay live). pause() also resets the
  // model's state, which is what we want between turns.
  const pauseVad = useCallback(() => {
    if (vadRef.current && vadRunningRef.current) {
      vadRunningRef.current = false;
      console.debug("[vad] pause");
      try { void vadRef.current.pause(); } catch (e) { console.debug("[vad] pause err", e); }
    }
  }, []);
  const resumeVad = useCallback(() => {
    if (vadRef.current && sessionOnRef.current && !vadRunningRef.current) {
      vadRunningRef.current = true;
      console.debug("[vad] resume");
      try { void vadRef.current.start(); } catch (e) { console.debug("[vad] resume err", e); }
    }
  }, []);

  // Re-arm the VAD only when a turn is TRULY over: nothing still streaming from
  // the gateway, the speech queue is empty, and no sentence is currently playing.
  // Critical: the TTS queue drains and refills BETWEEN sentences of one reply, so
  // re-arming on every transient "queue empty" would resume the VAD mid-reply and
  // make it capture Jarvis's own voice — which then breaks the NEXT turn's
  // end-of-speech detection. This single gated check is the fix for that.
  const endTurnIfDone = useCallback(() => {
    if (sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0) return;
    if (sessionOnRef.current) { resumeVad(); setMode("listening"); }
    else setMode("idle");
  }, [resumeVad, setMode]);

  // TTS: ask the voice Fitting (same-origin proxy) to speak, route it through
  // the analyser so the core pulses, and return to idle when playback ends.
  // Play the next queued sentence. Each sentence streams progressively from the
  // GET TTS endpoint (one growing WAV → browser starts after the first audio
  // bytes). When the queue drains, return to idle.
  const playNextInQueue = useCallback(() => {
    const next = speakQueueRef.current.shift();
    if (next === undefined) {
      speakingRef.current = false;
      endTurnIfDone(); // re-arm only if the whole turn is done (not between sentences)
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
    // Hold the item's extra silence AFTER playback before the next sentence, so a
    // topic change lands as a real beat rather than butting up to the next line.
    const afterEnd = () => { if (next.gapMs > 0) window.setTimeout(playNextInQueue, next.gapMs); else playNextInQueue(); };
    audio.src = "/api/voice/tts?text=" + encodeURIComponent(next.text);
    audio.onended = afterEnd;
    audio.onerror = () => playNextInQueue();
    audio.play().catch(() => playNextInQueue());
  }, [setMode, getCtx, ensureAnalyser, endTurnIfDone]);

  // Enqueue a sentence and start playback if idle. gapMs is extra silence held
  // after this sentence (paragraph/topic change → longer beat).
  const enqueueSpeech = useCallback((text: string, gapMs = 0) => {
    const clean = toSpeakable(text || "");
    if (!clean || !voiceAvailable) return;
    speakQueueRef.current.push({ text: clean, gapMs });
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
    hasInteractedRef.current = true; // from now on, async Soul replies are live
    stopSpeech(); // a new turn interrupts any in-flight speech
    setActivity([]); // clear last turn's tool feed
    setTurns((prev) => [...prev.slice(-6), { id: genId("u"), role: "user", content: msg }]);
    setMode("working");
    const bubbleId = genId("a");
    setTurns((prev) => [...prev, { id: bubbleId, role: "assistant", content: "" }]);
    let assembled = "";
    let errored = false; // error paths re-arm on their own timer; finally must not double-arm
    // Pipelined TTS: speak each sentence the moment it completes, overlapping synth
    // with the model still generating, so the first words come out ~as the first
    // sentence lands instead of at `done`. The orchestrator is a thin router — a
    // delegation ack leads with `[delegated]` (before any prose), so once that
    // marker is seen we suppress all speech for this turn (the Soul's reply is
    // spoken via the channel stream). Because the marker leads, it is known before
    // the first sentence boundary, so a real direct answer never waits on it.
    let spokenCursor = 0;        // chars of `assembled` already handed to TTS
    let spokenChars = 0;         // total spoken length this turn (SPEAK_CAP guard)
    let delegated = false;       // turn is a delegation ack → never spoken
    let capped = false;          // SPEAK_CAP hit → pointer to screen spoken once
    // Safety net: if the orchestrator turn hangs (the PTY screen-scrape can miss a
    // turn's completion on tool-call turns), don't keep the UI stuck — abort after
    // 60s and recover. A delegated soul's reply still arrives on the channel
    // stream and is spoken independently.
    const ac = new AbortController();
    const killer = window.setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: msg }),
        signal: ac.signal
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "";
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `gateway ${res.status}: ${text}` } : t));
        errored = true;
        setMode("error");
        sendingRef.current = false; // let the turn count as done so the re-arm fires
        setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2500);
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
            // Suppress speech the instant a delegation is detected (cut anything
            // already queued/playing as a belt-and-suspenders — in practice the
            // marker leads, so nothing has been spoken yet).
            if (!delegated && /\[delegated\]/i.test(assembled)) {
              delegated = true;
              stopSpeech();
            }
            // Speak each newly-completed sentence, up to the spoken-length cap.
            if (!delegated && spokenChars < SPEAK_CAP) {
              const { sentences, cursor } = takeSentences(assembled, spokenCursor);
              spokenCursor = cursor;
              for (const s of sentences) {
                if (spokenChars >= SPEAK_CAP) break;
                spokenChars += s.text.length;
                enqueueSpeech(s.text, s.gapMs);
              }
              if (spokenChars >= SPEAK_CAP && !capped) { capped = true; enqueueSpeech("O resto está no ecrã."); }
            }
          } else if (ev.event === "activity" && typeof ev.data?.tool === "string") {
            // a tool call from the Operative — show it live in the "now" feed.
            // ToolSearch is harness plumbing (loading tool schemas), not a
            // content action, so it's filtered out as noise.
            const tool = ev.data.tool as string;
            if (tool !== "ToolSearch") {
              const detail = typeof ev.data.detail === "string" ? ev.data.detail : "";
              setActivity((prev) => [...prev.slice(-4), { id: genId("act"), tool, detail }]);
            }
          } else if (ev.event === "error") {
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, role: "error", content: t.content || (ev.data?.error ?? "error") } : t));
          } else if (ev.event === "done") {
            clearTimeout(killer); // turn completed; don't abort the lingering stream
            const finalReply = typeof ev.data?.reply === "string" ? ev.data.reply : "";
            if (!assembled && finalReply) assembled = finalReply; // chunkless gateway path
            // Re-check on the RAW reply (covers the chunkless path, where no chunk
            // event ran the incremental detector above).
            delegated = delegated || /\[delegated\]/i.test(assembled);
            const finalContent = stripMarkers(assembled);
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, content: stripMarkers(t.content || finalReply) } : t));
            if (finalContent) pushCallout("reply", finalContent);
            // Flush the tail not yet spoken incrementally: the final sentence (no
            // trailing whitespace to fire a boundary) or, on the chunkless path, the
            // whole reply. Delegation acks are shown, never spoken.
            if (!delegated && spokenChars < SPEAK_CAP) {
              const tail = assembled.slice(spokenCursor).trim();
              if (tail) { enqueueSpeech(tail); spokenChars += tail.length; }
              spokenCursor = assembled.length;
            }
            // re-arm is handled by `finally` (no TTS) or by playNextInQueue when
            // the TTS queue drains — never here, where sending is still true.
          }
        }
      }
    } catch (err: any) {
      errored = true;
      sendingRef.current = false;
      if (err?.name === "AbortError") {
        // Soft timeout: the orchestrator turn is slow/stuck. Recover the UI now;
        // a delegated soul's answer may still arrive on the channel stream.
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, content: stripMarkers(t.content) || "…(a processar; a resposta pode chegar pela voz)" } : t));
        setMode("idle");
        endTurnIfDone();
      } else {
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `network: ${err?.message || String(err)}` } : t));
        setMode("error");
        setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2500);
      }
    } finally {
      clearTimeout(killer);
      sendingRef.current = false;
      // Re-arm for the no-TTS success path; TTS replies re-arm via playNextInQueue,
      // error/abort paths re-arm themselves, so skip those here.
      if (!errored && !speakingRef.current && speakQueueRef.current.length === 0) endTurnIfDone();
    }
  }, [setMode, enqueueSpeech, stopSpeech, pushCallout, endTurnIfDone]);

  // ── hands-free voice session (Silero VAD) ────────────────────────────────

  // A speech segment ended: transcribe it and send it as a turn. VAD is already
  // paused by the caller so it won't capture the upcoming reply.
  const handleSpeech = useCallback(async (audio: Float32Array) => {
    if (sendingRef.current) return; // a turn is already in flight
    setMode("working");
    try {
      const blob = float32ToWavBlob(audio, 16000);
      const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
      if (!res.ok) { endTurnIfDone(); return; }
      const data = await res.json();
      const transcript = typeof data?.transcript === "string" ? data.transcript.trim() : "";
      // loop-safety: drop empty / sub-word transcripts (a stray noise blip)
      if (transcript && transcript.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2) {
        void send(transcript);
      } else {
        endTurnIfDone(); // nothing usable → re-arm and keep listening
      }
    } catch {
      endTurnIfDone();
    }
  }, [setMode, send, endTurnIfDone]);

  // Surface a problem the user can read (and report) instead of failing silent.
  const flashError = useCallback((label: string, msg: string) => {
    console.error(`[jarvis] ${label}: ${msg}`);
    pushCallout(label, msg);
    setMode("error");
    setTimeout(() => { if (modeRef.current === "error") setMode("idle"); }, 3500);
  }, [pushCallout, setMode]);

  // Build the VAD once, reusing the mic stream + AudioContext already obtained in
  // the click handler. Silero runs fully local in the browser (ONNX/WASM); the
  // model + worklet + ort runtime are served from the Fitting's dist/ (build.mjs).
  // Passing our own audioContext (already resumed under user activation) and a
  // pre-opened stream avoids the autoplay/gesture trap: the slow ~13 MB wasm load
  // happens AFTER the mic is live, so it can't consume the user-activation window.
  const ensureVad = useCallback(async (stream: MediaStream) => {
    if (vadRef.current) return vadRef.current;
    const vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: "/",
      onnxWASMBasePath: "/",
      audioContext: getCtx(),
      // Single-threaded ort: avoids needing cross-origin isolation (no
      // SharedArrayBuffer / COOP+COEP headers required).
      ortConfig: (ort: any) => { try { ort.env.wasm.numThreads = 1; ort.env.logLevel = "error"; } catch {} },
      startOnLoad: false,
      // Keep Silero's proven default thresholds (positive 0.3 / negative 0.25).
      // Raising them — which I tried — breaks END detection: with room noise the
      // speech probability hovers above a high negativeSpeechThreshold, so the
      // redemption counter never fills and the turn never ends. ~1.1s of trailing
      // silence ends a turn — long enough to ride over natural pauses in PT,
      // short enough to stay snappy. minSpeechMs low so short commands register.
      redemptionMs: 1100,
      minSpeechMs: 250,
      positiveSpeechThreshold: 0.3,
      negativeSpeechThreshold: 0.25,
      // Reuse the ONE mic stream opened in startSession and keep it open across
      // turns: pauseStream is a no-op and resumeStream returns the same stream,
      // so pause/resume only toggles the worklet, never the mic.
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async (s: MediaStream) => s,
      onSpeechStart: () => { console.debug("[vad] speechStart (mode=" + modeRef.current + ")"); if (!sendingRef.current && modeRef.current !== "speaking") setMode("listening"); },
      onSpeechEnd: (audio: Float32Array) => { console.debug("[vad] speechEnd len=" + audio.length); pauseVad(); void handleSpeech(audio); },
      onVADMisfire: () => { console.debug("[vad] misfire"); }
    });
    vadRef.current = vad;
    return vad;
  }, [getCtx, setMode, handleSpeech, pauseVad]);

  // Arm the hands-free session. The gesture-gated work (resume AudioContext, open
  // the mic) runs first, synchronously off the click, so it keeps user activation;
  // only then do we load + start the (slow) VAD.
  const startSession = useCallback(async () => {
    if (sessionOnRef.current) return;
    if (!voiceAvailable) { flashError("voice", "No voice Fitting — station local-voice"); return; }
    if (!micCaptureAllowed()) { flashError("mic", "Mic needs https or localhost"); return; }
    setSessionOn(true);
    setMode("listening");
    let stream: MediaStream;
    try {
      await getCtx().resume(); // must happen under user activation
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micStreamRef.current = stream;
      try {
        const src = getCtx().createMediaStreamSource(stream);
        // Mic → analyser ONLY (never to ctx.destination, or it would echo).
        src.connect(ensureAnalyser(micAnalyserRef));
        micSourceRef.current = src;
      } catch {}
    } catch (e: any) {
      setSessionOn(false);
      flashError("mic", `Mic blocked: ${e?.message || e}`);
      return;
    }
    try {
      const vad = await ensureVad(stream);
      vadRunningRef.current = true;
      await vad.start();
    } catch (e: any) {
      setSessionOn(false);
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      flashError("vad", `VAD load failed: ${e?.message || e}`);
    }
  }, [voiceAvailable, ensureVad, getCtx, ensureAnalyser, setMode, setSessionOn, flashError]);

  // Disarm the session: tear down the VAD and fully release the mic (so the
  // browser's recording indicator goes off). The next start rebuilds it.
  const stopSession = useCallback(async () => {
    setSessionOn(false);
    vadRunningRef.current = false;
    try { await vadRef.current?.destroy(); } catch {}
    vadRef.current = null;
    try { micSourceRef.current?.disconnect(); } catch {}
    micSourceRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    stopSpeech();
    setMode("idle");
  }, [setSessionOn, setMode, stopSpeech]);

  // Single press = toggle the session. While Jarvis is speaking, a press is a
  // barge-in: cut the reply off but keep the session armed.
  const onToggle = useCallback(() => {
    if (modeRef.current === "speaking") {
      stopSpeech();
      if (sessionOnRef.current) { resumeVad(); setMode("listening"); }
      else setMode("idle");
      return;
    }
    if (sessionOnRef.current) void stopSession();
    else void startSession();
  }, [stopSpeech, resumeVad, setMode, stopSession, startSession]);

  // Space toggles the session (ignore auto-repeat and typing fields). Esc closes
  // the report overlay.
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      if (report) return;
      e.preventDefault();
      onToggle();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setReport(null); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [onToggle, report]);

  // Channel stream: speak a delegated Soul's reply when it lands asynchronously
  // (the orchestrator only acked the delegation, marked [delegated], unspoken).
  // The orchestrator's own output comes via /api/chat, so it's ignored here.
  useEffect(() => {
    if (!voiceAvailable) return;
    let es: EventSource | null = null;
    try { es = new EventSource("/api/stream"); } catch { return; }
    const onEvent = (e: MessageEvent) => {
      let w: any;
      try { w = JSON.parse(e.data); } catch { return; }
      const soul = w?.soul;
      if (!soul || soul === "garrison-orchestrator") return; // orchestrator → /api/chat
      const ev = w?.event;
      if (ev?.type !== "assistant") return;
      const text = (ev.message?.content ?? [])
        .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      const clean = stripMarkers(text);
      if (!clean) return;
      if (!hasInteractedRef.current) return; // safety: nothing before the user engages
      setTurns((prev) => [...prev.slice(-6), { id: genId("a"), role: "assistant", content: clean }]);
      pushCallout(soul, clean);
      pauseVad();           // don't let the live (re-armed) VAD capture the Soul's TTS
      enqueueSpeech(clean); // drains → endTurnIfDone re-arms the VAD
    };
    es.addEventListener("event", onEvent as EventListener);
    return () => { try { es?.close(); } catch {} };
  }, [voiceAvailable, enqueueSpeech, pushCallout, pauseVad]);

  useEffect(() => () => {
    try { void vadRef.current?.destroy(); } catch {}
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    try { audioElRef.current?.pause(); } catch {}
    if (audioUrlRef.current) { try { URL.revokeObjectURL(audioUrlRef.current); } catch {} }
    try { audioCtxRef.current?.close(); } catch {}
  }, []);

  const statusLabel = !voiceAvailable
    ? "No voice Fitting — station local-voice"
    : mode === "listening" ? "Listening… (fala; a pausa envia · Space/tap para parar)"
    : mode === "working" ? "Thinking…"
    : mode === "speaking" ? "Speaking… (Space/tap to interrupt)"
    : mode === "error" ? "Error"
    : micCaptureAllowed() ? "Press Space (or tap the core) to start talking" : "Mic needs https or localhost";

  return (
    <div className={`jarvis-root state-${mode}${sessionOn ? " session-on" : ""}`}>
      <div
        className="jarvis-core"
        onClick={onToggle}
        role="button"
        aria-pressed={sessionOn}
        aria-label={sessionOn ? "Stop voice session" : "Start voice session"}
      >
        <DitherCore mode={mode} getLevel={getLevel} />
      </div>

      <div className="jarvis-status" data-state={mode}>
        <span className={`jarvis-dot ${mode}`} />
        <span className="jarvis-status-text">{statusLabel}</span>
      </div>

      {activity.length > 0 && (
        <div className="jarvis-activity" data-state={mode}>
          <span className="jarvis-activity-head">NOW</span>
          {activity.map((a) => (
            <div key={a.id} className="jarvis-activity-row">
              <span className="jarvis-activity-dot" />
              <span className="jarvis-activity-tool">{toolVerb(a.tool)}</span>
              {a.detail ? <span className="jarvis-activity-detail">{a.detail}</span> : null}
            </div>
          ))}
        </div>
      )}

      <div className="jarvis-callouts">
        {callouts.map((c) => (
          <button key={c.id} className="jarvis-callout" onClick={() => setReport({ path: c.label, content: c.content })}>
            <span className="jarvis-callout-dot" />
            <span className="jarvis-callout-label">{c.label}</span>
            <span className="jarvis-callout-text">{c.content.slice(0, 120)}</span>
          </button>
        ))}
      </div>

      <div className="jarvis-transcript" ref={transcriptRef}>
        {turns.map((t) => (
          <div key={t.id} className={`jarvis-turn ${t.role}`}>
            <span className="jarvis-turn-role">{t.role === "user" ? "you" : t.role === "error" ? "!" : "jarvis"}</span>
            {t.role === "assistant" && t.content
              ? <div className="jarvis-turn-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.content) }} />
              : <span className="jarvis-turn-text">{t.content || (t.role === "assistant" ? "…" : "")}</span>}
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
