import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

// Mirror of src/lib/message-body.ts:29-30 (cannot import from Garrison core).
const GARRISON_URI = /\bgarrison:\/\/([A-Za-z0-9_-]+)(?:\/([^\s)<>"']+))?/g;

marked.setOptions({ breaks: true, gfm: true });

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
  const [connected, setConnected] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Read latest readAloud inside async send() without re-creating the callback.
  const readAloudRef = useRef(false);
  useEffect(() => { readAloudRef.current = readAloud; }, [readAloud]);
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

  // Text-to-speech: ask the voice Fitting (via the same-origin proxy) to speak
  // `text`, then play the returned audio. Replaces any in-flight playback.
  const speak = useCallback(async (text: string) => {
    const clean = (text || "").trim();
    if (!clean) return;
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean })
      });
      if (!res.ok) return;
      const blob = await res.blob();
      if (!blob.size) return;
      const objectUrl = URL.createObjectURL(blob);
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch {}
      }
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(objectUrl);
      audio.play().catch(() => URL.revokeObjectURL(objectUrl));
    } catch {
      // TTS is best-effort; failures stay silent.
    }
  }, []);

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
            if (readAloudRef.current && finalContent.trim()) {
              void speak(finalContent);
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

  // Push-to-talk. Click once to start recording from the mic, click again to
  // stop; on stop we POST the captured audio to /api/voice/stt and auto-send
  // the transcript. getUserMedia needs a secure context (see micCaptureAllowed).
  const toggleRecording = useCallback(async () => {
    if (recording) {
      try { mediaRecorderRef.current?.stop(); } catch {}
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
  }, [recording, send]);

  const onKeyDown = useCallback((ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key !== "Enter") return;
    // Mobile virtual keyboard: Enter inserts newline (no shift on touch).
    // Hardware keyboard (where shift is reliably present): Enter sends, Shift+Enter newlines.
    const isCoarse = window.matchMedia("(pointer: coarse)").matches;
    if (isCoarse) return;
    if (ev.shiftKey) return;
    ev.preventDefault();
    send();
  }, [send]);

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
              className={`read-aloud-toggle${readAloud ? " on" : ""}`}
              role="switch"
              aria-checked={readAloud}
              data-testid="read-aloud-toggle"
              title={readAloud ? "Auto read-aloud is on" : "Auto read-aloud is off"}
              onClick={() => setReadAloud((v) => !v)}
            >
              <SpeakerIcon />
              <span>Read aloud{readAloud ? ": on" : ": off"}</span>
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
      <div className="composer">
        {voice.available ? (
          <button
            type="button"
            className={`mic-button${recording ? " recording" : ""}`}
            title={micCaptureAllowed()
              ? (recording ? "Stop recording" : "Record (push to talk)")
              : "Mic needs a secure context (https or localhost)"}
            aria-label={recording ? "Stop recording" : "Record"}
            aria-pressed={recording}
            data-testid="mic-button"
            disabled={sending || !micCaptureAllowed()}
            onClick={toggleRecording}
          >
            <MicIcon />
          </button>
        ) : null}
        <textarea
          ref={textareaRef}
          value={composing}
          onChange={(e) => setComposing(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={recording ? "Listening…" : "Message Gary…"}
          rows={1}
          autoFocus
        />
        <button className="send-button" onClick={() => send()} disabled={sending || !composing.trim()}>
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
