"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import { useAppShell } from "@/components/chrome/AppShell";
import { readSseStream } from "@/lib/sse";
import { bufferToBase64 } from "@/lib/format";

export interface ChatAttachment {
  filename: string;
  path: string;
  bytes: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  toolCalls?: { name: string; input?: unknown }[];
  status?: "pending" | "streaming" | "complete" | "error";
  costUsd?: number | null;
  errorText?: string;
}

export interface SubSessionBlock {
  sessionId: string;
  soul: string;
  status: "running" | "completed" | "failed";
  text: string;
}

interface ChatContextValue {
  messages: ChatMessage[];
  subSessions: Record<string, SubSessionBlock>;
  draft: string;
  setDraft: (value: string) => void;
  pendingAttachments: ChatAttachment[];
  sending: boolean;
  attaching: boolean;
  localError: string | null;
  monitorUrl: string | null;
  send: () => Promise<void>;
  clearChat: () => void;
  handleAttach: (files: FileList | null) => Promise<void>;
  removeAttachment: (path: string) => void;
  endSoul: (soul: string) => Promise<void>;
}

const Ctx = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useChatContext must be used inside <ChatProvider>");
  return ctx;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { composition, runnerState, setError } = useAppShell();
  const compositionId = composition?.id;
  const isRunning = runnerState?.status === "running";

  // The chat state lives here rather than inside ChatPanel so it survives
  // route changes. ChatPanel unmounts when the user navigates away; if the
  // state lived there, the message list and any in-flight stream would be
  // discarded. Sitting above the route keeps both alive — the fetch loop
  // continues to write into this state, and remounting ChatPanel just picks
  // up the current view.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [subSessions, setSubSessions] = useState<Record<string, SubSessionBlock>>({});
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [monitorUrl, setMonitorUrl] = useState<string | null>(null);

  // Reset chat when the composition changes — a different operative has a
  // different conversation. Tracked via a ref so the effect that resets is
  // distinct from any callback closures.
  const lastCompositionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (compositionId === undefined) return;
    if (lastCompositionIdRef.current === null) {
      lastCompositionIdRef.current = compositionId;
      return;
    }
    if (lastCompositionIdRef.current !== compositionId) {
      lastCompositionIdRef.current = compositionId;
      setMessages([]);
      setSubSessions({});
      setDraft("");
      setPendingAttachments([]);
      setLocalError(null);
    }
  }, [compositionId]);

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

  const endSoul = useCallback(
    async (soul: string) => {
      if (!compositionId) return;
      try {
        await fetch(`/api/runner/${compositionId}/sessions/by-soul/${encodeURIComponent(soul)}/end`, {
          method: "POST"
        });
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : String(err));
      }
    },
    [compositionId]
  );

  const removeAttachment = useCallback((path: string) => {
    setPendingAttachments((prev) => prev.filter((x) => x.path !== path));
  }, []);

  const clearChat = useCallback(() => {
    if (sending) return;
    setMessages([]);
    setLocalError(null);
  }, [sending]);

  const handleAttach = useCallback(
    async (files: FileList | null) => {
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
      }
    },
    [compositionId, isRunning]
  );

  const send = useCallback(async () => {
    if (!compositionId) return;
    const trimmed = draft.trim();
    if (!trimmed || sending || !isRunning) return;

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
          "X-Garrison-Origin": "ui-tab"
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
  }, [compositionId, draft, isRunning, pendingAttachments, sending, setError]);

  const value = useMemo<ChatContextValue>(
    () => ({
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
    }),
    [
      messages,
      subSessions,
      draft,
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
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
