import { useRef, useState } from "react";
import { ConversationQuestion, QuestionBlock } from "@garrison/claude-chat";
import { createConversationTransport } from "./card-conversation";
import type { CardSummary } from "./api";

/** Decision records may predate their first conversation. Let the user write
 * that first reply without inventing merge actions from a historical title. */
export function AttentionReply({ card, onAnswered }: { card: CardSummary; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  if (card.frozen) return null;
  if (card.conversationId) return <ConversationQuestion conversationId={card.conversationId}
    compact origin="kanban" onAnswered={onAnswered} />;
  if (sent) return <div className="card-reply" role="status">Reply sent. Picking this up…</div>;
  async function send(text: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await createConversationTransport(card.id).sendMessage(text, { clientRequestId: `attention:${card.id}:${card.rev}` });
      setSent(true);
      onAnswered();
    } catch { setError("The reply could not be confirmed. Try again."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="cc-conversation-question is-compact" onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <QuestionBlock q={{ question: "Reply to this card", options: [] }} showFreeForm
      answering={busy} error={error} onSelect={(text) => void send(text)} onOther={(text) => void send(text)} />
  </div>;
}
