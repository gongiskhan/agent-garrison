import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { QuestionBlock } from "./ClaudeChat";
import type { ToolQuestion, TurnRouting } from "./transport";

interface PendingQuestion extends ToolQuestion { id: string }

/** Both presentations answer the same durable question through the message door. */
export function ConversationQuestion({ conversationId, base = "/api/conversation", compact = false,
  enabled = true, origin = "web", routing, onAnswered, freeForm = true,
}: { conversationId: string; base?: string; compact?: boolean; enabled?: boolean;
  freeForm?: boolean; origin?: string; routing?: TurnRouting | null; onAnswered?: () => void }) {
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const accepted = useRef<string | null>(null);
  const root = `${base.replace(/\/+$/, "")}/${encodeURIComponent(conversationId)}`;
  useEffect(() => {
    setQuestion(null);
    setError(undefined);
    accepted.current = null;
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`${root}/question`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Could not load the current question. Retrying…");
        const data = await response.json();
        if (!disposed && !sending.current) {
          const next = data.question;
          setQuestion(next?.id && typeof next.question === "string" && Array.isArray(next.options)
            && next.id !== accepted.current ? next : null);
        }
      } catch { /* Existing question stays readable; admission still checks freshness. */ }
      finally { if (!disposed) timer = setTimeout(refresh, 5000); }
    };
    void refresh();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [root, enabled]);

  async function answer(text: string) {
    if (!question || sending.current || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`${root}/message`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, questionId: question.id,
          clientRequestId: `answer:${conversationId}:${question.id}`, origin, ...(routing ? { routing } : {}) }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 409
        ? "This question has changed or was already answered. Open the conversation for the latest state."
        : typeof body?.error === "string" ? body.error : "The reply could not be sent. Try again.");
      accepted.current = question.id;
      setQuestion(null);
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reply could not be sent. Try again.");
    } finally { sending.current = false; setBusy(false); }
  }

  if (!enabled || !question) return null;
  return <div className={`cc-conversation-question${compact ? " is-compact" : ""}`}
    onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}>
    <QuestionBlock key={question.id} q={question} answering={busy} error={error}
      showFreeForm={freeForm} hideOther={!freeForm} onSelect={(text) => void answer(text)} onOther={(text) => void answer(text)} />
  </div>;
}
