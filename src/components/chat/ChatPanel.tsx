"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useAppShell } from "@/components/chrome/AppShell";
import { formatBytes } from "@/lib/format";
import { garrisonRoutePath, parseMessageBody } from "@/lib/message-body";
import {
  useChatContext,
  type ChatMessage
} from "@/components/chat/ChatContext";

export function ChatPanel() {
  const { composition, runnerState } = useAppShell();
  const isRunning = runnerState?.status === "running";

  const {
    messages,
    subSessions,
    draft,
    setDraft,
    pendingAttachments,
    sending,
    attaching,
    localError,
    monitorUrl,
    send,
    clearChat,
    handleAttach,
    removeAttachment,
    endSoul
  } = useChatContext();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

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

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <main style={{ height: "100vh", display: "grid", gridTemplateRows: "auto auto 1fr auto", minHeight: 0 }}>
      <div
        className="chat-header"
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
        className="chat-metabar"
        style={{
          display: "flex",
          gap: 18,
          alignItems: "center",
          flexWrap: "wrap",
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
        className="chat-scroll"
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
          className="chat-error"
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
        className="chat-input-bar"
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
                  onClick={() => removeAttachment(a.path)}
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
            onChange={(e) => {
              void handleAttach(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
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

  if (typeof i.command === "string") {
    const desc = typeof i.description === "string" ? i.description : "";
    const cmd = `$ ${truncate(i.command.replace(/\s+/g, " "), TOOL_INPUT_MAX)}`;
    return desc ? `${desc}\n${cmd}` : cmd;
  }

  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;

  if (typeof i.skill === "string") return `skill: ${i.skill}`;
  if (typeof i.name === "string" && Object.keys(i).length <= 2) return `name: ${i.name}`;

  if (typeof i.query === "string") {
    return `query: ${truncate(i.query, TOOL_INPUT_MAX)}`;
  }

  if (typeof i.startTime === "string" && typeof i.endTime === "string") {
    return `${i.startTime} → ${i.endTime}`;
  }

  if (typeof i.channel === "string") {
    const text =
      typeof i.text === "string"
        ? truncate(i.text.replace(/\s+/g, " "), TOOL_INPUT_MAX - 40)
        : "";
    return text ? `#${i.channel} · ${text}` : `#${i.channel}`;
  }

  if (typeof i.url === "string") return i.url;
  if (typeof i.urls === "object" && Array.isArray(i.urls)) {
    return (i.urls as string[]).slice(0, 3).join(", ");
  }

  for (const [key, value] of Object.entries(i)) {
    if (typeof value === "string" && value.length > 0) {
      return `${key}: ${truncate(value, TOOL_INPUT_MAX)}`;
    }
  }
  return null;
}
