"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAppShell } from "@/components/chrome/AppShell";
import { readSseStream } from "@/lib/sse";
import { bufferToBase64, formatBytes } from "@/lib/format";
import { garrisonRoutePath, parseMessageBody } from "@/lib/message-body";

interface ChatAttachment {
  filename: string;
  path: string;
  bytes: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  toolCalls?: { name: string; input?: unknown }[];
  status?: "pending" | "streaming" | "complete" | "error";
  costUsd?: number | null;
  errorText?: string;
}

interface SubSessionBlock {
  sessionId: string;
  soul: string;
  status: "running" | "completed" | "failed";
  text: string;
}

export function ChatPanel() {
  const { composition, runnerState, setError } = useAppShell();
  const compositionId = composition?.id;
  const isRunning = runnerState?.status === "running";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [subSessions, setSubSessions] = useState<Record<string, SubSessionBlock>>({});
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/monitor/discover", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { available?: boolean; url?: string | null };
        if (cancelled) return;
        setMonitorUrl(data.available && data.url ? data.url : null);
      } catch {
        if (!cancelled) setMonitorUrl(null);
      }
    };
    check();
    const handle = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  // Phase 9H — subscribe to the orchestrator channel SSE while running.
  // Sub-session events (engineer/architect/… subprocesses) stream live; we
  // surface them as nested blocks so the user sees the work in real time.
  useEffect(() => {
    if (!compositionId || !isRunning) return;
    const source = new EventSource(`/api/runner/${compositionId}/channels/main/stream`);
    const handler = (e: MessageEvent) => {
      try {
        const wrapped = JSON.parse(e.data) as {
          session_id: string;
          soul: string;
          event: { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
        };
        const ev = wrapped.event;
        setSubSessions((prev) => {
          const existing = prev[wrapped.session_id] ?? {
            sessionId: wrapped.session_id,
            soul: wrapped.soul,
            status: "running" as const,
            text: ""
          };
          if (ev?.type === "assistant" && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block?.type === "text" && block.text) {
                existing.text += block.text;
              }
            }
          } else if (ev?.type === "result") {
            existing.status = ev.subtype === "success" ? "completed" : "failed";
          }
          return { ...prev, [wrapped.session_id]: { ...existing } };
        });
      } catch { /* ignore malformed */ }
    };
    source.addEventListener("event", handler);
    source.onerror = () => { /* auto-reconnect */ };
    return () => {
      source.removeEventListener("event", handler);
      source.close();
    };
  }, [compositionId, isRunning]);

  async function endSoul(soul: string) {
    if (!compositionId) return;
    try {
      await fetch(`/api/runner/${compositionId}/sessions/by-soul/${encodeURIComponent(soul)}/end`, {
        method: "POST"
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!composition) {
    return (
      <main>
        <div className="page wide">
          <div className="head">
            <h1>Loading…</h1>
          </div>
        </div>
      </main>
    );
  }

  const canSend = isRunning && draft.trim().length > 0 && !sending;

  async function handleAttach(files: FileList | null) {
    if (!files || files.length === 0 || !compositionId) return;
    if (!isRunning) {
      setLocalError("Start the operative first to attach files.");
      return;
    }
    setAttaching(true);
    setLocalError(null);
    try {
      for (const file of Array.from(files)) {
        const bytes = await file.arrayBuffer();
        const base64 = bufferToBase64(bytes);
        const res = await fetch(`/api/runner/${compositionId}/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64: base64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `attach failed: ${res.status}`);
        setPendingAttachments((prev) => [
          ...prev,
          { filename: file.name, path: data.path, bytes: data.bytes }
        ]);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function clearChat() {
    if (sending) return;
    setMessages([]);
    setLocalError(null);
  }

  async function send() {
    if (!canSend || !compositionId) return;
    const trimmed = draft.trim();
    const attachments = pendingAttachments;
    const composedMessage = attachments.length
      ? `${trimmed}\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`
      : trimmed;

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
      attachments,
      status: "complete"
    };
    const assistantId = `a-${Date.now()}`;
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      status: "streaming"
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setDraft("");
    setPendingAttachments([]);
    setSending(true);
    setLocalError(null);

    try {
      const res = await fetch(`/api/runner/${compositionId}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Garrison-Origin": "workbench"
        },
        body: JSON.stringify({ message: composedMessage })
      });
      if (!res.ok || !res.body) {
        const errorText = await res.text();
        throw new Error(`chat failed: ${res.status} ${errorText}`);
      }
      await readSseStream(res.body, (event, data) => {
        const payload = (data ?? {}) as Record<string, unknown>;
        if (event === "chunk") {
          const text = String(payload.text ?? "");
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + text } : m))
          );
        } else if (event === "tool") {
          const tool = { name: String(payload.name ?? "?"), input: payload.input };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), tool] }
                : m
            )
          );
        } else if (event === "done") {
          const finalReply = String(payload.reply ?? "");
          const cost = typeof payload.cost_usd === "number" ? payload.cost_usd : null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: finalReply || m.text, status: "complete", costUsd: cost }
                : m
            )
          );
        } else if (event === "error") {
          const errText = String(payload.error ?? "stream error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, status: "error", errorText: errText } : m
            )
          );
        }
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && m.status === "streaming" ? { ...m, status: "complete" } : m
        )
      );
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "error", errorText: messageText } : m
        )
      );
      setLocalError(messageText);
      setError(messageText);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <main style={{ height: "100vh", display: "grid", gridTemplateRows: "auto auto 1fr auto", minHeight: 0 }}>
      <div
        style={{
          padding: "18px 56px 14px",
          borderBottom: "1px solid var(--rule)"
        }}
      >
        <h1
          className="font-display"
          style={{
            fontWeight: 600,
            fontSize: 24,
            letterSpacing: "-0.008em",
            margin: "0 0 4px"
          }}
        >
          Chat · {composition.name}
        </h1>
        <p style={{ color: "var(--mute)", fontSize: 13.5, margin: 0 }}>
          {isRunning
            ? "Talking to the running operative through the gateway. Enter to send, Shift+Enter for newline."
            : "Operative is offline. Open the Run panel to start it."}
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 18,
          alignItems: "center",
          padding: "10px 56px",
          background: "var(--paper-2)",
          borderBottom: "1px solid var(--rule)",
          fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
          fontSize: 11,
          color: "var(--mute)",
          letterSpacing: "0.04em"
        }}
      >
        <span>
          turns · <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontSize: 12 }}>{messages.length}</b>
        </span>
        <span>
          attachments ·{" "}
          <b style={{ color: "var(--ink)", fontFamily: "var(--font-sans), Inter, sans-serif", fontSize: 12 }}>
            {pendingAttachments.length}
          </b>
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center" }}>
          {monitorUrl && (
            <a
              href={monitorUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="chat-monitor-link"
              style={{ color: "var(--ink)", textDecoration: "underline" }}
            >
              Monitor ↗
            </a>
          )}
          {isRunning ? (
            <Link
              href="/run"
              style={{ color: "var(--ink)", textDecoration: "underline" }}
            >
              Open Run panel ↗
            </Link>
          ) : (
            <Link
              href="/run"
              style={{ color: "var(--alarm)", textDecoration: "underline" }}
            >
              Operative offline — open Run ↗
            </Link>
          )}
        </span>
        <button
          className="font-mono"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--mute)",
            textDecoration: "underline",
            cursor: messages.length === 0 || sending ? "not-allowed" : "pointer",
            opacity: messages.length === 0 || sending ? 0.5 : 1,
            fontSize: 11
          }}
          onClick={clearChat}
          disabled={messages.length === 0 || sending}
        >
          Clear · start fresh
        </button>
      </div>

      <div
        ref={scrollRef}
        style={{
          overflowY: "auto",
          padding: "24px 56px 8px"
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              height: "100%",
              minHeight: 320,
              color: "var(--mute)",
              textAlign: "center"
            }}
          >
            <div>
              <div className="font-display" style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>
                {isRunning ? "Type below and press Enter to send." : "The operative is offline."}
              </div>
              <div style={{ fontSize: 13 }}>
                {isRunning
                  ? "Messages route through the gateway, then the orchestrator, then back."
                  : "Press Run on the Run panel first."}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {messages.map((message) => (
              <ChatRow key={message.id} message={message} />
            ))}
            {Object.values(subSessions).length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                {Object.values(subSessions).map((block) => (
                  <div
                    key={block.sessionId}
                    style={{
                      borderLeft: "3px solid var(--accent, #aaa)",
                      paddingLeft: 12,
                      fontSize: 13,
                      color: "var(--mute)",
                      background: "var(--surface-2, transparent)",
                      borderRadius: 4,
                      padding: "8px 12px"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <strong>
                        {block.soul}
                        {" "}
                        <span style={{ fontWeight: "normal", opacity: 0.7 }}>
                          ({block.sessionId.slice(0, 8)}) — {block.status}
                        </span>
                      </strong>
                      {block.status === "running" ? (
                        <button
                          type="button"
                          onClick={() => endSoul(block.soul)}
                          style={{
                            fontSize: 11,
                            background: "transparent",
                            border: "1px solid var(--rule)",
                            borderRadius: 3,
                            padding: "2px 8px",
                            cursor: "pointer"
                          }}
                        >
                          End
                        </button>
                      ) : null}
                    </div>
                    {block.text ? (
                      <div style={{ whiteSpace: "pre-wrap" }}>{block.text}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {localError ? (
        <div
          style={{
            padding: "10px 56px",
            background: "var(--alarm-soft)",
            borderTop: "1px solid rgba(155,54,45,0.3)",
            color: "var(--alarm)",
            fontSize: 12.5
          }}
        >
          {localError}
        </div>
      ) : null}

      <div
        style={{
          borderTop: "1px solid var(--rule)",
          padding: "14px 56px 16px",
          background: "var(--paper)"
        }}
      >
        {pendingAttachments.length > 0 ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {pendingAttachments.map((a) => (
              <div
                key={a.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 10px",
                  border: "1px solid var(--rule)",
                  background: "white",
                  fontSize: 11.5
                }}
              >
                <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.filename}
                </span>
                <span style={{ color: "var(--mute)", fontFamily: "var(--font-mono), 'JetBrains Mono', monospace", fontSize: 10.5 }}>
                  {formatBytes(a.bytes)}
                </span>
                <button
                  type="button"
                  onClick={() => setPendingAttachments((p) => p.filter((x) => x.path !== a.path))}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--mute)",
                    cursor: "pointer",
                    fontSize: 12
                  }}
                  aria-label={`Remove ${a.filename}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 10,
            alignItems: "end",
            border: "1px solid var(--rule)",
            background: "white",
            padding: "8px 10px 8px 12px"
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => handleAttach(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attaching || !isRunning}
            style={{
              background: "transparent",
              border: "1px solid var(--rule)",
              padding: "6px 10px",
              fontSize: 12,
              cursor: !isRunning ? "not-allowed" : "pointer",
              color: "var(--ink)",
              opacity: !isRunning ? 0.5 : 1
            }}
          >
            {attaching ? "…" : "+ Attach"}
          </button>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isRunning ? "Message the operative…" : "Operative offline."}
            disabled={!isRunning}
            rows={1}
            style={{
              border: "none",
              outline: "none",
              fontSize: 14,
              minHeight: 20,
              maxHeight: 200,
              padding: "6px 4px",
              background: "transparent",
              color: "var(--ink)",
              resize: "none"
            }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            style={{
              padding: "8px 14px",
              background: "var(--ink)",
              color: "var(--paper)",
              border: "none",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: canSend ? "pointer" : "not-allowed",
              opacity: canSend ? 1 : 0.6
            }}
          >
            {sending ? "Sending…" : "Send →"}
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            marginTop: 6,
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            fontSize: 10.5,
            color: "var(--mute)"
          }}
        >
          <span>
            operative is{" "}
            <b style={{ color: isRunning ? "var(--sage)" : "var(--alarm)" }}>
              {isRunning ? "running" : "offline"}
            </b>
          </span>
          <span>permissions · {composition.globalConfig.permissions_mode}</span>
        </div>
      </div>
    </main>
  );
}

function ChatRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article
      style={{
        display: "grid",
        gridTemplateColumns: "96px 1fr",
        gap: 16,
        padding: "12px 0",
        borderBottom: "1px solid var(--rule)"
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: isUser ? "var(--brass)" : "var(--sage)",
          paddingTop: 2
        }}
      >
        {isUser ? "You" : "Operative"}
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 720, minWidth: 0 }}>
        {message.toolCalls && message.toolCalls.length > 0 ? (
          <div style={{ marginBottom: 6, display: "grid", gap: 4 }}>
            {message.toolCalls.map((t, i) => {
              const summary = summarizeToolInput(t.name, t.input);
              return (
                <div
                  key={`${t.name}-${i}`}
                  className="font-mono"
                  style={{
                    fontSize: 11.5,
                    color: "var(--mute)",
                    background: "var(--paper-2)",
                    border: "1px solid var(--rule)",
                    padding: "6px 10px",
                    display: "grid",
                    gap: 2
                  }}
                >
                  <b style={{ color: "var(--ink)" }}>tool · {formatToolName(t.name)}</b>
                  {summary ? (
                    <span
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: "var(--mute)",
                        fontSize: 11
                      }}
                    >
                      {summary}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          <MessageBodyText text={message.text} />
          {message.status === "streaming" && !message.text ? (
            <span style={{ color: "var(--mute)" }}>Thinking…</span>
          ) : null}
          {message.status === "streaming" ? (
            <span
              style={{
                marginLeft: 4,
                display: "inline-block",
                width: 6,
                height: 12,
                background: "currentColor",
                opacity: 0.6,
                animation: "blink 0.9s linear infinite",
                verticalAlign: "middle"
              }}
            />
          ) : null}
        </div>
        {message.errorText ? (
          <div style={{ marginTop: 6, color: "var(--alarm)", fontSize: 12 }}>
            {message.errorText}
          </div>
        ) : null}
        {message.attachments && message.attachments.length > 0 ? (
          <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
            {message.attachments.map((a) => (
              <div
                key={a.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11.5,
                  color: "var(--mute)"
                }}
              >
                <span>{a.filename}</span>
                <span className="font-mono">{formatBytes(a.bytes)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {(message.status === "complete" || message.status === "streaming") && (typeof message.costUsd === "number" || isUser === false) ? (
          <div
            className="font-mono"
            style={{
              marginTop: 6,
              fontSize: 10.5,
              color: "var(--mute)",
              letterSpacing: "0.04em"
            }}
          >
            {typeof message.costUsd === "number" ? `cost $${message.costUsd.toFixed(4)} · ` : ""}
            {message.toolCalls?.length ? `${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? "" : "s"}` : ""}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MessageBodyText({ text }: { text: string }) {
  const segments = parseMessageBody(text);
  if (segments.length === 0) {
    return null;
  }
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "garrison") {
          return (
            <Link
              key={index}
              href={garrisonRoutePath(segment.fittingId, segment.rest)}
              className="garrison-link"
              style={{ color: "var(--sage)", textDecoration: "underline" }}
            >
              {segment.value}
            </Link>
          );
        }
        if (segment.type === "external") {
          return (
            <a
              key={index}
              href={segment.href}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--ink)", textDecoration: "underline" }}
            >
              {segment.value}
            </a>
          );
        }
        return <span key={index}>{segment.value}</span>;
      })}
    </>
  );
}

const TOOL_INPUT_MAX = 240;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatToolName(name: string): string {
  if (name.startsWith("mcp__claude_ai_")) {
    const rest = name.slice("mcp__claude_ai_".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      return `mcp:${rest.slice(0, sep)} / ${rest.slice(sep + 2)}`;
    }
  }
  return name;
}

function summarizeToolInput(name: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;

  // Bash: prefer description (it's a one-liner the agent wrote about
  // intent) plus the actual command. Both are useful — description tells
  // you why, command tells you what.
  if (typeof i.command === "string") {
    const desc = typeof i.description === "string" ? i.description : "";
    const cmd = `$ ${truncate(i.command.replace(/\s+/g, " "), TOOL_INPUT_MAX)}`;
    return desc ? `${desc}\n${cmd}` : cmd;
  }

  // Read / Edit / Write: file path is the headline.
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;

  // Skill invocation by name.
  if (typeof i.skill === "string") return `skill: ${i.skill}`;
  if (typeof i.name === "string" && Object.keys(i).length <= 2) return `name: ${i.name}`;

  // Search / query patterns (ToolSearch, MCP search variants).
  if (typeof i.query === "string") {
    return `query: ${truncate(i.query, TOOL_INPUT_MAX)}`;
  }

  // Calendar list_events shape.
  if (typeof i.startTime === "string" && typeof i.endTime === "string") {
    return `${i.startTime} → ${i.endTime}`;
  }

  // Slack send: channel + first chunk of text.
  if (typeof i.channel === "string") {
    const text =
      typeof i.text === "string"
        ? truncate(i.text.replace(/\s+/g, " "), TOOL_INPUT_MAX - 40)
        : "";
    return text ? `#${i.channel} · ${text}` : `#${i.channel}`;
  }

  // URL-shaped tools (WebFetch, etc).
  if (typeof i.url === "string") return i.url;
  if (typeof i.urls === "object" && Array.isArray(i.urls)) {
    return (i.urls as string[]).slice(0, 3).join(", ");
  }

  // Generic fallback: first non-empty string field.
  for (const [key, value] of Object.entries(i)) {
    if (typeof value === "string" && value.length > 0) {
      return `${key}: ${truncate(value, TOOL_INPUT_MAX)}`;
    }
  }
  return null;
}

