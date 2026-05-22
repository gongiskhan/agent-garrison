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

function MessageBubble({ message }: { message: Message }) {
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
  return (
    <div className={`bubble ${message.role}${message.streaming ? " streaming" : ""}`} onClick={onClick}>
      {message.role === "error"
        ? <div className="meta">error</div>
        : null}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
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
  const [connected, setConnected] = useState(false);
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

  const send = useCallback(async () => {
    const message = composing.trim();
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
            setMessages((prev) => prev.map((m) => {
              if (m.id !== bubbleId) return m;
              return { ...m, content: m.content || finalReply, streaming: false };
            }));
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
  }, [composing, sending]);

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
          : messages.map((m) => <MessageBubble key={m.id} message={m} />)}
      </div>
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={composing}
          onChange={(e) => setComposing(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Gary…"
          rows={1}
          autoFocus
        />
        <button className="send-button" onClick={send} disabled={sending || !composing.trim()}>
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
