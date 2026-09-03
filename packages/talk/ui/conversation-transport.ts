// The web channel's conversation send door.
//
// A thread IS a conversation's channel surface, so a typed message no longer
// opens a turn on the chat lane: it is POSTed to the conversation router
// (`POST /api/conversation/:id/message`), which forwards to the gateway. The
// gateway appends the `user-message` record and, when nothing is running,
// spawns a responder stretch. Everything the user then sees comes back through
// the append-only conversation stream, which is the body of the view.
//
// This is a WRAPPER, not a replacement: the orchestrator transport keeps owning
// the SSE connection, interrupt, attachments and permission answers (the FIFO
// admit/claim lane is untouched), and only `sendMessage` is re-pointed. One
// door moved; nothing else did.

import { ChatTransportError } from "@garrison/claude-chat/transport";
import type { ChatInputReceipt, ChatTransport } from "@garrison/claude-chat";

/** Same-origin and RELATIVE, always: the browser is almost never on this box,
 *  so an absolute machine-local base is both unreachable and mixed content. */
export const CONVERSATION_BASE = "/api/conversation";

/** The router's message door for one conversation. */
export function conversationMessageUrl(conversationId: string, base: string = CONVERSATION_BASE): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(conversationId)}/message`;
}

/**
 * Post one message into a conversation. Shared by the composer's transport and
 * by the one-shot host kickoff, so both admit through exactly the same door and
 * report the same failures.
 */
export async function postConversationMessage(
  conversationId: string,
  message: string,
  opts: { base?: string; clientRequestId?: string | null; origin?: string; signal?: AbortSignal } = {},
): Promise<{ seq: number | null; recordedBy: string | null }> {
  // The door's allowed-fields gate is exact: `message`, `clientRequestId`,
  // `origin`, `context`, `routing` and `delivery`. Anything else is a 400.
  // Per-turn context/pins are NOT carried here - see the note on
  // createConversationTransport - and neither is `delivery`: this surface
  // takes the door's default (queue behind a running stretch); the kanban
  // card's composer is where a message steers the stretch in flight.
  const body: Record<string, unknown> = { message, origin: opts.origin ?? "web" };
  if (opts.clientRequestId) body.clientRequestId = opts.clientRequestId;
  let res: Response;
  try {
    res = await fetch(conversationMessageUrl(conversationId, opts.base ?? CONVERSATION_BASE), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    throw new ChatTransportError({
      source: "transport",
      kind: "transport",
      code: "conversation_message_unreachable",
      text: "The conversation could not be reached. The message was not recorded.",
      retryable: true,
    });
  }
  const payload = await res.json().catch(() => null) as
    | { seq?: unknown; recordedBy?: unknown; error?: unknown; detail?: unknown }
    | null;
  if (!res.ok) {
    // A refused message was NOT recorded (the router only accepts once the
    // forwarder confirms), so the composer must say so rather than leave the
    // user believing a delivered message went unanswered.
    const detail = typeof payload?.error === "string" ? payload.error.slice(0, 1_000) : "";
    throw new ChatTransportError({
      source: res.status === 502 ? "gateway" : "web",
      kind: res.status === 413 ? "limit" : res.status >= 500 ? "runtime" : "invalid_request",
      code: `conversation_message_${res.status}`,
      text: detail || `The conversation refused the message (${res.status}).`,
      retryable: res.status === 502 || res.status === 503 || res.status === 504,
      httpStatus: res.status,
    });
  }
  return {
    seq: typeof payload?.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : null,
    recordedBy: typeof payload?.recordedBy === "string" ? payload.recordedBy : null,
  };
}

/**
 * Re-point one transport's `sendMessage` at the conversation door.
 *
 * The returned receipt is TERMINAL (`settled`) on purpose. It reports the
 * admission, which is the whole of what this door promises: the record is in
 * the ledger and the conversation owns the work from here. There is no
 * per-message generation to follow - a responder stretch is a conversation
 * fact, streamed as `stretch`/`ledger` rows in the body - so a receipt left
 * `running` would be a spinner nothing could ever settle.
 *
 * KNOWN GAP, deliberately not papered over: the door's allowed-fields gate
 * carries no `context`, `routing` or `autonomous`, so a host-supplied Discuss
 * context and the Turn Rail's per-turn pins do not reach the responder. The
 * rail still renders and still persists the thread's sticky pins; they simply
 * do not ride this request.
 */
export function createConversationTransport(
  inner: ChatTransport,
  { conversationId, base = CONVERSATION_BASE }: { conversationId: string; base?: string },
): ChatTransport {
  return {
    ...inner,
    // Kept ON: the composer's optimistic receipt is what puts the just-typed
    // message on screen before the stream echoes it back.
    inputLifecycle: true,
    connect: inner.connect.bind(inner),
    async sendMessage(text, meta): Promise<ChatInputReceipt> {
      const clientRequestId = typeof meta?.clientRequestId === "string" && meta.clientRequestId.trim()
        ? meta.clientRequestId.trim()
        : `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const { seq } = await postConversationMessage(conversationId, text, { base, clientRequestId });
      return {
        clientRequestId,
        // A CLIENT coordinate, never dressed up as a ledger one: the router
        // answers with a `seq` only when it wrote the record itself, and on the
        // live path the gateway did.
        inputId: seq === null ? `conv:${clientRequestId}` : `conv:${conversationId}#${seq}`,
        state: "settled",
        acceptedAt: new Date().toISOString(),
      };
    },
  };
}
